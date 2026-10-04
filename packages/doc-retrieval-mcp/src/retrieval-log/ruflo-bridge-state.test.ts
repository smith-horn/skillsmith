/**
 * SMI-6744 A5.5.2(b)/(c) delta — unit + real-concurrency tests for the
 * ruflo-bridge-state module. No mocking of the filesystem — every test points
 * `SKILLSMITH_STATE_DIR_OVERRIDE` at a unique per-test tmp dir and never
 * touches the real `~/.skillsmith`.
 *
 * Arm numbering matches the spec's `## Verification` section
 * (docs/internal/implementation/smi-6744-bridge-verdict-consumer.md). Arms
 * 1, 2a, 2b, 3 and 5 are red-tests (each names the mutation it must survive);
 * arms 4, 6 and 7 are complementary cases, not red-tests. The spec says so
 * explicitly, so none of the latter three invent a mutation.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from '../_lib/git-fixture-env.js'

import {
  BRIDGE_VERDICT_DISABLE_VAR,
  DEFAULT_EXPECTED_BY_ISO,
  LOCK_STALE_MS,
  acquireBridgeLock,
  bridgeLockStillHeld,
  foldLiveness,
  hasExpectedByPassed,
  readEntryResult,
  readState,
  releaseBridgeLock,
  renderBridgeBanner,
  renderBridgeLivenessLine,
  renderBridgeVerdictLine,
  resolveBridgeStatePath,
  resolveMainRepoKey,
  shouldProbe,
  writeEntryIfOwned,
  type BridgeEntry,
} from './ruflo-bridge-state.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, '..', '_lib', 'ruflo-bridge-worker.ts')
const TSX_BIN = join(HERE, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx')
const REPO_ROOT = join(HERE, '..', '..', '..', '..')

// ── Helpers ──────────────────────────────────────────────────────────────

const tmpDirs: string[] = []

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `${prefix}-`))
  tmpDirs.push(d)
  return d
}

let originalOverride: string | undefined

beforeEach(() => {
  originalOverride = process.env.SKILLSMITH_STATE_DIR_OVERRIDE
})

afterEach(() => {
  if (originalOverride === undefined) delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
  else process.env.SKILLSMITH_STATE_DIR_OVERRIDE = originalOverride
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function freshHome(): string {
  const dir = tmpDir('ruflo-bridge-home')
  process.env.SKILLSMITH_STATE_DIR_OVERRIDE = dir
  return dir
}

function makeEntry(overrides: Partial<BridgeEntry> = {}): BridgeEntry {
  return {
    evaluatedAt: new Date().toISOString(),
    verdict: 'healthy',
    reason: 'embeddingBackend=onnx',
    observedBackend: 'onnx',
    derivedFromVersion: '3.42.4',
    patternsLearned: 10,
    trajectoriesRecorded: 2,
    consecutiveNoLearning: 0,
    ...overrides,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForFileAsync(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${path}`)
    await sleep(10)
  }
}

/** Spawns a trivial, short-lived child and returns a PID guaranteed dead by the time this resolves. */
function spawnDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '1'])
    child.on('exit', () => resolve(child.pid as number))
    child.on('error', reject)
  })
}

// ── Reader: two-axis result (ok / missing / malformed / unreadable) ───────

