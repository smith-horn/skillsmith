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
  LOCK_STALE_MS,
  acquireBridgeLock,
  bridgeLockStillHeld,
  foldLiveness,
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
    // SMI-6967 H-9/SMI-6985: defaults model an already-armed, fully-producing
    // checkout with a consistent baseline, matching the default
    // patternsLearned/trajectoriesRecorded above — most existing arms below
    // don't care about the liveness fields at all, so this keeps them
    // unaffected. `everLearned` defaults true because the render gate is
    // that flag (SMI-6985, superseding H-1's `everProducerPresent`) — a test
    // exercising the pre-learning dormant case must override it explicitly.
    everProducerPresent: true,
    everLearned: true,
    countersRegressed: false,
    lastObservedPatternsLearned: 10,
    lastObservedTrajectoriesRecorded: 2,
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

  it('returns malformed (not missing), with detail naming the parse failure, for a truncated/corrupt JSON file', () => {
    freshHome()
    const path = resolveBridgeStatePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{"key-a": {"verdict": "heal')
    const result = readEntryResult('key-a', path)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('does not parse')
  })

  it('returns malformed for a present key missing required fields', () => {
    freshHome()
    const path = resolveBridgeStatePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { verdict: 'healthy' } })}\n`)
    expect(readEntryResult('key-a', path).status).toBe('malformed')
  })

  it('returns malformed, naming the not-an-object condition, for a state file that is a JSON array', () => {
    freshHome()
    const path = resolveBridgeStatePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '[]\n')
    const result = readEntryResult('key-a', path)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('not a JSON object')
  })

  it('returns malformed for a state file that is a JSON scalar', () => {
    freshHome()
    const path = resolveBridgeStatePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '"hello"\n')
    expect(readEntryResult('key-a', path).status).toBe('malformed')

    writeFileSync(path, '42\n')
    expect(readEntryResult('key-a', path).status).toBe('malformed')
  })

  // SMI-6995 6a: this used to simulate "unreadable" with `chmodSync(path,
  // 0o000)`, guarded by an early `return` when running as root. Measured
  // (SMI-6995 plan M3/M7/M8/M9): root bypasses POSIX file-mode checks, and
  // both the dev container and the CI image run as root with no CI step
  // overriding the user — so that guard's early return fired on every real
  // run and the test's own `expect` never executed. It asserted nothing,
  // anywhere it actually ran, and reported as passed regardless: the exact
  // invisible-success class this banner exists to catch, reproduced inside
  // the test meant to prove the banner correct. A directory standing where
  // the state file is expected throws EISDIR at ANY uid (M4) and is
  // classified `unreadable` the same way any other non-ENOENT errno is — no
  // uid guard needed.
  it('returns unreadable, with detail carrying EISDIR, when a directory stands where the state file is expected', () => {
    freshHome()
    const path = resolveBridgeStatePath()
    mkdirSync(path, { recursive: true })
    const result = readEntryResult('key-a', path)
    expect(result.status).toBe('unreadable')
    expect(result.status === 'unreadable' && result.detail).toContain('EISDIR')
  })
})

// ── Render: verdict axis ───────────────────────────────────────────────

