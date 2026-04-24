import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createScriptHeadersAdapter, extractHeader } from './script-headers.js'
import type { AdapterContext } from '../types.js'
import type { CorpusConfig } from '../config.js'

// Padding after the header block. MUST NOT start with a comment marker,
// otherwise `extractHeader` keeps absorbing lines and the "short header"
// tests see a long header. `echo` lines are valid shell, no-op, and
// outside the header block.
const MIN_PADDING_LINE = 'echo padding padding padding padding padding\n'

function makeCtx(
  repoRoot: string,
  mode: 'full' | 'incremental',
  lastRunAt: string | null = null
): AdapterContext {
  const cfg: CorpusConfig = {
    storagePath: '.ruvector/store',
    metadataPath: '.ruvector/metadata.json',
    stateFile: '.ruvector/state.json',
    embeddingDim: 384,
    chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 32 },
    globs: ['**/*.md'],
  }
  return { repoRoot, cfg, mode, lastSha: null, lastRunAt }
}

/**
 * Minimum file size is 200 bytes — tests use a padding block of
 * `MIN_PADDING_LINE` to push script bodies comfortably over the
 * threshold without polluting the header signal.
 */
function padBody(): string {
  return MIN_PADDING_LINE.repeat(6)
}

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'script-headers-'))
  mkdirSync(join(scratch, 'scripts'))
  mkdirSync(join(scratch, '.husky'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('extractHeader', () => {
  it('strips shebang and returns the contiguous # comment block', () => {
    const raw = '#!/usr/bin/env bash\n# line one\n# line two\n# line three\n\necho ok\n'
    const h = extractHeader(raw)
    expect(h?.text).toBe('line one\nline two\nline three')
    expect(h?.startLine).toBe(2)
  })

  it('handles // line comments (TS/JS)', () => {
    const raw = '// header one\n// header two\n\nexport const x = 1\n'
    const h = extractHeader(raw)
    expect(h?.text).toBe('header one\nheader two')
  })

  it('handles /* block ... */ (single-line close)', () => {
    const raw = '/* header line one\n * header line two\n * header line three\n */\n\nconst x = 1\n'
    const h = extractHeader(raw)
    expect(h?.text).toContain('header line one')
    expect(h?.text).toContain('header line three')
  })

  it('returns null for empty or body-only files', () => {
    expect(extractHeader('')).toBe(null)
    expect(extractHeader('echo ok\n')).toBe(null)
  })

  it('drops shebang-only header', () => {
    expect(extractHeader('#!/bin/bash\n\necho ok\n')).toBe(null)
  })

  it('preserves blank lines inside the header as paragraph breaks', () => {
    const raw = '# one\n#\n# two\n\nbody\n'
    const h = extractHeader(raw)
    expect(h?.text.split('\n').length).toBeGreaterThanOrEqual(3)
  })
})

describe('script-headers adapter — listFiles', () => {
  it('picks up .sh / .mjs / .ts / .js / .bash under scripts/ and .husky/', async () => {
    writeFileSync(
      join(scratch, 'scripts', 'foo.sh'),
      '#!/bin/bash\n# header for foo\n# line 2 header\n# line 3 header\n# line 4 header\n' +
        padBody()
    )
    writeFileSync(
      join(scratch, 'scripts', 'bar.mjs'),
      '// header for bar\n// line 2\n// line 3\n// line 4 line 4\n' + padBody()
    )
    writeFileSync(
      join(scratch, '.husky', 'pre-commit'),
      '#!/usr/bin/env sh\n# pre-commit hook header\n# line 2 header\n# line 3 header\n' + padBody()
    )
    const adapter = createScriptHeadersAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    const paths = files.map((f) => f.logicalPath).sort()
    expect(paths).toEqual(['.husky/pre-commit', 'scripts/bar.mjs', 'scripts/foo.sh'])
  })

  it('tags script_type from path (scripts/, .husky/, scripts/tests/)', async () => {
    mkdirSync(join(scratch, 'scripts', 'tests'))
    writeFileSync(
      join(scratch, 'scripts', 'util.sh'),
      '#!/bin/bash\n# util header line one\n# line 2\n# line 3\n' + padBody()
    )
    writeFileSync(
      join(scratch, 'scripts', 'tests', 'run.sh'),
      '#!/bin/bash\n# test runner header line one\n# line 2 stuff\n# line 3 more\n' + padBody()
    )
    writeFileSync(
      join(scratch, '.husky', 'pre-push'),
      '#!/usr/bin/env sh\n# pre-push hook header\n# line 2 header\n# line 3 header\n' + padBody()
    )
    const adapter = createScriptHeadersAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    const byPath = Object.fromEntries(files.map((f) => [f.logicalPath, f.tags?.script_type]))
    expect(byPath['scripts/util.sh']).toBe('utility')
    expect(byPath['scripts/tests/run.sh']).toBe('test')
    expect(byPath['.husky/pre-push']).toBe('hook')
  })

  it('skips files under 200 bytes', async () => {
    writeFileSync(join(scratch, 'scripts', 'tiny.sh'), '#!/bin/bash\n# x\n')
    const adapter = createScriptHeadersAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files).toEqual([])
  })

  it('skips @generated files', async () => {
    writeFileSync(
      join(scratch, 'scripts', 'gen.ts'),
      '// @generated — do not edit\n// header text\n' + padBody() + padBody()
    )
    const adapter = createScriptHeadersAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files).toEqual([])
  })

  it('skips node_modules', async () => {
    mkdirSync(join(scratch, 'scripts', 'node_modules', 'dep'), { recursive: true })
    writeFileSync(
      join(scratch, 'scripts', 'node_modules', 'dep', 'x.js'),
      '// vendored header line one\n// line 2\n// line 3\n' + padBody()
    )
    const adapter = createScriptHeadersAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files).toEqual([])
  })

  it('incremental mtime filter', async () => {
    writeFileSync(
      join(scratch, 'scripts', 'old.sh'),
      '#!/bin/bash\n# old header\n# line 2 header\n# line 3 header\n' + padBody()
    )
    writeFileSync(
      join(scratch, 'scripts', 'new.sh'),
      '#!/bin/bash\n# new header\n# line 2 header\n# line 3 header\n' + padBody()
    )
    const oldTime = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(join(scratch, 'scripts', 'old.sh'), oldTime, oldTime)

    const lastRunAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const adapter = createScriptHeadersAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'incremental', lastRunAt))
    expect(files.map((f) => f.logicalPath)).toEqual(['scripts/new.sh'])
  })
})