describe('readEntryResult', () => {
  it('returns missing when the state file does not exist', () => {
    const dir = freshHome()
    const result = readEntryResult('key-a', join(dir, 'ruflo-bridge.state'))
    expect(result).toEqual({ status: 'missing' })
  })

  it('returns ok with the entry for a present key', () => {
    freshHome()
    const path = resolveBridgeStatePath()
    const entry = makeEntry({ verdict: 'degraded' })
    writeFileSync(path, `${JSON.stringify({ 'key-a': entry })}\n`)
    const result = readEntryResult('key-a', path)
    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.entry.verdict).toBe('degraded')
  })

  it('returns missing (not malformed) for an absent key in an otherwise-valid file', () => {
    freshHome()
    const path = resolveBridgeStatePath()
    writeFileSync(path, `${JSON.stringify({ 'other-key': makeEntry() })}\n`)
    expect(readEntryResult('key-a', path)).toEqual({ status: 'missing' })
  })

  it('returns malformed (not missing) for a truncated/corrupt JSON file', () => {
    freshHome()
    const path = resolveBridgeStatePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{"key-a": {"verdict": "heal')
    const result = readEntryResult('key-a', path)
    expect(result.status).toBe('malformed')
  })

  it('returns malformed for a present key missing required fields', () => {
    freshHome()
    const path = resolveBridgeStatePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { verdict: 'healthy' } })}\n`)
    expect(readEntryResult('key-a', path).status).toBe('malformed')
  })

  it('returns unreadable (not missing/malformed) for a permission-denied file', () => {
    if (process.getuid && process.getuid() === 0) {
      return // root bypasses file-mode permissions — skip, matching the spec's own uid caveat
    }
    freshHome()
    const path = resolveBridgeStatePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ 'key-a': makeEntry() })}\n`)
    chmodSync(path, 0o000)
    try {
      const result = readEntryResult('key-a', path)
      expect(result.status).toBe('unreadable')
    } finally {
      chmodSync(path, 0o644)
    }
  })
})

// ── expectedBy gate ─────────────────────────────────────────────────────

describe('hasExpectedByPassed', () => {
  it('is false before the constant', () => {
    expect(hasExpectedByPassed(new Date(Date.parse(DEFAULT_EXPECTED_BY_ISO) - 1000))).toBe(false)
  })
  it('is true at/after the constant', () => {
    expect(hasExpectedByPassed(new Date(Date.parse(DEFAULT_EXPECTED_BY_ISO) + 1000))).toBe(true)
  })
})

// ── Render: verdict axis ───────────────────────────────────────────────

