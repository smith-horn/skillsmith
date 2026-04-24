import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { createMemoryTopicFilesAdapter, resolveMemoryDir } from './memory-topic-files.js'
import type { AdapterContext } from '../types.js'
import type { CorpusConfig } from '../config.js'

/**
 * Memory-topic-files tests use a scratch `$HOME` so `resolveMemoryDir`
 * lands in a disposable directory. Each case rebuilds the mirror of the
 * `~/.claude/projects/<cwd-encoded>/memory/` tree on disk and exercises
 * one adapter entrypoint (listFiles / chunk).
 */

const USER = userInfo().username
const FAKE_CWD = '/fake/project/root'
const ENCODED = '-fake-project-root'

let scratch: string
let origHome: string | undefined
let memoryDir: string

function makeCtx(mode: 'full' | 'incremental', lastRunAt: string | null = null): AdapterContext {
  const cfg: CorpusConfig = {
    storagePath: '.ruvector/store',
    metadataPath: '.ruvector/metadata.json',
    stateFile: '.ruvector/state.json',
    embeddingDim: 384,
    chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 32 },
    globs: ['**/*.md'],
  }
  return {
    repoRoot: FAKE_CWD,
    cfg,
    mode,
    lastSha: null,
    lastRunAt,
  }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'memory-adapter-'))
  origHome = process.env.HOME
  process.env.HOME = scratch
  memoryDir = join(scratch, '.claude', 'projects', ENCODED, 'memory')
  mkdirSync(memoryDir, { recursive: true })
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  rmSync(scratch, { recursive: true, force: true })
})

describe('resolveMemoryDir', () => {
  it('encodes the cwd by swapping slashes for dashes and prepending a leading dash', () => {
    const dir = resolveMemoryDir('/Users/williamsmith/code')
    expect(dir?.endsWith(`.claude/projects/-Users-williamsmith-code/memory`)).toBe(true)
  })

  it('returns null for empty or non-absolute cwd', () => {
    expect(resolveMemoryDir('')).toBe(null)
    expect(resolveMemoryDir('relative/path')).toBe(null)
  })

  it('roundtrips against a known on-disk directory (SPARC §S2a L2 drift guard)', () => {
    const dir = resolveMemoryDir(FAKE_CWD)
    expect(dir).toBe(memoryDir)
  })
})

describe('memory-topic-files adapter — listFiles', () => {
  it('returns [] when the derived memory directory does not exist', async () => {
    rmSync(memoryDir, { recursive: true })
    const adapter = createMemoryTopicFilesAdapter()
    const files = await adapter.listFiles(makeCtx('full'))
    expect(files).toEqual([])
  })

  it('indexes *.md files using memory://<user>/<basename> virtual keys', async () => {
    writeFileSync(
      join(memoryDir, 'feedback_audit_logs_no_user_id_column.md'),
      '# Audit logs\n\nThe `audit_logs` table has no `user_id` column; store via `metadata->>user_id`.\n'
    )
    const adapter = createMemoryTopicFilesAdapter()
    const files = await adapter.listFiles(makeCtx('full'))
    expect(files.length).toBe(1)
    expect(files[0].logicalPath).toBe(`memory://${USER}/feedback_audit_logs_no_user_id_column.md`)
    expect(files[0].absolutePath).toBe(join(memoryDir, 'feedback_audit_logs_no_user_id_column.md'))
    expect(files[0].rawContent).toContain('audit_logs')
  })

  it('skips MEMORY.md, *.backup-*.md, and files under 32 bytes', async () => {
    writeFileSync(join(memoryDir, 'MEMORY.md'), '# index\n')
    writeFileSync(
      join(memoryDir, 'feedback_x.backup-2026-01-01.md'),
      '# backup\nbody body body body\n'
    )
    writeFileSync(join(memoryDir, 'stub.md'), 'tiny')
    writeFileSync(
      join(memoryDir, 'feedback_real.md'),
      '# real\n\nThis file has enough content to be indexable.\n'
    )

    const adapter = createMemoryTopicFilesAdapter()
    const files = await adapter.listFiles(makeCtx('full'))
    expect(files.map((f) => f.logicalPath)).toEqual([`memory://${USER}/feedback_real.md`])
  })

  it('incremental mode filters by mtime > lastRunAt', async () => {
    const oldPath = join(memoryDir, 'feedback_old.md')
    const newPath = join(memoryDir, 'feedback_new.md')
    writeFileSync(oldPath, '# old\n\nbody body body body body body body body\n')
    writeFileSync(newPath, '# new\n\nbody body body body body body body body\n')

    // Set old file's mtime to 10 minutes ago.
    const oldTime = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(oldPath, oldTime, oldTime)

    const lastRunAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const adapter = createMemoryTopicFilesAdapter()
    const files = await adapter.listFiles(makeCtx('incremental', lastRunAt))
    expect(files.map((f) => f.logicalPath)).toEqual([`memory://${USER}/feedback_new.md`])
  })

  it('parses SMI tag from file content into adapter tags', async () => {
    writeFileSync(
      join(memoryDir, 'project_smi_4399_free_tier_auth.md'),
      '# Free tier\n\nTracked under SMI-4399 — shipped 2026-04-24.\n'
    )
    const adapter = createMemoryTopicFilesAdapter()
    const files = await adapter.listFiles(makeCtx('full'))
    expect(files[0].tags?.smi).toBe('SMI-4399')
    expect(files[0].tags?.source).toBe('memory-topic-files')
    expect(files[0].tags?.user).toBe(USER)
  })
})

describe('memory-topic-files adapter — chunk', () => {
  it('produces a single whole-file chunk when content is under targetTokens', async () => {
    const content = '# Small\n\n' + 'one two three four five six seven eight.\n'.repeat(3)
    writeFileSync(join(memoryDir, 'feedback_small.md'), content)
    const adapter = createMemoryTopicFilesAdapter()
    const ctx = makeCtx('full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks.length).toBe(1)
    expect(chunks[0].kind).toBe('memory')
    expect(chunks[0].lifetime).toBe('short-term')
    expect(chunks[0].filePath).toBe(`memory://${USER}/feedback_small.md`)
    expect(chunks[0].headingChain).toEqual([`memory://${USER}/feedback_small.md`.split('/').pop()])
    expect(chunks[0].tags?.source).toBe('memory-topic-files')
  })

  it('splits by headings when content exceeds targetTokens, prefixing headingChain with basename', async () => {
    const bigSection = 'word '.repeat(300) + '\n'
    const content = `# Top\n\n${bigSection}\n## Sub A\n\n${bigSection}\n## Sub B\n\n${bigSection}`
    writeFileSync(join(memoryDir, 'feedback_big.md'), content)
    const adapter = createMemoryTopicFilesAdapter()
    const ctx = makeCtx('full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.headingChain[0]).toBe('feedback_big.md')
      expect(c.kind).toBe('memory')
    }
  })
})

describe('memory-topic-files adapter — listDeletedPaths', () => {
  it('returns [] (no delete oracle in Wave 1 per SPARC §S2a edge case c)', async () => {
    const adapter = createMemoryTopicFilesAdapter()
    const deleted = await adapter.listDeletedPaths(makeCtx('incremental'))
    expect(deleted).toEqual([])
  })
})