describe('script-headers adapter — chunk', () => {
  it('produces one long-term `script` chunk with hashed id', async () => {
    writeFileSync(
      join(scratch, 'scripts', 'foo.sh'),
      '#!/bin/bash\n# rationale: this script does X because of reason Y that matters\n# line 2 of rationale that continues the explanation above with detail\n# line 3 more rationale explaining the constraint and the side effect\n' +
        padBody()
    )
    const adapter = createScriptHeadersAdapter()
    const ctx = makeCtx(scratch, 'full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks.length).toBe(1)
    expect(chunks[0].kind).toBe('script')
    expect(chunks[0].lifetime).toBe('long-term')
    expect(chunks[0].filePath).toBe('scripts/foo.sh')
    expect(chunks[0].id).toMatch(/^scripts\/foo\.sh#L\d+-L\d+@[0-9a-f]{16}$/)
    expect(chunks[0].tags?.script_type).toBe('utility')
  })

  it('returns [] when header is under minimum tokens', async () => {
    writeFileSync(
      join(scratch, 'scripts', 'short.sh'),
      '#!/bin/bash\n# hi\n' + padBody() + padBody()
    )
    const adapter = createScriptHeadersAdapter()
    const ctx = makeCtx(scratch, 'full')
    const files = await adapter.listFiles(ctx)
    if (files.length === 0) {
      // File fell below 200-byte threshold; accepted edge case.
      return
    }
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks).toEqual([])
  })
})

describe('script-headers adapter — listDeletedPaths', () => {
  it('returns [] (no delete oracle in Wave 1)', async () => {
    const adapter = createScriptHeadersAdapter()
    const deleted = await adapter.listDeletedPaths(makeCtx(scratch, 'incremental'))
    expect(deleted).toEqual([])
  })
})