describe('renderBridgeVerdictLine', () => {
  const now = new Date('2026-10-10T00:00:00.000Z')

  it('renders nothing for a fresh healthy entry', () => {
    const entry = makeEntry({ verdict: 'healthy', evaluatedAt: now.toISOString() })
    expect(renderBridgeVerdictLine({ status: 'ok', entry }, { now })).toBe('')
  })

  it('arm 3 — healthy does not guard the only mutation: forcing degraded must render', () => {
    const healthy = makeEntry({ verdict: 'healthy', evaluatedAt: now.toISOString() })
    const degraded = makeEntry({ verdict: 'degraded', evaluatedAt: now.toISOString() })
    expect(renderBridgeVerdictLine({ status: 'ok', entry: healthy }, { now })).toBe('')
    const rendered = renderBridgeVerdictLine({ status: 'ok', entry: degraded }, { now })
    expect(rendered).not.toBe('')
    expect(rendered).toContain('[ruflo-bridge]')
    expect(rendered).toContain('bridge degraded')
  })

  it('renders a stale-healthy line naming the hours, past the 48h default', () => {
    const entry = makeEntry({
      verdict: 'healthy',
      evaluatedAt: new Date(now.getTime() - 49 * 3_600_000).toISOString(),
    })
    const rendered = renderBridgeVerdictLine({ status: 'ok', entry }, { now })
    expect(rendered).toContain('verdict stale (49h)')
  })

  it('honors a custom SKILLSMITH_RUFLO_VERDICT_STALE_HOURS-equivalent staleHours option', () => {
    const entry = makeEntry({
      verdict: 'healthy',
      evaluatedAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
    })
    expect(renderBridgeVerdictLine({ status: 'ok', entry }, { now, staleHours: 1 })).toContain(
      'stale'
    )
    expect(renderBridgeVerdictLine({ status: 'ok', entry }, { now, staleHours: 3 })).toBe('')
  })

  it('renders degraded with the observed backend and remedy', () => {
    const entry = makeEntry({
      verdict: 'degraded',
      observedBackend: 'mock',
      evaluatedAt: now.toISOString(),
    })
    const rendered = renderBridgeVerdictLine({ status: 'ok', entry }, { now })
    expect(rendered).toContain("embeddingBackend 'mock'")
    expect(rendered).toContain('node scripts/ruflo-bridge-probe.mjs')
    expect(rendered).toContain('/mcp > ruflo > Reconnect')
    expect(rendered).toContain(BRIDGE_VERDICT_DISABLE_VAR)
  })

  it('renders not-evaluated for unrecognized, distinct from arm 1 (degraded)', () => {
    const degraded = renderBridgeVerdictLine(
      { status: 'ok', entry: makeEntry({ verdict: 'degraded', evaluatedAt: now.toISOString() }) },
      { now }
    )
    const unrecognized = renderBridgeVerdictLine(
      {
        status: 'ok',
        entry: makeEntry({
          verdict: 'unrecognized',
          observedBackend: 'onnx-v2',
          evaluatedAt: now.toISOString(),
        }),
      },
      { now }
    )
    expect(unrecognized).toContain('verdict not evaluated')
    expect(unrecognized).toContain("embeddingBackend 'onnx-v2'")
    expect(unrecognized).not.toBe(degraded)
  })

  it('renders malformed (detector-level) naming the payload path, not the generic embeddingBackend clause', () => {
    const entry = makeEntry({ verdict: 'malformed', evaluatedAt: now.toISOString() })
    const rendered = renderBridgeVerdictLine({ status: 'ok', entry }, { now })
    expect(rendered).toContain('payload malformed at')
    expect(rendered).toContain('ruflo-bridge-payload.json')
  })

  it('renders unreadable naming the launcher reason and the start command', () => {
    const entry = makeEntry({
      verdict: 'unreadable',
      reason: '[ruflo] MCP server cannot start: skillsmith-ruflo-1 container is not running.',
      evaluatedAt: now.toISOString(),
    })
    const rendered = renderBridgeVerdictLine({ status: 'ok', entry }, { now })
    expect(rendered).toContain('probe could not reach the served server')
    expect(rendered).toContain('skillsmith-ruflo-1 container is not running')
    expect(rendered).toContain('./scripts/ruflo-service-up.sh')
  })

  it('a verdict token outside the known six renders on the verdict axis, not as reader-malformed', () => {
    const entry = makeEntry({
      verdict: 'totally-unknown-future-token',
      evaluatedAt: now.toISOString(),
    })
    const rendered = renderBridgeVerdictLine({ status: 'ok', entry }, { now })
    expect(rendered).toContain('verdict not evaluated')
    expect(rendered).not.toContain('reader')
  })

  it('arm 6a — missing before expectedBy is quiet', () => {
    expect(
      renderBridgeVerdictLine({ status: 'missing' }, { now: new Date('2026-09-01T00:00:00Z') })
    ).toBe('')
  })

  it('arm 6b — missing after expectedBy renders loudly, naming "missing"', () => {
    const rendered = renderBridgeVerdictLine(
      { status: 'missing' },
      { now: new Date('2026-11-01T00:00:00Z') }
    )
    expect(rendered).toContain('verdict not evaluated: state missing')
  })

  it('malformed (reader-level: corrupt state file) always renders, regardless of expectedBy', () => {
    const early = renderBridgeVerdictLine(
      { status: 'malformed', detail: 'x' },
      { now: new Date('2026-09-01T00:00:00Z') }
    )
    expect(early).toContain('verdict not evaluated: state malformed')
  })

  it('unreadable (reader-level: I/O error) always renders, naming the errno', () => {
    const rendered = renderBridgeVerdictLine(
      { status: 'unreadable', detail: 'EACCES' },
      { now: new Date('2026-09-01T00:00:00Z') }
    )
    expect(rendered).toContain('unreadable (EACCES)')
  })

  it('arm 4 — two ages at least 1h apart render distinct substrings, not a format-only shape match', () => {
    const t0 = makeEntry({
      verdict: 'degraded',
      evaluatedAt: new Date(now.getTime() - 1 * 3_600_000).toISOString(),
    })
    const t5 = makeEntry({
      verdict: 'degraded',
      evaluatedAt: new Date(now.getTime() - 5 * 3_600_000).toISOString(),
    })
    const r0 = renderBridgeVerdictLine({ status: 'ok', entry: t0 }, { now })
    const r5 = renderBridgeVerdictLine({ status: 'ok', entry: t5 }, { now })
    expect(r0).toContain('(1h ago)')
    expect(r5).toContain('(5h ago)')
    expect(r0).not.toBe(r5)
  })
})

// ── Render: liveness axis ──────────────────────────────────────────────

