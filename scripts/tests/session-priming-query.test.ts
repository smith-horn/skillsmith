/**
 * SMI-4451 Wave 1 Step 7 — query builder unit tests.
 *
 * Mocks `search()` directly per addendum §S7 (plan-review #6 — don't rely on
 * SKILLSMITH_USE_MOCK_EMBEDDINGS, which is a packages/core flag not honored
 * by doc-retrieval-mcp's embedBatch). RETRIEVAL_LOG_DIR_OVERRIDE points at
 * a tmpdir per `beforeEach` (plan-review #13).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
  countRecentJsonlSessions,
  extractRecentBullets,
  parseCliArgs,
  renderPrimingMarkdown,
  runQuery,
  truncateBytes,
} from '../session-priming-query.js'
import {
  encodeProjectSegment,
  resetProjectDirCache,
} from '../../packages/doc-retrieval-mcp/src/retrieval-log/project-dir.js'
import {
  resolveMainRepoKey,
  writeEntry as writeReindexEntry,
  type ReindexEntry,
} from '../../packages/doc-retrieval-mcp/src/retrieval-log/reindex-state.js'
import type { SearchHit } from '../../packages/doc-retrieval-mcp/src/types.js'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

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
  // SMI-5419: buildSignal3/countRecentJsonlSessions now resolve via the
  // module-memoized shared/per-cwd resolvers — reset so cases don't leak.
  resetProjectDirCache()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.RETRIEVAL_LOG_DIR_OVERRIDE
  vi.unstubAllEnvs()
  resetProjectDirCache()
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

  it('reads memory bullets from the shared main-repo dir (SMI-5419)', async () => {
    // cwd is a git repo so findMainRepoRoot resolves it as the main root, and
    // HOME points at a fake home so resolveSharedProjectDir's ~/.claude/projects/
    // lookup is fully controlled. Exercises the real read path that was
    // previously asserted only at the encoder level.
    const repo = mkdtempSync(join(tmpdir(), 'priming-repo-'))
    mkdirSync(join(repo, '.git'))
    const fakeHome = mkdtempSync(join(tmpdir(), 'priming-home-'))
    vi.stubEnv('HOME', fakeHome)
    resetProjectDirCache()
    const memDir = join(fakeHome, '.claude', 'projects', encodeProjectSegment(repo), 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(
      join(memDir, 'MEMORY.md'),
      '# Project\n\n## Recent\n- alpha bullet\n- beta bullet\n',
      'utf8'
    )
    searchMock.mockResolvedValueOnce([makeHit('h1', 0.7, 'docs/foo.md')])
    try {
      await runQuery({ ...baseArgs, cwd: repo })
      const queryArg = searchMock.mock.calls[0][0].query as string
      expect(queryArg).toContain('alpha bullet')
      expect(queryArg).toContain('beta bullet')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('countRecentJsonlSessions counts *.jsonl under the per-cwd sessions dir (SMI-5419)', () => {
    // Sessions are PER-CWD (resolveClaudeProjectDir), not main-repo. Verify the
    // count reads ~/.claude/projects/<encoded-cwd>/sessions/ under a fake HOME.
    const cwd = mkdtempSync(join(tmpdir(), 'priming-sess-'))
    const fakeHome = mkdtempSync(join(tmpdir(), 'priming-sess-home-'))
    vi.stubEnv('HOME', fakeHome)
    resetProjectDirCache()
    const sessionsDir = join(fakeHome, '.claude', 'projects', encodeProjectSegment(cwd), 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(join(sessionsDir, 'a.jsonl'), '{}', 'utf8')
    writeFileSync(join(sessionsDir, 'b.jsonl'), '{}', 'utf8')
    writeFileSync(join(sessionsDir, 'note.txt'), 'x', 'utf8') // ignored — not .jsonl
    try {
      // Freshly-written files have mtime ~now, so they fall inside the 24h window.
      expect(countRecentJsonlSessions(cwd, new Date(), 24)).toBe(2)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('passes minScore=0.35 and k=8 to search()', async () => {
    searchMock.mockResolvedValueOnce([makeHit('h1', 0.5, 'x.md')])
    await runQuery({ ...baseArgs, cwd: tmp })
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ k: 8, minScore: 0.35 }))
  })
})

describe('runQuery — reindex staleness banner (SMI-5793)', () => {
  const baseArgs = {
    sessionId: 'sess-1',
    branch: 'smi-5793-reindex-observability',
    smi: 'smi-5793',
    cwd: '',
    out: '/tmp/o.md',
  }

  let repoDir: string
  let stateDir: string
  let originalStateOverride: string | undefined
  let originalReindexDisable: string | undefined
  let originalReindexStaleHours: string | undefined

  beforeEach(() => {
    // SMI-4693: every git invocation under test routes through
    // makeFixtureEnv() (strips GIT_DISCOVERY_VARS + pins author/committer)
    // so an inherited env var can never redirect a spawn into this repo's
    // own parent worktree. makeFixtureTempDir realpath-canonicalizes the
    // temp dir (SMI-4692 class) since this fixture hosts a real git repo.
    repoDir = makeFixtureTempDir('priming-reindex-repo')
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', repoDir], {
      env: makeFixtureEnv(),
    })
    stateDir = mkdtempSync(join(tmpdir(), 'priming-reindex-state-'))
    originalStateOverride = process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    originalReindexDisable = process.env.SKILLSMITH_REINDEX_STALENESS_DISABLE
    originalReindexStaleHours = process.env.SKILLSMITH_REINDEX_STALE_HOURS
    process.env.SKILLSMITH_STATE_DIR_OVERRIDE = stateDir
    delete process.env.SKILLSMITH_REINDEX_STALENESS_DISABLE
    delete process.env.SKILLSMITH_REINDEX_STALE_HOURS
    // Isolate the reindex banner from signal-building/search: this suite
    // only cares about contextBanner, which is computed (and returned)
    // BEFORE the disabled short-circuit, same as the probe/liveness banners.
    process.env.SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING = '1'
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
    if (originalStateOverride === undefined) delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    else process.env.SKILLSMITH_STATE_DIR_OVERRIDE = originalStateOverride
    if (originalReindexDisable === undefined) {
      delete process.env.SKILLSMITH_REINDEX_STALENESS_DISABLE
    } else {
      process.env.SKILLSMITH_REINDEX_STALENESS_DISABLE = originalReindexDisable
    }
    if (originalReindexStaleHours === undefined) {
      delete process.env.SKILLSMITH_REINDEX_STALE_HOURS
    } else {
      process.env.SKILLSMITH_REINDEX_STALE_HOURS = originalReindexStaleHours
    }
    delete process.env.SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING
  })

  function seedEntry(overrides: Partial<ReindexEntry> = {}): void {
    const key = resolveMainRepoKey(repoDir)
    if (!key) throw new Error('test setup: resolveMainRepoKey failed for the fixture repo')
    const entry: ReindexEntry = {
      lastRunTs: new Date().toISOString(),
      lastRunSha: 'abc123',
      mode: 'incremental',
      filesScanned: 3,
      chunksUpserted: 3,
      chunksDeleted: 0,
      durationMs: 100,
      success: true,
      consecutiveZeroTouchRuns: 0,
      ...overrides,
    }
    writeReindexEntry(key, entry)
  }

  function commitOne(): void {
    // SMI-4693: routed through makeFixtureEnv() — see the beforeEach comment
    // above. Author/committer identity comes from makeFixtureEnv()'s pinned
    // GIT_AUTHOR_*/GIT_COMMITTER_* env vars, so no explicit -c user.email/
    // user.name flags are needed here.
    const env = makeFixtureEnv()
    writeFileSync(join(repoDir, 'file.txt'), 'x')
    execFileSync('git', ['-C', repoDir, 'add', '.'], { env })
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'x', '--quiet'], { env })
  }

  it('renders nothing when no reindex.state entry exists', async () => {
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toBe('')
  })

  it('renders a failed-run banner', async () => {
    seedEntry({ success: false, errorReason: 'boom', filesScanned: 0, chunksUpserted: 0 })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('[reindex]')
    expect(result.additionalContext).toContain('last run failed: boom')
  })

  it('renders an anomaly banner at the zero-touch threshold', async () => {
    seedEntry({
      filesScanned: 0,
      chunksUpserted: 0,
      chunksDeleted: 0,
      consecutiveZeroTouchRuns: 5,
    })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('5 consecutive commits scanned 0 files')
    expect(result.additionalContext).toContain('SMI-5786')
  })

  it('renders a hung banner when no run in >48h despite HEAD advancing', async () => {
    commitOne()
    seedEntry({
      lastRunTs: new Date(Date.now() - 49 * 3600 * 1000).toISOString(),
      lastRunSha: 'stale-sha-not-matching-head',
    })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('possibly hung or not firing')
  })

  it('honors a custom SKILLSMITH_REINDEX_STALE_HOURS threshold', async () => {
    commitOne()
    process.env.SKILLSMITH_REINDEX_STALE_HOURS = '1'
    seedEntry({
      lastRunTs: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      lastRunSha: 'stale-sha-not-matching-head',
    })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('possibly hung or not firing')
  })

  it('renders nothing when healthy (recent run, no anomaly)', async () => {
    seedEntry()
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toBe('')
  })

  it('SKILLSMITH_REINDEX_STALENESS_DISABLE=1 suppresses the banner even when the last run failed', async () => {
    process.env.SKILLSMITH_REINDEX_STALENESS_DISABLE = '1'
    seedEntry({ success: false, errorReason: 'boom', filesScanned: 0, chunksUpserted: 0 })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).not.toContain('[reindex]')
  })
})
