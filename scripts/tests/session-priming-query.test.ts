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

const { searchMock, logRetrievalEventMock, tmpHolder, bridgeReaderShouldThrow } = vi.hoisted(
  () => ({
    searchMock: vi.fn(),
    logRetrievalEventMock: vi.fn(),
    // SMI-4549 Wave 2 — mutable holder so the writer.js mock factory can read
    // the per-test tmp dir set in beforeEach. vi.hoisted ensures the holder
    // exists at module load time when vi.mock runs.
    tmpHolder: { current: '' as string },
    // SMI-6967 M-4 — mutable switch so a single, dedicated test can force
    // the bridge-verdict reader to throw (session-priming-query.ts's
    // "the bridge-verdict reader failed: …" fault branch), without any
    // other test's behavior changing (default false = transparent passthrough).
    bridgeReaderShouldThrow: { current: false },
  })
)

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

// SMI-6967 M-4 — a transparent passthrough to the real module unless the
// test-only switch above is flipped, in which case ONLY readEntryResult
// throws. This is the only way to drive session-priming-query.ts's
// "the bridge-verdict reader failed" catch branch deterministically: every
// other path to a thrown error here is itself fail-soft further down.
vi.mock(
  '../../packages/doc-retrieval-mcp/src/retrieval-log/ruflo-bridge-state.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../packages/doc-retrieval-mcp/src/retrieval-log/ruflo-bridge-state.js')
      >()
    return {
      ...actual,
      readEntryResult: (...args: Parameters<typeof actual.readEntryResult>) => {
        if (bridgeReaderShouldThrow.current) {
          throw new Error('forced reader failure (SMI-6967 M-4 test)')
        }
        return actual.readEntryResult(...args)
      },
    }
  }
)

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

// SMI-6967 H-1: file-scope isolation for the ruflo-bridge banner, mirroring
// the reindex describe block's own capture/restore pattern (below) rather
// than inventing a second convention. Without this, every pre-existing
// `runQuery` arm in this file ALSO computes a bridge-verdict line — with
// `SKILLSMITH_RUFLO_VERDICT_SHADOW=0` reaching a local session via
// `.claude/settings.json`, and `baseArgs.cwd` being a bare non-git temp dir
// (so `resolveMainRepoKey` returns null), the fault branch renders a
// non-empty `[ruflo-bridge]` line and every `toBe('')` assertion in this
// file goes red locally while staying green in CI (GitHub Actions never
// reads `.claude/settings.json`). Setting `SKILLSMITH_RUFLO_VERDICT_DISABLE`
// skips that whole code path; `SKILLSMITH_STATE_DIR_OVERRIDE` keeps every
// state-consumer (bridge AND reindex) off the real `~/.skillsmith`
// regardless. The dedicated "ruflo-bridge banner" describe block below
// overrides BOTH so it still exercises the real behavior.
let fileScopeBridgeStateDir: string
let fileScopeOriginalStateDirOverride: string | undefined
let fileScopeOriginalBridgeVerdictDisable: string | undefined

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
  bridgeReaderShouldThrow.current = false
  delete process.env.SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING
  delete process.env.LINEAR_API_KEY
  // SMI-5419: buildSignal3/countRecentJsonlSessions now resolve via the
  // module-memoized shared/per-cwd resolvers — reset so cases don't leak.
  resetProjectDirCache()

  // SMI-6967 H-1 file-scope isolation — see the doc comment above.
  fileScopeBridgeStateDir = mkdtempSync(join(tmpdir(), 'session-priming-bridge-state-'))
  fileScopeOriginalStateDirOverride = process.env.SKILLSMITH_STATE_DIR_OVERRIDE
  fileScopeOriginalBridgeVerdictDisable = process.env.SKILLSMITH_RUFLO_VERDICT_DISABLE
  process.env.SKILLSMITH_STATE_DIR_OVERRIDE = fileScopeBridgeStateDir
  process.env.SKILLSMITH_RUFLO_VERDICT_DISABLE = '1'
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.RETRIEVAL_LOG_DIR_OVERRIDE
  vi.unstubAllEnvs()
  resetProjectDirCache()

  // SMI-6967 H-1 file-scope isolation — restore, mirroring the reindex
  // describe block's own capture/restore pattern.
  rmSync(fileScopeBridgeStateDir, { recursive: true, force: true })
  if (fileScopeOriginalStateDirOverride === undefined) {
    delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
  } else {
    process.env.SKILLSMITH_STATE_DIR_OVERRIDE = fileScopeOriginalStateDirOverride
  }
  if (fileScopeOriginalBridgeVerdictDisable === undefined) {
    delete process.env.SKILLSMITH_RUFLO_VERDICT_DISABLE
  } else {
    process.env.SKILLSMITH_RUFLO_VERDICT_DISABLE = fileScopeOriginalBridgeVerdictDisable
  }
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