describe('renderBridgeLivenessLine', () => {
  const now = new Date('2026-10-10T00:00:00.000Z')

  it('arm 9 — fires at the SKILLSMITH_RUFLO_LIVENESS_DAYS default (7)', () => {
    const entry = makeEntry({ consecutiveNoLearning: 7 })
    const rendered = renderBridgeLivenessLine({ status: 'ok', entry }, { now })
    expect(rendered).toContain('no learning recorded in 7 days')
  })

  it('does not fire one probe short of the threshold', () => {
    const entry = makeEntry({ consecutiveNoLearning: 6 })
    expect(renderBridgeLivenessLine({ status: 'ok', entry }, { now })).toBe('')
  })

  it('renders nothing for a non-ok read', () => {
    expect(renderBridgeLivenessLine({ status: 'missing' }, { now })).toBe('')
  })
})

// ── Arm 6: presence + absence in one execution ─────────────────────────

describe('arm 6 — presence and absence asserted from the same run', () => {
  it('a degraded fixture renders a line AND a healthy fixture renders none, in one battery', () => {
    const now = new Date('2026-10-10T00:00:00.000Z')
    const degradedLine = renderBridgeBanner(
      { status: 'ok', entry: makeEntry({ verdict: 'degraded', evaluatedAt: now.toISOString() }) },
      { now }
    )
    const healthyLine = renderBridgeBanner(
      { status: 'ok', entry: makeEntry({ verdict: 'healthy', evaluatedAt: now.toISOString() }) },
      { now }
    )
    expect(degradedLine).not.toBe('')
    expect(healthyLine).toBe('')
  })
})

// ── Arm 7 (complementary, not a red-test): D4 cached / wrong-store cases render ──

describe('arm 7 — cached and wrong-store answers render (complementary case)', () => {
  const now = new Date('2026-10-10T00:00:00.000Z')

  it('a cached answer carrying the current generation renders loudly', () => {
    // The writer's D4 identity check classifies this as the SAME `malformed`
    // verdict the detector uses for a self-contradictory payload — D4 does
    // not invent a 7th enum value — with a reason naming what it found.
    const entry = makeEntry({
      verdict: 'malformed',
      reason:
        'independent freshness check failed: two memory_bridge_status calls in one probe returned an unchanged agentdb.totalEntries and the fd-resolved store generation matches the authority file, which a cached response can also produce',
      evaluatedAt: now.toISOString(),
    })
    const rendered = renderBridgeVerdictLine({ status: 'ok', entry }, { now })
    expect(rendered).not.toBe('')
    expect(rendered).toContain('payload malformed')
  })

  it('a copied generation marker pointing at the wrong store renders loudly', () => {
    const entry = makeEntry({
      verdict: 'malformed',
      reason:
        'independent identity check failed: the server process has agentdb-memory.db open at a different device/inode than the authority-identified store, though the store_generation value matches',
      evaluatedAt: now.toISOString(),
    })
    const rendered = renderBridgeVerdictLine({ status: 'ok', entry }, { now })
    expect(rendered).not.toBe('')
    expect(rendered).toContain('payload malformed')
  })
})

// ── Liveness fold ───────────────────────────────────────────────────────

describe('foldLiveness', () => {
  it('starts at 0 with no prior entry', () => {
    expect(foldLiveness(null, 10, 2)).toBe(0)
  })
  it('increments when both counters are unchanged', () => {
    const prior = makeEntry({
      patternsLearned: 10,
      trajectoriesRecorded: 2,
      consecutiveNoLearning: 3,
    })
    expect(foldLiveness(prior, 10, 2)).toBe(4)
  })
  it('resets to 0 when either counter moved', () => {
    const prior = makeEntry({
      patternsLearned: 10,
      trajectoriesRecorded: 2,
      consecutiveNoLearning: 5,
    })
    expect(foldLiveness(prior, 11, 2)).toBe(0)
  })
  it('resets to 0 when either counter is unreadable (null) this run', () => {
    const prior = makeEntry({
      patternsLearned: 10,
      trajectoriesRecorded: 2,
      consecutiveNoLearning: 5,
    })
    expect(foldLiveness(prior, null, null)).toBe(0)
  })
})

// ── shouldProbe (debounce) ──────────────────────────────────────────────

