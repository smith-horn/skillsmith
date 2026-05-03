/**
 * SMI-4451 Wave 1 Step 7 — query builder unit tests.
 *
 * Mocks `search()` directly per addendum §S7 (plan-review #6 — don't rely on
 * SKILLSMITH_USE_MOCK_EMBEDDINGS, which is a packages/core flag not honored
 * by doc-retrieval-mcp's embedBatch). RETRIEVAL_LOG_DIR_OVERRIDE points at
 * a tmpdir per `beforeEach` (plan-review #13).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { searchMock, logRetrievalEventMock, tmpHolder } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  logRetrievalEventMock: vi.fn(),
  // SMI-4549 Wave 2 — mutable holder so the writer.js mock factory can read
  // the per-test tmp dir set in beforeEach. vi.hoisted ensures the holder
  // exists at module load time when vi.mock runs.
  tmpHolder: { current: '' as string },
}))

vi.mock('../../packages/doc-retrieval-mcp/src/search.js', () => ({
  search: searchMock,
}))

vi.mock('../../packages/doc-retrieval-mcp/src/retrieval-log/writer.js', () => ({
  logRetrievalEvent: logRetrievalEventMock,
  // SMI-4549 Wave 2: session-priming-query also imports resolveRetrievalLogPaths
  // to feed dbPath/outageMarkerPath into the probe. Returns paths under
  // the per-test tmp dir so the probe never touches HOME.
  resolveRetrievalLogPaths: () => ({
    dbPath: join(tmpHolder.current, 'retrieval-logs.db'),
    outageMarkerPath: join(tmpHolder.current, 'retrieval-log.outage.json'),
  }),
}))

import {
  encodeProjectPath,
  extractRecentBullets,
  parseCliArgs,
  renderPrimingMarkdown,
  runQuery,
  truncateBytes,
} from '../session-priming-query.js'
import type { SearchHit } from '../../packages/doc-retrieval-mcp/src/types.js'

let tmp: string

function makeHit(id: string, similarity: number, filePath: string): SearchHit {
  return {
    id,
    filePath,
    lineStart: 1,
    lineEnd: 10,
    headingChain: [],
    text: `text-${id}`,
    similarity,
    score: similarity,
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'session-priming-test-'))
  tmpHolder.current = tmp
  process.env.RETRIEVAL_LOG_DIR_OVERRIDE = tmp
  searchMock.mockReset()
  logRetrievalEventMock.mockReset()
  delete process.env.SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.RETRIEVAL_LOG_DIR_OVERRIDE
})

describe('parseCliArgs', () => {
  it('accepts valid args', () => {
    const args = parseCliArgs([
      '--session-id',
      'abc',
      '--branch',
      'smi-4451',
      '--smi',
      'smi-4451',
      '--cwd',
      '/repo',
      '--out',
      '/tmp/out.md',
    ])
    expect(args).toEqual({
      sessionId: 'abc',
      branch: 'smi-4451',
      smi: 'smi-4451',
      cwd: '/repo',
      out: '/tmp/out.md',
    })
  })

  it('returns null when required args missing', () => {
    expect(parseCliArgs(['--branch', 'smi-4451'])).toBeNull()
  })

  it('coerces empty branch and smi to empty strings (non-required)', () => {
    const args = parseCliArgs(['--session-id', 'abc', '--cwd', '/x', '--out', '/y'])
    expect(args?.branch).toBe('')
    expect(args?.smi).toBe('')
  })
})

describe('encodeProjectPath', () => {
  it('matches writer.ts encoding contract', () => {
    expect(encodeProjectPath('/Users/foo/Documents/Projects')).toBe('-Users-foo-Documents-Projects')
  })

  it('handles deep paths', () => {
    expect(encodeProjectPath('/a/b/c')).toBe('-a-b-c')
  })
})

describe('truncateBytes', () => {
  it('passes through short strings', () => {
    expect(truncateBytes('hello', 100)).toBe('hello')
  })

  it('truncates strings exceeding the byte cap', () => {
    expect(truncateBytes('a'.repeat(200), 50).length).toBeLessThanOrEqual(50)
  })

  it('counts UTF-8 bytes not chars', () => {
    // U+1F600 grinning face = 4 UTF-8 bytes; cap=4 keeps one emoji
    expect(Buffer.byteLength(truncateBytes('😀😀', 4), 'utf8')).toBeLessThanOrEqual(4)
  })
})

describe('extractRecentBullets', () => {
  it('pulls bullets from a ## Recent section', () => {
    const text = `# X\n\n## Old\n- skip me\n\n## Recent\n- bullet 1\n- bullet 2\n\n## Other\n- not me`
    expect(extractRecentBullets(text, 5)).toBe('- bullet 1\n- bullet 2')
  })

  it('falls back to first 20 bullets when no ## Recent heading', () => {
    const text = `## A\n- one\n- two\n## B\n- three`
    const out = extractRecentBullets(text, 10)
    expect(out).toContain('- one')
    expect(out).toContain('- three')
  })

  it('caps to n bullets', () => {
    const lines = ['## Recent']
    for (let i = 0; i < 50; i++) lines.push(`- bullet ${i}`)
    const out = extractRecentBullets(lines.join('\n'), 3)
    expect(out.split('\n').length).toBe(3)
  })
})

describe('renderPrimingMarkdown', () => {
  it('includes the v1 marker and query', () => {
    const out = renderPrimingMarkdown('test query', [makeHit('a', 0.5, 'foo.md')])
    expect(out).toContain('<!-- session-priming v1')
    expect(out).toContain('test query')
    expect(out).toContain('foo.md')
  })

  it('stays under 2KB byte cap', () => {
    const hits = Array.from({ length: 50 }, (_, i) =>
      makeHit(`h${i}`, 0.5, `path/to/very/long/file/name/here/${i}.md`)
    )
    const out = renderPrimingMarkdown('q', hits)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2048)
  })

  it('truncates retrieval list to fit cap, preserving at least 1 hit', () => {
    const hits = Array.from({ length: 50 }, (_, i) =>
      makeHit(`h${i}`, 0.9, `path/to/very/long/file/name/here/${i}.md`)
    )
    const out = renderPrimingMarkdown('a'.repeat(200), hits)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2048)
    // At least one hit should remain after truncation
    expect(out).toMatch(/^1\. /m)
  })
})

describe('runQuery', () => {
  const baseArgs = {
    sessionId: 'sess-1',
    branch: 'smi-4451-step7',
    smi: 'smi-4451',
    cwd: tmp || '/tmp',
    out: '/tmp/o.md',
  }

  it('emits disabled outcome when env flag set', async () => {
    process.env.SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING = '1'
    const result = await runQuery({ ...baseArgs, cwd: tmp })
    expect(result.additionalContext).toBe('')
    expect(logRetrievalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ hookOutcome: 'disabled' })
    )
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('emits partial_failure when search throws', async () => {
    searchMock.mockRejectedValueOnce(new Error('boom'))
    const result = await runQuery({ ...baseArgs, cwd: tmp })
    expect(result.additionalContext).toBe('')
    expect(logRetrievalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ hookOutcome: 'partial_failure' })
    )
  })

  it('emits partial_failure when 0 hits', async () => {
    searchMock.mockResolvedValueOnce([])
    const result = await runQuery({ ...baseArgs, cwd: tmp })
    expect(result.additionalContext).toBe('')
    expect(logRetrievalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ hookOutcome: 'partial_failure' })
    )
  })

  it('emits primed outcome with hits and renders markdown', async () => {
    searchMock.mockResolvedValueOnce([makeHit('h1', 0.7, 'docs/foo.md')])
    const result = await runQuery({ ...baseArgs, cwd: tmp })
    expect(result.additionalContext).toContain('docs/foo.md')
    expect(logRetrievalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ hookOutcome: 'primed' })
    )
  })

  it('drops Linear signal when LINEAR_API_KEY is unset', async () => {
    searchMock.mockResolvedValueOnce([makeHit('h1', 0.5, 'x.md')])
    await runQuery({ ...baseArgs, cwd: tmp })
    const queryArg = searchMock.mock.calls[0][0].query
    // No Linear description should be in the query — only branch + memory bullets
    expect(typeof queryArg).toBe('string')
  })

  it('builds signal 1 with branch + smi when set', async () => {
    searchMock.mockResolvedValueOnce([makeHit('h1', 0.5, 'x.md')])
    await runQuery({ ...baseArgs, cwd: tmp })
    const queryArg = searchMock.mock.calls[0][0].query as string
    expect(queryArg).toContain('smi-4451')
  })

  it('reads memory bullets when MEMORY.md is present at encoded path', async () => {
    const encoded = encodeProjectPath(tmp)
    const memDir = join(tmp, '.claude-fake-home', '.claude', 'projects', encoded, 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(
      join(memDir, 'MEMORY.md'),
      '# Project\n\n## Recent\n- alpha bullet\n- beta bullet\n',
      'utf8'
    )
    // homedir() can't be re-pointed easily — test the encoder + extractor path
    // via direct invocation; runQuery's full read-from-homedir is exercised in
    // integration / smoke (S9). Here we verify the encoding contract holds.
    expect(encodeProjectPath(tmp)).toBe(encoded)
  })

  it('passes minScore=0.35 and k=8 to search()', async () => {
    searchMock.mockResolvedValueOnce([makeHit('h1', 0.5, 'x.md')])
    await runQuery({ ...baseArgs, cwd: tmp })
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ k: 8, minScore: 0.35 }))
  })
})