describe('runQuery — ruflo-bridge banner (SMI-6744 A5.5.2 delta)', () => {
  const baseArgs = {
    sessionId: 'sess-1',
    branch: 'smi-6744-bridge-verdict-consumer',
    smi: 'smi-6744',
    cwd: '',
    out: '/tmp/o.md',
  }

  let repoDir: string
  let stateDir: string
  let originalStateOverride: string | undefined
  let originalBridgeDisable: string | undefined
  let originalBridgeShadow: string | undefined

  // SMI-6967 H-1/PR-gate H-B: the expectedBy gate is anchored to the COMMIT
  // DATE of the revision that last changed `scripts/ruflo-bridge-probe.mjs`
  // (via `git log`), not the working-tree mtime — mtime was the original
  // H-1 anchor but was replaced (see ruflo-bridge-state.expected-by.ts's own
  // doc comment for why: it is renewable by any checkout/rebase/copy that
  // rewrites byte-identical content). `ageMs` backdates the commit's
  // author/committer date via `makeFixtureEnv`'s GIT_AUTHOR_DATE/
  // GIT_COMMITTER_DATE override, so `resolveMainRepoKey(repoDir) ===
  // repoDir` for this fresh `git init` with no linked worktrees resolves a
  // real commit history, not an uncommitted file (which `git log` cannot
  // date at all and the production code correctly reads as `unknown`).
  // Content embeds `ageMs` so two calls in the same test (a `beforeEach`
  // seed followed by a test-local override) always produce a real diff —
  // git refuses an empty commit that touches nothing for this path, so an
  // identical second write would silently fail to move the anchor.
  function seedProbeScript(ageMs: number): void {
    const scriptsDir = join(repoDir, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    const scriptPath = join(scriptsDir, 'ruflo-bridge-probe.mjs')
    writeFileSync(scriptPath, `// fixture probe script (SMI-6967 H-1/H-B) age=${ageMs}\n`)
    const committedAt = new Date(Date.now() - ageMs).toISOString()
    execFileSync('git', ['-C', repoDir, 'add', 'scripts/ruflo-bridge-probe.mjs'], {
      env: makeFixtureEnv(),
    })
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'seed probe script', '--quiet'], {
      env: makeFixtureEnv({ GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt }),
    })
  }

  beforeEach(() => {
    repoDir = makeFixtureTempDir('priming-bridge-repo')
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', repoDir], {
      env: makeFixtureEnv(),
    })
    stateDir = mkdtempSync(join(tmpdir(), 'priming-bridge-state-'))
    originalStateOverride = process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    originalBridgeDisable = process.env.SKILLSMITH_RUFLO_VERDICT_DISABLE
    originalBridgeShadow = process.env.SKILLSMITH_RUFLO_VERDICT_SHADOW
    process.env.SKILLSMITH_STATE_DIR_OVERRIDE = stateDir
    delete process.env.SKILLSMITH_RUFLO_VERDICT_DISABLE
    // Ship-live (D2, owner-decided 2026-10-03): the production default via
    // .claude/settings.json is "0" (live) — match it here so these tests
    // exercise the shipped behavior, with a dedicated shadow test overriding it.
    process.env.SKILLSMITH_RUFLO_VERDICT_SHADOW = '0'
    // Default: the probe script was "installed" 2 days ago — past the 1-day
    // grace window, matching "well after ship" production state (the old
    // default's '2020-01-01' expectedBy override). Individual tests override
    // this with a fresh mtime, or remove the file entirely.
    seedProbeScript(2 * 24 * 3600 * 1000)
    process.env.SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING = '1'
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
    if (originalStateOverride === undefined) delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    else process.env.SKILLSMITH_STATE_DIR_OVERRIDE = originalStateOverride
    if (originalBridgeDisable === undefined) delete process.env.SKILLSMITH_RUFLO_VERDICT_DISABLE
    else process.env.SKILLSMITH_RUFLO_VERDICT_DISABLE = originalBridgeDisable
    if (originalBridgeShadow === undefined) delete process.env.SKILLSMITH_RUFLO_VERDICT_SHADOW
    else process.env.SKILLSMITH_RUFLO_VERDICT_SHADOW = originalBridgeShadow
    delete process.env.SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING
  })

  function seedBridgeEntry(overrides: Record<string, unknown> = {}): void {
    const key = resolveMainRepoKey(repoDir)
    if (!key) throw new Error('test setup: resolveMainRepoKey failed for the fixture repo')
    const entry = {
      evaluatedAt: new Date().toISOString(),
      verdict: 'healthy',
      reason: 'embeddingBackend=onnx',
      observedBackend: 'onnx',
      derivedFromVersion: '3.42.4',
      patternsLearned: 1,
      trajectoriesRecorded: 1,
      consecutiveNoLearning: 0,
      // SMI-6967 H-1: the gate is now `everProducerPresent`, not
      // `everLearned` — defaults model an already-armed, fully-producing
      // entry so existing arms that don't care about either field stay
      // unaffected; a test exercising the pre-producer dormant case must
      // override `everProducerPresent: false` explicitly.
      everProducerPresent: true,
      everLearned: true,
      countersRegressed: false,
      lastObservedPatternsLearned: 1,
      lastObservedTrajectoriesRecorded: 1,
      ...overrides,
    }
    writeFileSync(join(stateDir, 'ruflo-bridge.state'), `${JSON.stringify({ [key]: entry })}\n`)
  }

  it('renders nothing when no ruflo-bridge.state entry exists and the probe was installed recently (within the grace window)', async () => {
    seedProbeScript(5 * 60 * 1000) // 5 minutes old — well inside the 1-day grace
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toBe('')
  })

  it('renders loudly when no entry exists past expectedBy (the writer never fired)', async () => {
    const result = await runQuery({ ...baseArgs, cwd: repoDir }) // default seeding: 2 days old
    expect(result.additionalContext).toContain('[ruflo-bridge]')
    expect(result.additionalContext).toContain('state missing')
  })

  it('SMI-6967 H-1 regression — never renders loudly when the probe script was never installed in this checkout, however long the entry has been missing', async () => {
    rmSync(join(repoDir, 'scripts'), { recursive: true, force: true }) // undo the default seeding
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toBe('')
  })

  it('renders nothing for a fresh healthy entry', async () => {
    seedBridgeEntry({ verdict: 'healthy' })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toBe('')
  })

  it('renders a degraded banner with the remedy', async () => {
    seedBridgeEntry({ verdict: 'degraded', observedBackend: 'mock' })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('[ruflo-bridge]')
    expect(result.additionalContext).toContain('bridge degraded')
    expect(result.additionalContext).toContain('node scripts/ruflo-bridge-probe.mjs')
  })

  it('SKILLSMITH_RUFLO_VERDICT_DISABLE=1 suppresses the banner even when degraded', async () => {
    process.env.SKILLSMITH_RUFLO_VERDICT_DISABLE = '1'
    seedBridgeEntry({ verdict: 'degraded' })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).not.toContain('[ruflo-bridge]')
  })

  it('arm 10 — shadow mode (unset or non-"0") computes the line but renders nothing', async () => {
    delete process.env.SKILLSMITH_RUFLO_VERDICT_SHADOW // unset = shadow, per the repo-wide predicate
    seedBridgeEntry({ verdict: 'degraded' })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).not.toContain('[ruflo-bridge]')
  })

  it('arm 2a — a wrong/constant key resolution would see nothing: the real key must be used', async () => {
    // Seeds under the REAL resolveMainRepoKey(repoDir) key, then verifies the
    // banner renders the DEGRADED content specifically — i.e. runQuery is
    // actually calling resolveMainRepoKey against this fixture's cwd and
    // finding the seeded entry, not merely rendering the generic
    // past-expectedBy "state missing" line a wrong key would also produce (a
    // weaker `toContain('[ruflo-bridge]')` assertion does not distinguish
    // the two — confirmed by mutation during implementation: hardcoding the
    // bridgeKey to a constant in session-priming-query.ts still passed a
    // `[ruflo-bridge]`-only assertion, because the past-expectedBy gate
    // renders a loud "missing" line for ANY unresolved key). A
    // session-priming-query.ts edit that hardcoded a constant key makes
    // THIS assertion fail.
    seedBridgeEntry({ verdict: 'degraded', observedBackend: 'mock' })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('[ruflo-bridge]')
    expect(result.additionalContext).toContain('bridge degraded')
    expect(result.additionalContext).not.toContain('state missing')
  })

  // --- SMI-6967 H-2: the two documented tunables were never actually read
  // from the environment. These drive the ENV VAR specifically (not the
  // renderer's own `staleHours`/`livenessDays` options, which were already
  // covered — and passing — in ruflo-bridge-state.test.ts even with this bug
  // present, which is exactly what let it ship unnoticed).

  it('SMI-6967 H-2 — SKILLSMITH_RUFLO_VERDICT_STALE_HOURS actually moves the rendered threshold', async () => {
    const original = process.env.SKILLSMITH_RUFLO_VERDICT_STALE_HOURS
    try {
      seedBridgeEntry({
        verdict: 'healthy',
        evaluatedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // 2h old
      })
      // Default threshold (48h): a 2h-old healthy entry must NOT be stale yet.
      const before = await runQuery({ ...baseArgs, cwd: repoDir })
      expect(before.additionalContext).not.toContain('verdict stale')

      // The SAME 2h-old entry must render stale once the documented env var
      // is set to 1h — if session-priming-query.ts never reads the var (the
      // bug this test pins), nothing changes and this assertion fails.
      process.env.SKILLSMITH_RUFLO_VERDICT_STALE_HOURS = '1'
      const after = await runQuery({ ...baseArgs, cwd: repoDir })
      expect(after.additionalContext).toContain('verdict stale')
    } finally {
      if (original === undefined) delete process.env.SKILLSMITH_RUFLO_VERDICT_STALE_HOURS
      else process.env.SKILLSMITH_RUFLO_VERDICT_STALE_HOURS = original
    }
  })

  it('SMI-6967 H-2 — SKILLSMITH_RUFLO_LIVENESS_DAYS actually moves the rendered threshold', async () => {
    const original = process.env.SKILLSMITH_RUFLO_LIVENESS_DAYS
    try {
      seedBridgeEntry({ everLearned: true, consecutiveNoLearning: 3 })
      // Default threshold (7): a streak of 3 must NOT fire yet.
      const before = await runQuery({ ...baseArgs, cwd: repoDir })
      expect(before.additionalContext).not.toContain('no learning recorded')

      // The SAME streak of 3 must fire once the documented env var is set to
      // 3 — if session-priming-query.ts never reads the var, nothing changes.
      process.env.SKILLSMITH_RUFLO_LIVENESS_DAYS = '3'
      const after = await runQuery({ ...baseArgs, cwd: repoDir })
      expect(after.additionalContext).toContain('no learning recorded in 3 consecutive probes')
    } finally {
      if (original === undefined) delete process.env.SKILLSMITH_RUFLO_LIVENESS_DAYS
      else process.env.SKILLSMITH_RUFLO_LIVENESS_DAYS = original
    }
  })

  // --- SMI-6967 H-9/H-1: the liveness arm's gate, exercised through the
  // full runQuery stack (unit-level fold/render coverage lives in
  // ruflo-bridge-state.test.ts).

  it('SMI-6967 H-9/H-1 — stays dormant before any PRODUCER has ever been observed, even past the threshold', async () => {
    seedBridgeEntry({
      everProducerPresent: false,
      everLearned: false,
      consecutiveNoLearning: 999,
      lastObservedPatternsLearned: 0,
      lastObservedTrajectoriesRecorded: 0,
    })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).not.toContain('[ruflo-bridge]')
  })

  it('SMI-6967 H-9 — fires once armed and past the threshold (producer present AND has learned before)', async () => {
    seedBridgeEntry({ everProducerPresent: true, everLearned: true, consecutiveNoLearning: 7 })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('no learning recorded in 7 consecutive probes')
  })

  // SMI-6967 H-1 — the finding's own reported bug, driven through the full
  // stack: a connected bridge with real store entries ("32 total entries")
  // that has recorded zero patterns and zero trajectories, EVER, used to be
  // permanently unreportable because the old gate was `everLearned`. The
  // banner must now fire, worded DIFFERENTLY from the "learned then
  // stalled" case above.
  it('SMI-6967 H-1 fix — a connected bridge that has NEVER learned anything fires past the threshold, with its own distinct wording', async () => {
    seedBridgeEntry({
      everProducerPresent: true,
      everLearned: false,
      consecutiveNoLearning: 7,
      lastObservedPatternsLearned: 0,
      lastObservedTrajectoriesRecorded: 0,
    })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('[ruflo-bridge]')
    expect(result.additionalContext).toContain('has never recorded a pattern or trajectory')
    expect(result.additionalContext).not.toContain('no learning recorded in 7 consecutive probes')
  })

  // --- SMI-6967 M-5: a counter regression, driven through the full stack.

  it('SMI-6967 M-5 — a counter regression renders unconditionally once a producer has been observed', async () => {
    seedBridgeEntry({
      everProducerPresent: true,
      countersRegressed: true,
      consecutiveNoLearning: 0,
    })
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('learning counters regressed')
  })

  // --- SMI-6967 M-4: the two anti-silence fault branches in
  // session-priming-query.ts (`the host repo key could not be resolved…` and
  // `the bridge-verdict reader failed: …`) had zero coverage in any test
  // file — our own SMI-6967 H-1 file-scope isolation fix (top of this file)
  // removed the only path that had been accidentally exercising them.

  it('SMI-6967 M-4 — a non-git cwd (bridgeKey unresolvable) renders the "could not be resolved" fault, not silence', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'session-priming-non-git-'))
    try {
      const result = await runQuery({ ...baseArgs, cwd: nonGitDir })
      expect(result.additionalContext).toContain('[ruflo-bridge]')
      expect(result.additionalContext).toContain(
        'the host repo key could not be resolved, so no verdict could be read'
      )
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true })
    }
  })

  it('SMI-6967 M-4 — a thrown reader renders the "bridge-verdict reader failed" fault, not silence', async () => {
    bridgeReaderShouldThrow.current = true
    const result = await runQuery({ ...baseArgs, cwd: repoDir })
    expect(result.additionalContext).toContain('[ruflo-bridge]')
    expect(result.additionalContext).toContain('the bridge-verdict reader failed')
    expect(result.additionalContext).toContain('forced reader failure (SMI-6967 M-4 test)')
  })

  // --- SMI-6967 L-6: the garbage-value fallback for the two documented env
  // vars was asserted only in a comment, not a test.

  it.each(['abc', '0', '-1'])(
    'SMI-6967 L-6 — SKILLSMITH_RUFLO_VERDICT_STALE_HOURS=%s falls back to the default (not NaN/0/negative)',
    async (garbage) => {
      const original = process.env.SKILLSMITH_RUFLO_VERDICT_STALE_HOURS
      try {
        seedBridgeEntry({
          verdict: 'healthy',
          evaluatedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // 2h old
        })
        process.env.SKILLSMITH_RUFLO_VERDICT_STALE_HOURS = garbage
        const result = await runQuery({ ...baseArgs, cwd: repoDir })
        // Default threshold is 48h — a 2h-old entry must NOT be stale under
        // the default, proving the garbage value was ignored rather than
        // coerced into some other (wrong) threshold.
        expect(result.additionalContext).not.toContain('verdict stale')
      } finally {
        if (original === undefined) delete process.env.SKILLSMITH_RUFLO_VERDICT_STALE_HOURS
        else process.env.SKILLSMITH_RUFLO_VERDICT_STALE_HOURS = original
      }
    }
  )

  it.each(['abc', '0', '-1'])(
    'SMI-6967 L-6 — SKILLSMITH_RUFLO_LIVENESS_DAYS=%s falls back to the default (not NaN/0/negative)',
    async (garbage) => {
      const original = process.env.SKILLSMITH_RUFLO_LIVENESS_DAYS
      try {
        seedBridgeEntry({ everProducerPresent: true, everLearned: true, consecutiveNoLearning: 3 })
        process.env.SKILLSMITH_RUFLO_LIVENESS_DAYS = garbage
        const result = await runQuery({ ...baseArgs, cwd: repoDir })
        // Default threshold is 7 — a streak of 3 must NOT fire under the
        // default, proving the garbage value was ignored.
        expect(result.additionalContext).not.toContain('no learning recorded')
      } finally {
        if (original === undefined) delete process.env.SKILLSMITH_RUFLO_LIVENESS_DAYS
        else process.env.SKILLSMITH_RUFLO_LIVENESS_DAYS = original
      }
    }
  )
})