describe('shouldProbe', () => {
  it('is true with no prior entry', () => {
    expect(shouldProbe(null, Date.now())).toBe(true)
  })
  it('is false within the 24h debounce window', () => {
    const prior = makeEntry({ evaluatedAt: new Date(Date.now() - 1000).toISOString() })
    expect(shouldProbe(prior, Date.now())).toBe(false)
  })
  it('is true past the debounce window', () => {
    const prior = makeEntry({ evaluatedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() })
    expect(shouldProbe(prior, Date.now())).toBe(true)
  })
  it('is true for an unparseable evaluatedAt (fail toward probing)', () => {
    const prior = makeEntry({ evaluatedAt: 'not-a-date' })
    expect(shouldProbe(prior, Date.now())).toBe(true)
  })
})

// ── Lock: basic mechanics ───────────────────────────────────────────────

describe('bridge lock — basic mechanics', () => {
  it('acquires when uncontended and releases cleanly', async () => {
    freshHome()
    const handle = await acquireBridgeLock(1000)
    expect(handle).not.toBeNull()
    expect(bridgeLockStillHeld(handle!)).toBe(true)
    releaseBridgeLock(handle!)
    expect(bridgeLockStillHeld(handle!)).toBe(false)
  })

  it('a second acquire times out while the first is held (no PID-liveness confusion within one process)', async () => {
    freshHome()
    const handle = await acquireBridgeLock(1000)
    expect(handle).not.toBeNull()
    const second = await acquireBridgeLock(300, 20, LOCK_STALE_MS) // short timeout, real stale threshold
    expect(second).toBeNull()
    releaseBridgeLock(handle!)
  })

  it('writeEntryIfOwned refuses and leaves the state untouched once the token no longer holds', () => {
    freshHome()
    const key = 'k'
    const handleA = {
      token: 'tok-a',
      lockDir: join(process.env.SKILLSMITH_STATE_DIR_OVERRIDE!, 'ruflo-bridge.state.lock'),
    }
    mkdirSync(handleA.lockDir, { recursive: true })
    writeFileSync(join(handleA.lockDir, 'owner'), '999999 tok-a')
    // A different token now "owns" the lock (simulating a takeover).
    writeFileSync(join(handleA.lockDir, 'owner'), '999999 tok-b')
    const wrote = writeEntryIfOwned(key, makeEntry({ verdict: 'healthy' }), handleA)
    expect(wrote).toBe(false)
    expect(readState()[key]).toBeUndefined()
  })

  it('a live holder is never reclaimed by age alone', async () => {
    freshHome()
    const handle = await acquireBridgeLock(1000)
    expect(handle).not.toBeNull()
    // Make the lock dir LOOK stale (age > staleMs) while the owner (THIS
    // process) is still alive — must NOT be reclaimed.
    const past = new Date(Date.now() - 1000)
    utimesSync(handle!.lockDir, past, past)
    const attempt = await acquireBridgeLock(300, 20, 1) // staleMs=1ms: age check alone would reclaim
    expect(attempt).toBeNull() // liveness check still refuses it
    releaseBridgeLock(handle!)
  })
})

// ── Arm 5, sub-arm 3: takeover — a resumed stale holder must be forbidden to write ──

describe('arm 5 (part 3) — takeover: a resumed paused holder cannot overwrite the replacement', () => {
  it('reclaims a stale lock whose owner PID is confirmed dead, and forbids the old token from writing afterward', async () => {
    freshHome()
    const deadPid = await spawnDeadPid()
    const lockDir = `${resolveBridgeStatePath()}.lock`
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner'), `${deadPid} original-token`)
    const past = new Date(Date.now() - (LOCK_STALE_MS + 5000))
    utimesSync(lockDir, past, past)

    const originalHandle = { token: 'original-token', lockDir }
    expect(bridgeLockStillHeld(originalHandle)).toBe(true) // still recorded as the owner, pre-reclaim

    const replacement = await acquireBridgeLock(5000)
    expect(replacement).not.toBeNull()
    expect(replacement!.token).not.toBe('original-token')

    // The replacement writes successfully.
    const wroteReplacement = writeEntryIfOwned('k', makeEntry({ verdict: 'healthy' }), replacement!)
    expect(wroteReplacement).toBe(true)

    // Mutation under test: drop the ownership-token check before rename —
    // simulated here by attempting the write with the STALE handle directly,
    // which is exactly what a resumed original holder would do.
    expect(bridgeLockStillHeld(originalHandle)).toBe(false)
    const wroteResumed = writeEntryIfOwned('k', makeEntry({ verdict: 'degraded' }), originalHandle)
    expect(wroteResumed).toBe(false)
    expect(readState()['k']?.verdict).toBe('healthy') // the replacement's write stands, unclobbered

    releaseBridgeLock(replacement!)
  })
})

