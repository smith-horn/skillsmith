/**
 * SMI-5879 Wave 3 item 1: `startCensusHeartbeat` — the claim heartbeat's
 * fatal-abort-on-lost-claim path (design doc 8.3.5.2.5).
 *
 * Retro finding (sibling-implementation audit of item 3's
 * `smi5879-simulate-full.ts`, 2026-08-08): `runCensus()`'s heartbeat
 * previously called `smi5879_heartbeat` on a bare `setInterval` and only
 * ever caught a THROWN error — it never read the call's own return value, so
 * a stolen claim (which `smi5879_heartbeat` signals via a SQL NULL return,
 * not a throw) went completely undetected and the tool kept
 * populating/resolving/sealing under a claim it no longer held. This suite
 * is a pure unit test against the extracted `startCensusHeartbeat` helper
 * (fake `heartbeat` function + fake timers), not a live-Postgres test —
 * mirrors `smi5879-simulate-full.test.ts`'s own "heartbeat (SMI-5879 review
 * finding 4)" describe block, which exercises the identical fatal-abort
 * shape for item 3's own heartbeat.
 *
 * SMI-5879 checkpoint/resume round-2 review finding (Medium): a PERSISTENTLY
 * rejecting heartbeat was previously non-fatal forever. The
 * "escalates to fatal" tests below cover the fix — see
 * `startCensusHeartbeat`'s own doc comment (now in
 * smi5879-census.heartbeat.ts, split out of smi5879-census.ts for the
 * <500-line-per-file budget) for the takeoverAfterMs contract.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  startCensusHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TAKEOVER_AFTER_MS,
} from '../../indexer/smi5879-census.heartbeat.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('startCensusHeartbeat', () => {
  it('a null result (lost claim) fires onFatal exactly once and stops the timer', async () => {
    vi.useFakeTimers()
    const heartbeat = vi.fn().mockResolvedValue(null)
    const onFatal = vi.fn()

    const handle = startCensusHeartbeat(heartbeat, 'run-1', 'token-1', 1000, onFatal)

    await vi.advanceTimersByTimeAsync(1000)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(heartbeat).toHaveBeenCalledWith('run-1', 'token-1')
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal.mock.calls[0]?.[0]).toContain('heartbeat lost for run_id=run-1')

    // The timer must have stopped itself — no further ticks call heartbeat again.
    await vi.advanceTimersByTimeAsync(5000)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(onFatal).toHaveBeenCalledTimes(1)

    handle.stop()
  })

  it('a rejected heartbeat call is logged but NOT fatal, and ticking continues', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient network failure'))
      .mockResolvedValue('2026-08-08T00:00:00.000Z')
    const onFatal = vi.fn()

    const handle = startCensusHeartbeat(heartbeat, 'run-2', 'token-2', 1000, onFatal)

    await vi.advanceTimersByTimeAsync(1000)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(onFatal).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('heartbeat failed: transient network failure')
    )

    await vi.advanceTimersByTimeAsync(1000)
    expect(heartbeat).toHaveBeenCalledTimes(2)
    expect(onFatal).not.toHaveBeenCalled()

    handle.stop()
    errorSpy.mockRestore()
  })

  it('SMI-5879 checkpoint/resume round-2: a PERSISTENTLY rejecting heartbeat escalates to fatal once staleness reaches takeoverAfterMs, not before', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const heartbeat = vi.fn().mockRejectedValue(new Error('persistent EMFILE'))
    const onFatal = vi.fn()

    // intervalMs=1000, takeoverAfterMs=3000 — staleness crosses the
    // threshold on the 3rd tick (3000ms since the last, and only, success
    // at t=0), not the 1st or 2nd.
    const handle = startCensusHeartbeat(heartbeat, 'run-6', 'token-6', 1000, onFatal, 3000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(onFatal).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(onFatal).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal.mock.calls[0]?.[0]).toContain('heartbeat has not succeeded in')
    expect(onFatal.mock.calls[0]?.[0]).toContain('run-6')

    // The timer must have stopped itself — no further ticks call heartbeat again.
    await vi.advanceTimersByTimeAsync(5000)
    expect(onFatal).toHaveBeenCalledTimes(1)

    handle.stop()
    errorSpy.mockRestore()
  })

  it("SMI-5879 checkpoint/resume round-2: a heartbeat that recovers BEFORE the takeover threshold resets the staleness clock — later failures do not inherit the earlier ones' elapsed time", async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(new Error('blip 1'))
      .mockResolvedValueOnce('2026-08-08T00:00:01.000Z') // recovers at t=2000 — resets lastSuccessAtMs
      .mockRejectedValue(new Error('blip 2 onward'))
    const onFatal = vi.fn()

    const handle = startCensusHeartbeat(heartbeat, 'run-7', 'token-7', 1000, onFatal, 3000)

    await vi.advanceTimersByTimeAsync(1000) // t=1000: reject (staleness 1000, no fire)
    expect(onFatal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000) // t=2000: SUCCESS — resets the clock
    expect(onFatal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000) // t=3000: reject (staleness since t=2000 is only 1000)
    expect(onFatal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000) // t=4000: reject (staleness 2000)
    expect(onFatal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000) // t=5000: reject (staleness 3000 since the t=2000 success) — fires now
    expect(onFatal).toHaveBeenCalledTimes(1)

    handle.stop()
    errorSpy.mockRestore()
  })

  it('stop() suppresses a late-resolving in-flight call — no onFatal fires after intentional stop', async () => {
    vi.useFakeTimers()
    let resolveHeartbeat: (v: string | null) => void = () => {}
    const pending = new Promise<string | null>((resolve) => {
      resolveHeartbeat = resolve
    })
    const heartbeat = vi.fn().mockReturnValueOnce(pending)
    const onFatal = vi.fn()

    const handle = startCensusHeartbeat(heartbeat, 'run-3', 'token-3', 1000, onFatal)

    await vi.advanceTimersByTimeAsync(1000)
    expect(heartbeat).toHaveBeenCalledTimes(1)

    // Caller stops the heartbeat (e.g. runCensus()'s finally block) BEFORE
    // the in-flight call settles.
    handle.stop()

    // The in-flight call now resolves to null (lost claim) — but since stop()
    // already fired, this must be a no-op: no fatal-abort for a run that has
    // already finished.
    resolveHeartbeat(null)
    await vi.advanceTimersByTimeAsync(5000)
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('does not fire a second overlapping call while the previous call is still pending', async () => {
    vi.useFakeTimers()
    let resolveFirst: (v: string | null) => void = () => {}
    const firstPromise = new Promise<string | null>((resolve) => {
      resolveFirst = resolve
    })
    const heartbeat = vi
      .fn()
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValue('2026-08-08T00:00:00.000Z')
    const onFatal = vi.fn()

    const handle = startCensusHeartbeat(heartbeat, 'run-4', 'token-4', 1000, onFatal)

    await vi.advanceTimersByTimeAsync(1000)
    expect(heartbeat).toHaveBeenCalledTimes(1)

    // setInterval keeps firing regardless of in-flight state — but the
    // in-flight first call resolving null LATE (after a second tick already
    // started) must still only be actionable once, and a second tick
    // starting a second call is expected setInterval behavior (unlike item
    // 3's self-rescheduling setTimeout loop) since smi5879_heartbeat's own
    // UPDATE is idempotent/commutative — concurrent heartbeat calls carry no
    // local-state corruption risk (design doc 8.3.5.2.5), so this tool
    // deliberately keeps the design doc's literal `setInterval` shape rather
    // than adopting item 3's stronger (but here unnecessary) non-overlap
    // guarantee.
    await vi.advanceTimersByTimeAsync(1000)
    expect(heartbeat).toHaveBeenCalledTimes(2)

    resolveFirst('2026-08-08T00:00:00.000Z')
    handle.stop()
  })

  it('production default onFatal logs and calls process.exit(1)', async () => {
    vi.useFakeTimers()
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as typeof process.exit)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const heartbeat = vi.fn().mockResolvedValue(null)

    startCensusHeartbeat(heartbeat, 'run-5', 'token-5', 1000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[smi5879-census] FATAL: heartbeat lost for run_id=run-5')
    )

    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

describe("migration's documented ordering invariant (SMI-5879 cross-model review round-4/5, Medium)", () => {
  // SMI-5879 round-5 confirmation review finding: the round-4 version of
  // this test hardcoded GC_STALE_AFTER_MS/GC_GRACE_PERIOD_MS as static
  // mirrors of the two SQL literals — the arithmetic itself was correct,
  // but a future change to EITHER SQL literal (e.g. `smi5879_gc_force_
  // abandon`'s `p_stale_after` default shortened to 20 minutes) would
  // silently invert the invariant with this test still green, since it was
  // only ever comparing the mirror against itself. Read LIVE from the
  // actual migration file instead — same `readFileSync` pattern
  // `smi5879-census.test-helpers.ts`'s `resetSchema` already uses to load
  // the shipped SQL rather than a hand-copied duplicate — so a drift in
  // either literal is caught here, not just documented as a risk.
  const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260808000000_smi5879_snapshot_generations.sql'
  )
  const migrationText = readFileSync(migrationPath, 'utf8')

  /** Parses a Postgres interval literal of the exact shape this migration uses ('N hours' / 'N minutes') to milliseconds. */
  function intervalLiteralToMs(literal: string): number {
    const match = /^(\d+)\s+(hours?|minutes?)$/.exec(literal.trim())
    if (!match) {
      throw new Error(
        `SMI-5879 test: cannot parse interval literal '${literal}' — expected the exact ` +
          "'N hours'/'N minutes' shape this migration uses; extend intervalLiteralToMs if the " +
          'migration starts using a different unit.'
      )
    }
    const [, numStr, unit] = match
    // SMI-5879 coordinator review (2026-08-30): under noUncheckedIndexedAccess,
    // destructuring a RegExpExecArray types each capture group as
    // `string | undefined`, even though the outer regex match above already
    // guarantees both groups matched. Guard rather than assert, matching this
    // helper's own throw-with-diagnostic style used elsewhere in this file.
    if (numStr === undefined || unit === undefined) {
      throw new Error(
        `SMI-5879 test: interval literal '${literal}' matched the outer pattern but one of its ` +
          'capture groups is undefined — this should be structurally impossible given the regex, ' +
          'investigate before trusting this parse.'
      )
    }
    return Number(numStr) * (unit.startsWith('hour') ? 60 * 60_000 : 60_000)
  }

  function extractInterval(pattern: RegExp, label: string): number {
    const match = pattern.exec(migrationText)
    if (!match?.[1]) {
      throw new Error(
        `SMI-5879 test: could not find ${label} in ${migrationPath} — the migration text no ` +
          "longer matches this test's extraction pattern. Update the pattern (do not just " +
          'hardcode a value) so this test keeps reading the ACTUAL SQL default, not a mirror.'
      )
    }
    return intervalLiteralToMs(match[1])
  }

  // `smi5879_gc_force_abandon`'s own DEFAULT parameter (SECTION 7):
  //   p_stale_after    interval DEFAULT interval '2 hours'
  const GC_STALE_AFTER_MS = extractInterval(
    /p_stale_after\s+interval\s+DEFAULT\s+interval\s+'([^']+)'/,
    "smi5879_gc_force_abandon's p_stale_after DEFAULT"
  )
  // smi5879_snapshot_guard()'s hardcoded 24h grace period (SECTION 4):
  //   IF v_abandoned_at IS NULL OR v_abandoned_at > now() - interval '24 hours' THEN
  const GC_GRACE_PERIOD_MS = extractInterval(
    /v_abandoned_at > now\(\) - interval '([^']+)'/,
    'the 24h GC grace period in smi5879_snapshot_guard()'
  )

  it('HEARTBEAT_INTERVAL x 10 <= TAKEOVER_AFTER < GC_STALE_AFTER, and GC_STALE_AFTER x 4 <= GC_GRACE_PERIOD', () => {
    // The migration's own SECTION 7 comment claims this exact arithmetic
    // relationship is "CI-asserted, scripts/tests/indexer/smi5879-census.
    // test.ts" — it was not actually asserted anywhere in the repo until
    // this test (confirmed by grep before writing it). Restoring it matters
    // more now than when the migration was first written: HEARTBEAT_
    // TAKEOVER_AFTER_MS became the AUTHORITATIVE value (round 3, explicitly
    // passed to smi5879_claim_run) rather than mere documentation of the SQL
    // default — a future change to it with no guard could silently invert
    // "takeover is always reachable before GC." Both GC_* values are read
    // LIVE from the migration text above, so a change on the SQL side is
    // caught too, not just a change on the TS side.
    expect(HEARTBEAT_INTERVAL_MS * 10).toBeLessThanOrEqual(HEARTBEAT_TAKEOVER_AFTER_MS)
    expect(HEARTBEAT_TAKEOVER_AFTER_MS).toBeLessThan(GC_STALE_AFTER_MS)
    expect(GC_STALE_AFTER_MS * 4).toBeLessThanOrEqual(GC_GRACE_PERIOD_MS)
  })

  it('sanity: the extracted SQL-literal defaults are what the migration is currently expected to document (30min / 2h / 24h)', () => {
    // Not a tautology (round-5 finding on the PRIOR version of this test):
    // HEARTBEAT_TAKEOVER_AFTER_MS is imported from source, and the other two
    // are freshly parsed from the migration file's own text above, not
    // locally-defined values being compared to themselves.
    expect(HEARTBEAT_TAKEOVER_AFTER_MS).toBe(30 * 60_000)
    expect(GC_STALE_AFTER_MS).toBe(2 * 60 * 60_000)
    expect(GC_GRACE_PERIOD_MS).toBe(24 * 60 * 60_000)
  })
})
