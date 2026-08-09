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
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { startCensusHeartbeat } from '../../indexer/smi5879-census.ts'

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