// ── Arm 5, sub-arm 2: clearing — healthy must be able to overwrite a prior degraded ──

describe('arm 5 (part 2) — clearing: no verdict is sticky', () => {
  it('a probe past the debounce window writes healthy over a prior degraded (no keep-worst)', async () => {
    freshHome()
    const key = 'k'
    const stale = new Date(Date.now() - 25 * 3_600_000).toISOString()
    writeFileSync(
      resolveBridgeStatePath(),
      `${JSON.stringify({ [key]: makeEntry({ verdict: 'degraded', evaluatedAt: stale }) })}\n`
    )
    const handle = await acquireBridgeLock(1000)
    expect(handle).not.toBeNull()
    const prior = readState()[key] ?? null
    expect(shouldProbe(prior, Date.now())).toBe(true)
    const wrote = writeEntryIfOwned(key, makeEntry({ verdict: 'healthy' }), handle!)
    expect(wrote).toBe(true)
    releaseBridgeLock(handle!)
    expect(readState()[key].verdict).toBe('healthy')
  })
})

// ── Arm 5, sub-arm 1: real-concurrency exactly-one-probe assertion ─────

describe('arm 5 (part 1) — real concurrency: the lock spans probe-through-write', () => {
  async function runTwoWorkers(
    mode: 'correct' | 'buggy',
    key: string
  ): Promise<{ probedCount: number; results: string[] }> {
    const dir = freshHome()
    const barrierDir = tmpDir('ruflo-bridge-barrier')
    const readyA = join(barrierDir, 'a.ready')
    const readyB = join(barrierDir, 'b.ready')
    const goFile = join(barrierDir, 'go')
    const resultA = join(barrierDir, 'a.result')
    const resultB = join(barrierDir, 'b.result')

    const env = { ...process.env, SKILLSMITH_STATE_DIR_OVERRIDE: dir }
    const spawnWorker = (readyFile: string, resultFile: string, verdict: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          TSX_BIN,
          [WORKER, mode, readyFile, goFile, resultFile, key, verdict, '150'],
          { env, cwd: REPO_ROOT, stdio: 'inherit' }
        )
        child.on('exit', () => resolve())
        child.on('error', reject)
      })

    const pA = spawnWorker(readyA, resultA, 'healthy')
    const pB = spawnWorker(readyB, resultB, 'degraded')

    // Both writers are held at the barrier until each has reached its
    // pre-run checkpoint, so neither can finish before the other arrives
    // (Sol round 2 finding 3 — merely starting them together is not enough).
    await waitForFileAsync(readyA)
    await waitForFileAsync(readyB)
    writeFileSync(goFile, '1')

    await Promise.all([pA, pB])
    await waitForFileAsync(resultA, 15_000)
    await waitForFileAsync(resultB, 15_000)

    const probedCount = [`${resultA}.probed`, `${resultB}.probed`].filter(existsSync).length
    return {
      probedCount,
      results: [readFileSync(resultA, 'utf8'), readFileSync(resultB, 'utf8')],
    }
  }

  it('the correct orchestration (lock spans probe-through-write) runs exactly one probe', async () => {
    const { probedCount, results } = await runTwoWorkers('correct', 'k')
    expect(probedCount).toBe(1)
    expect(results.filter((r) => r === 'WROTE')).toHaveLength(1)
    expect(results.filter((r) => r === 'DECLINED')).toHaveLength(1)
  }, 20_000)

  it('mutation: narrowing the lock to the write alone lets both workers probe (count=2) — the arm must fail to kill this', async () => {
    const { probedCount, results } = await runTwoWorkers('buggy', 'k')
    expect(probedCount).toBe(2)
    expect(results.filter((r) => r === 'WROTE')).toHaveLength(2)
  }, 20_000)
})

