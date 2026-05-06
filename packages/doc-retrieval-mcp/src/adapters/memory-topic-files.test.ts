import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { createMemoryTopicFilesAdapter, resolveMemoryDir } from './memory-topic-files.js'
import type { AdapterContext } from '../types.js'
import type { CorpusConfig } from '../config.js'

/**
 * Memory-topic-files tests use a scratch tmp directory so `resolveMemoryDir`
 * lands in a disposable location. Each case rebuilds the mirror of the
 * `~/.claude/projects/<cwd-encoded>/memory/` tree on disk and exercises
 * one adapter entrypoint (listFiles / chunk).
 *
 * SMI-4711: `homedir()` from `node:os` reads the OS passwd record and does
 * NOT respect `process.env.HOME` mutations — so the naive `process.env.HOME =
 * scratch` approach silently breaks under vitest `--pool=threads`, where
 * parallel test files share the same Node process and `homedir()` always
 * returns the real system home. The fix is a `vi.mock` factory that replaces
 * `homedir` with a `vi.fn()` whose return value is set per-test in
 * `beforeEach`, giving each test a fully isolated scratch root.
 */

// SMI-4711: replace os.homedir with a controllable stub so resolveMemoryDir
// receives the per-test scratch directory instead of the real system home.
// Node's homedir() reads the OS passwd record and ignores process.env.HOME —
// under --pool=threads parallel test files share a process so it always
// returns the real home. vi.mock is hoisted before any module import, which
// makes the stub visible to memory-topic-files.ts at the time it binds
// its `homedir` local from 'node:os'.
//
// vi.hoisted() is also hoisted (runs before vi.mock factories) so the
// `homedirMock` reference is alive when the factory closure captures it.
const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn(() => ''),
}))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  // Default: delegate to the real homedir so module-level calls (e.g.
  // userInfo() used by USER constant) are safe before beforeEach fires.
  homedirMock.mockImplementation(actual.homedir)
  return { ...actual, homedir: homedirMock }
})

const USER = userInfo().username
const FAKE_CWD = '/fake/project/root'
const ENCODED = '-fake-project-root'

let scratch: string
let origMemoryOverride: string | undefined
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
  // SMI-4711: point homedir() at the per-test scratch dir so resolveMemoryDir
  // derives its path from a disposable location, not the real system home.
  vi.mocked(homedirMock).mockReturnValue(scratch)
  // SMI-4687: clear SKILLSMITH_MEMORY_DIR_OVERRIDE so the cwd-derivation tests
  // see a clean env. Host shells sourcing .env may export it for the docker
  // bind-mount; without this isolation those exports leak into the cases that
  // exercise the fall-through path and skew assertions.
  origMemoryOverride = process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE
  delete process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE
  memoryDir = join(scratch, '.claude', 'projects', ENCODED, 'memory')
  mkdirSync(memoryDir, { recursive: true })
})

afterEach(() => {
  vi.mocked(homedirMock).mockReset()
  if (origMemoryOverride === undefined) delete process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE
  else process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE = origMemoryOverride
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

describe('resolveMemoryDir — SKILLSMITH_MEMORY_DIR_OVERRIDE (SMI-4677)', () => {
  let origOverride: string | undefined

  beforeEach(() => {
    origOverride = process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE
  })

  afterEach(() => {
    if (origOverride === undefined) delete process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE
    else process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE = origOverride
  })

  it('returns the override path verbatim when set, regardless of cwd', () => {
    process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE = '/skillsmith-memory'
    expect(resolveMemoryDir('/some/other/cwd')).toBe('/skillsmith-memory')
    expect(resolveMemoryDir(FAKE_CWD)).toBe('/skillsmith-memory')
  })

  it('does NOT apply the cwd encoding to the override path', () => {
    // The override is a literal mount path inside the container, not a host
    // project root, so encoding rules do not apply.
    process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE = '/literal/has/slashes/and/dashes'
    expect(resolveMemoryDir('/anything')).toBe('/literal/has/slashes/and/dashes')
  })

  it('falls through to derivation when override is empty string', () => {
    // Plan-review E3: explicit length > 0 check, not truthiness. An
    // empty-string override (e.g., an unintentional `export VAR=`) must not
    // null-route the adapter — derivation path takes over.
    process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE = ''
    expect(resolveMemoryDir(FAKE_CWD)).toBe(memoryDir)
  })

  it('falls through to derivation when override is unset', () => {
    delete process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE
    expect(resolveMemoryDir(FAKE_CWD)).toBe(memoryDir)
  })

  it('still returns null on bad cwd even when override is unset', () => {
    delete process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE
    expect(resolveMemoryDir('')).toBe(null)
    expect(resolveMemoryDir('relative')).toBe(null)
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

describe('memory-topic-files — wholeFileChunk self-sufficiency (SMI-4450 M3)', () => {
  it('whole-file chunk has kind/lifetime set at construction, not via mapper', async () => {
    // Small enough to hit the wholeFileChunk path (not split-by-heading).
    writeFileSync(
      join(memoryDir, 'feedback_small.md'),
      '# Small\n\none two three four five six seven eight.\n'.repeat(2)
    )
    const adapter = createMemoryTopicFilesAdapter()
    const ctx = makeCtx('full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks[0].kind).toBe('memory')
    expect(chunks[0].lifetime).toBe('short-term')
  })

  it('split chunks (chunkBlocks path) also get kind/lifetime', async () => {
    const bigSection = 'word '.repeat(300) + '\n'
    const content = `# Top\n\n${bigSection}\n## Sub A\n\n${bigSection}\n## Sub B\n\n${bigSection}`
    writeFileSync(join(memoryDir, 'feedback_big.md'), content)
    const adapter = createMemoryTopicFilesAdapter()
    const ctx = makeCtx('full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.kind).toBe('memory')
      expect(c.lifetime).toBe('short-term')
    }
  })
})

describe('memory-topic-files — class stamping (SMI-4485)', () => {
  it('stamps class:["feedback"] for feedback_*.md files', async () => {
    writeFileSync(
      join(memoryDir, 'feedback_audit.md'),
      '# Feedback\n\nSome lesson body that fits under targetTokens.\n'
    )
    const adapter = createMemoryTopicFilesAdapter()
    const ctx = makeCtx('full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    for (const c of chunks) {
      expect(c.class).toEqual(['feedback'])
    }
  })

  it('stamps class:["project"] for project_*.md files', async () => {
    writeFileSync(
      join(memoryDir, 'project_smi_4485.md'),
      '# Project\n\nSome project context body that fits under targetTokens.\n'
    )
    const adapter = createMemoryTopicFilesAdapter()
    const ctx = makeCtx('full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    for (const c of chunks) {
      expect(c.class).toEqual(['project'])
    }
  })

  it('leaves class undefined for memory files without feedback_/project_ prefix', async () => {
    writeFileSync(
      join(memoryDir, 'template_author_outreach.md'),
      '# Template\n\nNot a feedback or project file.\n'
    )
    const adapter = createMemoryTopicFilesAdapter()
    const ctx = makeCtx('full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    for (const c of chunks) {
      expect(c.class).toBeUndefined()
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
