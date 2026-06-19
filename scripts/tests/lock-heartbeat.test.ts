/**
 * SMI-5311: Unit tests for the indexer lock heartbeat.
 *
 * The heartbeat is the SAFETY CONTRACT that keeps a long backfill dispatch
 * (~5h30m) from letting its 20-min-stale lock get stolen by the cron — and, if
 * it IS stolen, from double-writing on top of the thief. These tests prove:
 *
 *   - refresh_indexer_lock is called once per interval (the refresh actually
 *     fires on the timer).
 *   - `data === false` (lock stolen) aborts the signal and logs
 *     `lock_stolen_aborting` immediately.
 *   - a transient `error` aborts ONLY after 3 consecutive misses (one or two
 *     misses, then a success, must not abort — fail safe, not fail twitchy).
 *   - `stop()` clears the timer and suppresses a late in-flight callback — no
 *     spurious abort or log after the run has released the lock.
 *
 * Fake timers drive the interval; the Supabase client is a hand-rolled double
 * whose only method is `rpc`, a vi.fn returning a configurable result. A
 * deferred promise lets the late-callback test resolve an rpc AFTER stop().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { startLockHeartbeat } from '../indexer/lock-heartbeat.ts'

/** Shape of a Supabase RPC result the heartbeat reads (error-before-data). */
type RpcResult = { data: unknown; error: { message: string } | null }

/** A Supabase double exposing only `rpc`. The spy returns a configured result. */
function makeSupabase(rpc: ReturnType<typeof vi.fn>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient
}

const RUN_ID = 'req-5311'
const INTERVAL = 5 * 60 * 1000

describe('startLockHeartbeat (SMI-5311)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    errorSpy.mockRestore()
    vi.useRealTimers()
  })

  it('calls refresh_indexer_lock once per interval', async () => {
    const rpc = vi.fn(async (): Promise<RpcResult> => ({ data: true, error: null }))
    const hb = startLockHeartbeat(makeSupabase(rpc), RUN_ID, INTERVAL)

    expect(rpc).not.toHaveBeenCalled() // nothing fires before the first tick

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenLastCalledWith('refresh_indexer_lock', { run_id: RUN_ID })

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(rpc).toHaveBeenCalledTimes(2)

    expect(hb.signal.aborted).toBe(false) // healthy refreshes never abort
    hb.stop()
  })

  it('aborts and logs lock_stolen_aborting when data === false', async () => {
    const rpc = vi.fn(async (): Promise<RpcResult> => ({ data: false, error: null }))
    const hb = startLockHeartbeat(makeSupabase(rpc), RUN_ID, INTERVAL)

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(hb.signal.aborted).toBe(true)
    const logged: string[] = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(logged.some((line) => line.includes('lock_stolen_aborting'))).toBe(true)
    hb.stop()
  })

  it('aborts on transient error ONLY after 3 consecutive misses', async () => {
    const rpc = vi.fn(async (): Promise<RpcResult> => ({ data: null, error: { message: 'boom' } }))
    const hb = startLockHeartbeat(makeSupabase(rpc), RUN_ID, INTERVAL)

    await vi.advanceTimersByTimeAsync(INTERVAL) // miss 1
    expect(hb.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(INTERVAL) // miss 2
    expect(hb.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(INTERVAL) // miss 3 → abort
    expect(hb.signal.aborted).toBe(true)

    const logged: string[] = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(logged.filter((line) => line.includes('lock_heartbeat_error')).length).toBe(3)
    hb.stop()
  })

  it('resets the consecutive-error count after a successful refresh', async () => {
    const results: RpcResult[] = [
      { data: null, error: { message: 'boom' } }, // miss 1
      { data: null, error: { message: 'boom' } }, // miss 2
      { data: true, error: null }, // success → reset
      { data: null, error: { message: 'boom' } }, // miss 1 again
      { data: null, error: { message: 'boom' } }, // miss 2 again
    ]
    let i = 0
    const rpc = vi.fn(async (): Promise<RpcResult> => results[i++])
    const hb = startLockHeartbeat(makeSupabase(rpc), RUN_ID, INTERVAL)

    for (let tick = 0; tick < results.length; tick++) {
      await vi.advanceTimersByTimeAsync(INTERVAL)
    }

    // 2 + 2 misses with a reset between them never reaches 3 consecutive.
    expect(hb.signal.aborted).toBe(false)
    hb.stop()
  })

  it('stop() clears the timer and suppresses a late in-flight callback', async () => {
    // A deferred rpc that resolves only when we say so — simulates an in-flight
    // refresh that lands AFTER stop() (e.g. the run finished and released).
    let resolveRpc: (r: RpcResult) => void = () => undefined
    const pending = new Promise<RpcResult>((resolve) => {
      resolveRpc = resolve
    })
    const rpc = vi.fn(() => pending)
    const hb = startLockHeartbeat(makeSupabase(rpc), RUN_ID, INTERVAL)

    await vi.advanceTimersByTimeAsync(INTERVAL) // fires the rpc (still pending)
    expect(rpc).toHaveBeenCalledTimes(1)

    hb.stop() // run is done; the in-flight refresh must not abort/log

    // The lock was stolen while we were stopping — a naive impl would abort.
    resolveRpc({ data: false, error: null })
    await Promise.resolve() // let the .then callback run

    expect(hb.signal.aborted).toBe(false)
    const logged: string[] = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(logged.some((line) => line.includes('lock_stolen_aborting'))).toBe(false)

    // The cleared timer never fires another rpc after stop().
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