// ── Arm 1: the hook invocation must not be inside the lockfile conditional ──

describe('arm 1 — .husky/post-merge: the bridge-probe invocation is outside the lockfile conditional', () => {
  it('derives the conditional range at test time and asserts the invocation sits outside it', () => {
    const hookPath = join(REPO_ROOT, '.husky', 'post-merge')
    const lines = readFileSync(hookPath, 'utf8').split('\n')
    const openIdx = lines.findIndex((l) => l.includes("grep -q '^package-lock\\.json$'"))
    expect(openIdx).toBeGreaterThan(-1)
    // The matching `fi` for that `if` block: walk forward tracking nested if/fi.
    let depth = 1
    let closeIdx = -1
    for (let i = openIdx + 1; i < lines.length; i += 1) {
      if (/^\s*if\b/.test(lines[i])) depth += 1
      if (/^\s*fi\s*$/.test(lines[i])) {
        depth -= 1
        if (depth === 0) {
          closeIdx = i
          break
        }
      }
    }
    expect(closeIdx).toBeGreaterThan(openIdx)

    // Assert an EXECUTABLE invocation, not a filename mention. The previous
    // form used `l.includes('ruflo-bridge-probe.mjs')`, which matches the
    // `[ -f … ]` guard in the block's own `if` condition — so neutering both
    // lines that actually run the probe left this arm green, confirmed by
    // experiment. That pinned the position of a string rather than the
    // existence of an invocation.
    //
    // Execution here goes through the command variable. A line that references
    // it WITHOUT being an assignment to it is a command position; an
    // assignment, a `[ -f … ]` test and a comment are not.
    const CMD_VAR = '_RUFLO_BRIDGE_CMD'
    const execIdxs = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => {
        const body = l.replace(/#.*$/, '')
        if (!body.includes(`$${CMD_VAR}`)) return false
        return !new RegExp(`^\\s*${CMD_VAR}=`).test(body)
      })
      .map(({ i }) => i)

    // At least one real invocation must exist at all.
    expect(execIdxs.length).toBeGreaterThan(0)

    // Every invocation must sit outside the lockfile conditional and before
    // the hook's final `exit 0` — "at least one is fine" would let a second,
    // nested copy hide inside the gate.
    for (const idx of execIdxs) {
      expect(idx > openIdx && idx < closeIdx).toBe(false)
    }
    const probeIdx = execIdxs[0]

    // The probe invocation must precede the hook's final `exit 0`.
    const exitIdx = lines.findIndex((l) => /^exit 0\s*$/.test(l))
    expect(exitIdx).toBeGreaterThan(-1)
    expect(probeIdx).toBeLessThan(exitIdx)
  })
})

// ── Arm 2a: the reader's key must be the host-resolved key, not a constant ──

describe('arm 2a — the reader must use the real resolved key; a wrong key silently sees nothing', () => {
  it('an entry written under the real key is invisible under a wrong (constant) key', () => {
    freshHome()
    const realKey = '/Users/example/real-checkout-path'
    writeFileSync(resolveBridgeStatePath(), `${JSON.stringify({ [realKey]: makeEntry() })}\n`)

    const wrongKeyResult = readEntryResult('a-constant-that-is-not-the-real-key')
    expect(wrongKeyResult).toEqual({ status: 'missing' })

    const correctKeyResult = readEntryResult(realKey)
    expect(correctKeyResult.status).toBe('ok')
  })
})

// ── Arm 2b: resolveMainRepoKey resolves to the main checkout regardless of cwd ──
//
// Built against a SELF-CONTAINED fixture (plain `git init` + `git worktree
// add`) rather than this actual checked-out worktree: a linked worktree's
// `.git` file stores a HOST-absolute gitdir pointer written at
// `create-worktree.sh` time, which is meaningless when the test suite runs
// INSIDE the dev container (confirmed empirically — `git -C /app worktree
// list` fails there with "not a git repository", a container/host path
// mismatch unrelated to this arm's property). A fixture repo created fresh
// inside the test process has no such pointer and exercises the identical
// `git worktree list --porcelain` mechanism `resolveMainRepoKey` actually
// uses, on both ends (main checkout and linked worktree).