describe('renderBridgeVerdictLine', () => {
  const now = new Date('2026-10-10T00:00:00.000Z')

  // SMI-6985 M-3 follow-up (coordinator-found, round 2, full-file sweep): a
  // bare `.toBe('')` here would also pass if this function always returned
  // '' for some unrelated reason. Control: the SAME `now`, a degraded entry
  // instead of healthy, must render — proving the function actually ran and
  // that `verdict: 'healthy'` is the discriminating input, not that nothing
  // executed.
  it('renders nothing for a fresh healthy entry', () => {
    const entry = makeEntry({ verdict: 'healthy', evaluatedAt: now.toISOString() })
    expect(renderBridgeVerdictLine({ status: 'ok', entry }, { now })).toBe('')

    const degraded = makeEntry({ verdict: 'degraded', evaluatedAt: now.toISOString() })
    expect(renderBridgeVerdictLine({ status: 'ok', entry: degraded }, { now })).toContain(
      'bridge degraded'
    )
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

  // SMI-6985: the `expectedBy` grace window that used to suppress a
  // `missing` read for a time is deleted outright (owner decision — its
  // per-checkout install-date anchor was fixed three times and was
  // renewable every time: working-tree mtime, then the commit's committer
  // date, then its author date, which a shallow clone's grafted boundary
  // moves too, moving again on every subsequent `git fetch --depth=1`). A
  // `missing` read now renders unconditionally — no filesystem or git state
  // of any kind can suppress it. This replaces the former arms 6a-6d and the
  // SMI-6967 H-2 "unknown install check" test, which exercised the deleted
  // `installedAt` option that no longer exists on this function's signature.
  it('SMI-6985 — a missing verdict always renders, regardless of any filesystem or git state (the expectedBy grace window is gone)', () => {
    const rendered = renderBridgeVerdictLine(
      { status: 'missing' },
      { now: new Date('2026-01-01T00:00:00Z') }
    )
    expect(rendered).toContain('verdict not evaluated: state missing')
  })

  it('malformed (reader-level: corrupt state file) always renders', () => {
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

  it('arm 9 — fires at the SKILLSMITH_RUFLO_LIVENESS_DAYS default (7), once armed', () => {
    const entry = makeEntry({ everLearned: true, consecutiveNoLearning: 7 })
    const rendered = renderBridgeLivenessLine({ status: 'ok', entry }, { now })
    // SMI-6967 M-13: the threshold counts consecutive PROBES, not days.
    expect(rendered).toContain('no learning recorded in 7 consecutive probes')
    expect(rendered).not.toContain('7 days')
  })

  // SMI-6985 M-3 follow-up (coordinator-found, round 2): a bare `.toBe('')`
  // here would also pass if this function always returned '' regardless of
  // input. Control: one probe later (7, the default threshold) on the same
  // everLearned:true entry must fire — proving the boundary is real, not
  // that the function is silently inert.
  it('does not fire one probe short of the threshold', () => {
    const entry = makeEntry({ everLearned: true, consecutiveNoLearning: 6 })
    expect(renderBridgeLivenessLine({ status: 'ok', entry }, { now })).toBe('')

    const atThreshold = makeEntry({ everLearned: true, consecutiveNoLearning: 7 })
    expect(renderBridgeLivenessLine({ status: 'ok', entry: atThreshold }, { now })).toContain(
      'no learning recorded in 7 consecutive probes'
    )
  })

  // SMI-6985 correction of record (owner-decided, superseding SMI-6967 H-1,
  // corrected in place rather than appended below). Measured live: nothing in
  // this repository calls the trajectory-capture hooks at all, so a
  // connected bridge with a non-empty store — THIS checkout's actual,
  // permanent state — latches `everProducerPresent` immediately and never
  // un-latches, while `everLearned` never does. Gating on
  // `everProducerPresent` (H-1's fix) therefore fired "has never recorded a
  // pattern or trajectory... across N consecutive probes" PERPETUALLY, on a
  // condition nobody can act on: H-1 traded an unreportable `false` for an
  // un-actionable `true`, one layer out. `everLearned` — the counters' own
  // persisted history — is the gate now: until something has actually been
  // recorded at least once there is nothing actionable to report, so the arm
  // stays silent, correctly. See `renderBridgeVerdictLine`'s sibling function
  // doc comment (`renderBridgeLivenessLine`'s own, in ruflo-bridge-state.ts)
  // for the full history.
  // SMI-6985 M-3 (reviewer-found): a bare `.toBe('')` here would also pass if
  // this function were broken in some way that always returns '' (wrong
  // import, wrong argument shape, an early return added by mistake) — it
  // does not prove the dormancy is actually CAUSED by `everLearned: false`.
  // Control: flipping ONLY `everLearned` to true on the same
  // otherwise-identical entry (same `consecutiveNoLearning`, same `now`)
  // must make the line render — pairing the two in one test proves the
  // function was actually exercised and that `everLearned` is the
  // discriminating field.
  it('SMI-6985 — stays dormant (renders nothing) before anything has ever been learned, even with a producer connected and past the threshold', () => {
    const dormant = makeEntry({
      everProducerPresent: true,
      everLearned: false,
      consecutiveNoLearning: 999,
      lastObservedPatternsLearned: 0,
      lastObservedTrajectoriesRecorded: 0,
    })
    expect(renderBridgeLivenessLine({ status: 'ok', entry: dormant }, { now })).toBe('')

    const armed = makeEntry({ ...dormant, everLearned: true })
    expect(renderBridgeLivenessLine({ status: 'ok', entry: armed }, { now })).toContain(
      'no learning recorded'
    )
  })

  // SMI-6985 M-3 follow-up (coordinator-found, round 2): the same gap as the
  // "stays dormant" test above — a bare `.toBe('')` here would also pass if
  // this function were broken in some way that always returns '' (wrong
  // import, wrong argument shape, an early return added by mistake). Control:
  // flipping ONLY `everLearned` to true on the same otherwise-identical entry
  // (same `consecutiveNoLearning`, same `now`) must make the line render —
  // pairing the two in one test proves the function was actually exercised
  // and that `everLearned` is the discriminating field, not that the
  // function (or this test) is silently inert.
  it('SMI-6985 RED-TEST — reproduces the reported defect: a connected bridge that has NEVER learned anything must NOT fire, however long it has been connected', () => {
    // The exact SMI-6967 H-1 scenario this correction reverses: on the live
    // host both halves of the superseded gate (bridge.status==='connected',
    // agentdb.totalEntries>0) are true PERMANENTLY, since no trajectory
    // writer exists anywhere in this repo — so under that gate this fired
    // unconditionally, on every probe, forever, with nothing anyone could
    // fix. An arbitrarily large streak must still render nothing here.
    const dormant = makeEntry({
      everProducerPresent: true,
      everLearned: false,
      consecutiveNoLearning: 999_999,
      lastObservedPatternsLearned: 0,
      lastObservedTrajectoriesRecorded: 0,
    })
    expect(renderBridgeLivenessLine({ status: 'ok', entry: dormant }, { now })).toBe('')

    const armed = makeEntry({ ...dormant, everLearned: true })
    expect(renderBridgeLivenessLine({ status: 'ok', entry: armed }, { now })).toContain(
      'no learning recorded'
    )
  })

  it('fires once armed (everLearned true) and past the threshold, regardless of everProducerPresent — the gate no longer depends on it', () => {
    const entry = makeEntry({
      everProducerPresent: false,
      everLearned: true,
      consecutiveNoLearning: 7,
    })
    const rendered = renderBridgeLivenessLine({ status: 'ok', entry }, { now })
    expect(rendered).toContain('no learning recorded in 7 consecutive probes')
  })

  // SMI-6985 M-3 follow-up (coordinator-found, round 2): a bare `.toBe('')`
  // here would also pass if this function always returned ''. Control: the
  // SAME entry with `everLearned` explicitly restored to `true` must fire —
  // proving the missing-field case is actually read as dormant, not that
  // the function never runs.
  it('SMI-6985 — treats a missing everLearned field (an entry written before this correction shipped) as dormant', () => {
    const entry = makeEntry({ consecutiveNoLearning: 999 })
    // @ts-expect-error — simulating an on-disk entry written before this field existed
    delete entry.everLearned
    expect(renderBridgeLivenessLine({ status: 'ok', entry }, { now })).toBe('')

    const armed = makeEntry({ ...entry, everLearned: true, consecutiveNoLearning: 999 })
    expect(renderBridgeLivenessLine({ status: 'ok', entry: armed }, { now })).toContain(
      'no learning recorded'
    )
  })

  it('SMI-6967 M-5 — a counter regression renders unconditionally, ahead of and independent from the no-learning threshold', () => {
    const entry = makeEntry({ countersRegressed: true, consecutiveNoLearning: 0 })
    const rendered = renderBridgeLivenessLine({ status: 'ok', entry }, { now })
    expect(rendered).not.toBe('')
    expect(rendered).toContain('learning counters regressed')
    expect(rendered).toContain('decreased since the last probe')
  })

  // SMI-6985 M-1 (reviewer-found): this test used to assert the OPPOSITE —
  // that a regression stays suppressed until `everLearned` latches — on the
  // theory that a regression requires a positive prior baseline which would
  // already have set `everLearned`. That theory is false for a baseline
  // seeded from a LEGACY entry (see `renderBridgeLivenessLine`'s own doc
  // comment): `seedBaseline` falls back to the entry's raw
  // `patternsLearned`/`trajectoriesRecorded` when `lastObserved*` is
  // `undefined`, and `readEntryResult` never validates `everLearned`, so a
  // pre-SMI-6967 on-disk entry wiped to exactly zero reaches this exact
  // state (`everLearned: false`, `countersRegressed: true`) — the loudest
  // signal this arm has, and the old assertion pinned its suppression.
  it('SMI-6985 M-1 — a counter regression renders even when everLearned is false (a legacy-baseline wipe-to-zero)', () => {
    const entry = makeEntry({ everLearned: false, countersRegressed: true })
    const rendered = renderBridgeLivenessLine({ status: 'ok', entry }, { now })
    expect(rendered).toContain('learning counters regressed')
  })

  // SMI-6985 M-3 follow-up (coordinator-found, round 2): a bare `.toBe('')`
  // here would also pass if this function always returned ''. Control: an
  // `ok` read with an armed, past-threshold entry must fire — proving the
  // `status !== 'ok'` short-circuit is real, not that the function never
  // produces output at all.
  it('renders nothing for a non-ok read', () => {
    expect(renderBridgeLivenessLine({ status: 'missing' }, { now })).toBe('')

    const armed = makeEntry({ everLearned: true, consecutiveNoLearning: 7 })
    expect(renderBridgeLivenessLine({ status: 'ok', entry: armed }, { now })).toContain(
      'no learning recorded'
    )
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

describe('foldLiveness (SMI-6967 H-9 rewrite: three-way, object return)', () => {
  it('starts at 0, not-yet-armed, with no prior entry and no observation this run', () => {
    const fold = foldLiveness(null, null, null)
    expect(fold.consecutiveNoLearning).toBe(0)
    expect(fold.everLearned).toBe(false)
    expect(fold.lastObservedPatternsLearned).toBeNull()
    expect(fold.lastObservedTrajectoriesRecorded).toBeNull()
  })

  it('an all-zero FIRST observation establishes the baseline but does NOT arm (nothing has produced anything yet)', () => {
    const fold = foldLiveness(null, 0, 0)
    expect(fold.everLearned).toBe(false)
    expect(fold.consecutiveNoLearning).toBe(0) // first observation, no streak yet
    expect(fold.lastObservedPatternsLearned).toBe(0)
    expect(fold.lastObservedTrajectoriesRecorded).toBe(0)
  })

  it('a long run of repeated all-zero observations never arms by itself, however many probes accumulate', () => {
    // This is the bug H-9 reports: two equal zeros used to count as
    // "unmoved" and the streak alone (not what it measures) decided whether
    // the arm fired. `everLearned` must stay false across any number of
    // zero-zero probes — only an actual positive observation arms it.
    let entry = makeEntry({
      everLearned: false,
      consecutiveNoLearning: 0,
      lastObservedPatternsLearned: null,
      lastObservedTrajectoriesRecorded: null,
    })
    for (let i = 0; i < 20; i += 1) {
      const fold = foldLiveness(entry, 0, 0)
      expect(fold.everLearned).toBe(false)
      entry = makeEntry({ ...entry, ...fold })
    }
  })

  it('arms on first observed increase above zero (dormant -> armed)', () => {
    const prior = makeEntry({
      everLearned: false,
      lastObservedPatternsLearned: 0,
      lastObservedTrajectoriesRecorded: 0,
      consecutiveNoLearning: 0,
    })
    const fold = foldLiveness(prior, 1, 0)
    expect(fold.everLearned).toBe(true)
    expect(fold.consecutiveNoLearning).toBe(0) // the value itself moved (0 -> 1), so this is a CHANGE
  })

  it('increments when both counters are unchanged from the last-observed baseline, once armed', () => {
    const prior = makeEntry({
      everLearned: true,
      lastObservedPatternsLearned: 10,
      lastObservedTrajectoriesRecorded: 2,
      consecutiveNoLearning: 3,
    })
    const fold = foldLiveness(prior, 10, 2)
    expect(fold.consecutiveNoLearning).toBe(4)
    expect(fold.everLearned).toBe(true)
  })

  it('resets to 0 when either counter moved from the last-observed baseline', () => {
    const prior = makeEntry({
      everLearned: true,
      lastObservedPatternsLearned: 10,
      lastObservedTrajectoriesRecorded: 2,
      consecutiveNoLearning: 5,
    })
    const fold = foldLiveness(prior, 11, 2)
    expect(fold.consecutiveNoLearning).toBe(0)
    expect(fold.lastObservedPatternsLearned).toBe(11) // the baseline moves to the new reading
  })

  it('a null-counters probe (not observed) does NOT reset a real streak — it carries the streak forward unchanged', () => {
    const prior = makeEntry({
      everLearned: true,
      lastObservedPatternsLearned: 10,
      lastObservedTrajectoriesRecorded: 2,
      consecutiveNoLearning: 5,
    })
    const fold = foldLiveness(prior, null, null)
    expect(fold.consecutiveNoLearning).toBe(5) // unchanged, NOT reset to 0 (the H-9 bug)
    expect(fold.everLearned).toBe(true) // still latched
    expect(fold.lastObservedPatternsLearned).toBe(10) // baseline preserved for the next REAL observation
    expect(fold.lastObservedTrajectoriesRecorded).toBe(2)
  })

  it('a null-counters probe never un-latches everLearned once armed, and never advances the streak either (nothing was observed)', () => {
    const prior = makeEntry({ everLearned: true, consecutiveNoLearning: 2 })
    const fold = foldLiveness(prior, null, null)
    expect(fold.everLearned).toBe(true)
    expect(fold.consecutiveNoLearning).toBe(2)
  })

  it('a null-counters probe with no prior baseline at all stays at a clean 0, not-armed slate', () => {
    const fold = foldLiveness(null, null, null)
    expect(fold.consecutiveNoLearning).toBe(0)
    expect(fold.everLearned).toBe(false)
  })

  // ── SMI-6967 H-1: producer presence is its OWN latch ────────────────────

  it('H-1 — producer presence latches true on first observation, independent of counters being zero', () => {
    const fold = foldLiveness(null, 0, 0, true)
    expect(fold.everProducerPresent).toBe(true)
    expect(fold.everLearned).toBe(false) // a DIFFERENT latch — unaffected
  })

  it('H-1 — producer presence stays false until actually observed true (a `false` or `null` this-probe reading never arms it)', () => {
    expect(foldLiveness(null, 0, 0, false).everProducerPresent).toBe(false)
    expect(foldLiveness(null, null, null, null).everProducerPresent).toBe(false)
    expect(foldLiveness(null, 0, 0).everProducerPresent).toBe(false) // default param value
  })

  it('H-1 — producer presence never un-latches, including across a could-not-ask probe', () => {
    const prior = makeEntry({ everProducerPresent: true })
    const fold = foldLiveness(prior, null, null, null)
    expect(fold.everProducerPresent).toBe(true)
  })

  it("H-1 — producer presence latches even when the counters are observed as zero on the SAME probe (the finding's own reported scenario)", () => {
    // Mirrors the finding's measured payload: bridge connected, 32 store
    // entries, patternsLearned=0, trajectoriesRecorded=0.
    const fold = foldLiveness(null, 0, 0, true)
    expect(fold.everProducerPresent).toBe(true)
    expect(fold.everLearned).toBe(false)
    expect(fold.consecutiveNoLearning).toBe(0) // first observation, no streak yet
  })

  // ── SMI-6967 L-1: an unvalidated external JSON value never arms a latch
  // or moves a counter — positive control paired with each negative one.

  it('L-1 — a valid non-negative integer (positive control) DOES arm everLearned and move the baseline', () => {
    const fold = foldLiveness(null, 5, 0)
    expect(fold.everLearned).toBe(true)
    expect(fold.lastObservedPatternsLearned).toBe(5)
  })

  it.each([
    ['0.5 (not an integer)', 0.5],
    ['"5" (a string)', '5'],
    ['Infinity', Infinity],
    ['true (a boolean)', true],
    ['[1] (an array)', [1]],
    ['-1 (negative)', -1],
  ])(
    'L-1 — an unvalidated patternsLearned value, %s, never arms everLearned nor moves the baseline',
    (_label, garbage) => {
      const fold = foldLiveness(null, garbage as number, 0)
      expect(fold.everLearned).toBe(false)
      expect(fold.lastObservedPatternsLearned).toBeNull()
    }
  )

  it('L-1 — the same garbage values on trajectoriesRecorded are equally rejected', () => {
    const fold = foldLiveness(null, 0, 0.5)
    expect(fold.everLearned).toBe(false)
    expect(fold.lastObservedTrajectoriesRecorded).toBeNull()
  })

  // ── SMI-6967 M-5: a counter regression is its own signal ────────────────

  it('M-5 — a counter DECREASE resets the streak to 0 AND sets countersRegressed, distinct from ordinary progress (also streak-resetting but NOT regressed)', () => {
    const prior = makeEntry({
      lastObservedPatternsLearned: 10,
      lastObservedTrajectoriesRecorded: 2,
      consecutiveNoLearning: 5,
    })
    const decreased = foldLiveness(prior, 9, 2)
    expect(decreased.consecutiveNoLearning).toBe(0)
    expect(decreased.countersRegressed).toBe(true)

    const increased = foldLiveness(prior, 11, 2)
    expect(increased.consecutiveNoLearning).toBe(0)
    expect(increased.countersRegressed).toBe(false) // progress, not regression — same streak reset, different flag
  })

  it('M-5 — a regression on EITHER axis alone is still a regression', () => {
    const prior = makeEntry({
      lastObservedPatternsLearned: 10,
      lastObservedTrajectoriesRecorded: 2,
    })
    expect(foldLiveness(prior, 10, 1).countersRegressed).toBe(true) // only T decreased
    expect(foldLiveness(prior, 9, 2).countersRegressed).toBe(true) // only P decreased
  })

  it('M-5 — a non-observed probe (both null) is never reported as a regression', () => {
    const prior = makeEntry({
      lastObservedPatternsLearned: 10,
      lastObservedTrajectoriesRecorded: 2,
    })
    expect(foldLiveness(prior, null, null).countersRegressed).toBe(false)
  })

  // ── SMI-6967 M-5: a partial read (one axis valid, the other not) is
  // handled on its own terms, not collapsed into a full non-observation.

  it("M-5 — a partial read (patternsLearned valid, trajectoriesRecorded null) updates ONLY the read axis's baseline", () => {
    const prior = makeEntry({
      lastObservedPatternsLearned: 10,
      lastObservedTrajectoriesRecorded: 2,
    })
    const fold = foldLiveness(prior, 10, null)
    expect(fold.lastObservedPatternsLearned).toBe(10) // read, unchanged from baseline
    expect(fold.lastObservedTrajectoriesRecorded).toBe(2) // NOT read — carried forward, not discarded
  })

  it('M-5 — a partial read where the READ axis is unchanged still advances the streak (the unread axis agrees trivially)', () => {
    const prior = makeEntry({
      lastObservedPatternsLearned: 10,
      lastObservedTrajectoriesRecorded: 2,
      consecutiveNoLearning: 3,
    })
    const fold = foldLiveness(prior, 10, null)
    expect(fold.consecutiveNoLearning).toBe(4)
  })

  it('M-5 — a partial read where the READ axis moved resets the streak, even though the other axis was not read', () => {
    const prior = makeEntry({
      lastObservedPatternsLearned: 10,
      lastObservedTrajectoriesRecorded: 2,
      consecutiveNoLearning: 3,
    })
    const fold = foldLiveness(prior, 11, null)
    expect(fold.consecutiveNoLearning).toBe(0)
    expect(fold.lastObservedPatternsLearned).toBe(11)
    expect(fold.lastObservedTrajectoriesRecorded).toBe(2) // untouched
  })

  // ── SMI-6967 M-5: migrating a pre-H-9 entry seeds the baseline from its
  // own legacy reading instead of discarding it.

  it('M-5 — a pre-H-9 entry (no lastObserved* fields at all) seeds the baseline from its own legacy patternsLearned/trajectoriesRecorded reading', () => {
    const legacyEntry = makeEntry({ patternsLearned: 7, trajectoriesRecorded: 3 })
    // @ts-expect-error — simulating an on-disk entry written before H-9 added these fields
    delete legacyEntry.lastObservedPatternsLearned
    // @ts-expect-error — same, the other axis
    delete legacyEntry.lastObservedTrajectoriesRecorded
    const fold = foldLiveness(legacyEntry, 7, 3) // same reading again — should read as UNCHANGED, not a fresh first-observation
    expect(fold.consecutiveNoLearning).toBe(1) // not 0 — the legacy reading WAS the baseline
  })

  it("M-5 — an H-9-era entry's own explicit null baseline is NOT migrated (distinct from the undefined/pre-H-9 case above)", () => {
    const entry = makeEntry({
      lastObservedPatternsLearned: null,
      lastObservedTrajectoriesRecorded: null,
      patternsLearned: 7, // legacy reading present, but the baseline fields are explicitly null, not undefined
      trajectoriesRecorded: 3,
    })
    const fold = foldLiveness(entry, 7, 3) // same reading again
    expect(fold.consecutiveNoLearning).toBe(0) // treated as a FIRST observation, not "unchanged"
    expect(fold.lastObservedPatternsLearned).toBe(7)
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