describe('arm 2b — resolveMainRepoKey is independent of the calling cwd (never container-side)', () => {
  let mainRepo: string
  let linkedWorktree: string

  beforeEach(() => {
    mainRepo = makeFixtureTempDir('ruflo-bridge-a2b-main')
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', mainRepo], {
      env: makeFixtureEnv(),
    })
    writeFileSync(join(mainRepo, 'f.txt'), 'x')
    execFileSync('git', ['-C', mainRepo, 'add', '.'], { env: makeFixtureEnv() })
    execFileSync('git', ['-C', mainRepo, 'commit', '-m', 'x', '--quiet'], { env: makeFixtureEnv() })
    linkedWorktree = makeFixtureTempDir('ruflo-bridge-a2b-wt')
    rmSync(linkedWorktree, { recursive: true, force: true }) // worktree add requires a non-existent target
    execFileSync('git', ['-C', mainRepo, 'worktree', 'add', linkedWorktree, '-b', 'wt-branch'], {
      env: makeFixtureEnv(),
    })
  })

  afterEach(() => {
    rmSync(mainRepo, { recursive: true, force: true })
    rmSync(linkedWorktree, { recursive: true, force: true })
  })

  it('resolves the same main-checkout path from the main repo and from a linked worktree', () => {
    const fromMain = resolveMainRepoKey(mainRepo)
    const fromWorktree = resolveMainRepoKey(linkedWorktree)
    expect(fromMain).not.toBeNull()
    expect(fromWorktree).not.toBeNull()
    expect(fromWorktree).toBe(fromMain)
  })

  it('does not fall back to a bare rev-parse --show-toplevel semantics (the WRONG resolver per D3)', () => {
    // From the LINKED worktree's own cwd, `rev-parse --show-toplevel` names
    // the worktree itself — the wrong resolver D3 warns against. The correct
    // resolver (`resolveMainRepoKey`) must diverge from it here.
    const resolved = resolveMainRepoKey(linkedWorktree)
    const toplevel = spawnSync('git', ['-C', linkedWorktree, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      env: makeFixtureEnv(),
    }).stdout.trim()
    expect(resolved).not.toBe(toplevel)
    expect(resolved).toBe(mainRepo)
    expect(toplevel).toBe(linkedWorktree)
  })
})

// ── The WRITER's own orchestration, not a reimplementation of it ────────────
//
// The real-concurrency worker calls the production lock primitives
// (acquireBridgeLock, writeEntryIfOwned) but supplies its own acquire/probe/
// write ordering, comparing a "correct" mode against a "buggy" one. That
// proves the primitives behave under two orchestrations; it does NOT pin which
// orchestration the writer chose, because the worker never calls the writer.
// A cross-family code gate found exactly that gap.
//
// This arm closes it where the ordering actually lives: in the writer's source.
// The invariant D1.3 states is that the lock is taken BEFORE the probe and held
// through classification and the write — so acquire must precede the first
// status call, the write must follow both, and the release must come last.
describe("the writer's orchestration: lock before probe, held through the write", () => {
  it('acquires the lock before probing, writes inside it, and releases last', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'ruflo-bridge-probe.mjs'), 'utf8').split(
      '\n'
    )

    // Call sites only — the import list names the same symbols without parens.
    const idxOf = (needle: string): number =>
      src.findIndex((l) => !l.trim().startsWith('//') && l.includes(needle))

    const acquireIdx = idxOf('acquireBridgeLock(')
    const probeIdx = idxOf('callMemoryBridgeStatus(FIRST_CALL_MS)')
    const writeIdx = idxOf('writeEntryIfOwned(')
    const releaseIdx = idxOf('releaseBridgeLock(')

    expect(acquireIdx).toBeGreaterThan(-1)
    expect(probeIdx).toBeGreaterThan(-1)
    expect(writeIdx).toBeGreaterThan(-1)
    expect(releaseIdx).toBeGreaterThan(-1)

    // The ordering IS the invariant. Mutation that must fail this arm: move the
    // acquire below the probe, which is the narrowed-lock design the worker's
    // "buggy" mode models but which nothing previously forbade in the writer.
    expect(acquireIdx).toBeLessThan(probeIdx)
    expect(probeIdx).toBeLessThan(writeIdx)
    expect(writeIdx).toBeLessThan(releaseIdx)
  })
})
