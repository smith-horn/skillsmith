/**
 * Indexer lock heartbeat (SMI-5311)
 * @module scripts/indexer/lock-heartbeat
 *
 * try_indexer_lock (migration 053/054) acquires the row-level lock once and it
 * becomes stealable after 20 min of staleness (migration 20260513000001). A
 * backfill dispatch runs up to ~5h30m — far past the 20-min window — so without
 * a periodic refresh the live holder's lock goes stale, the cron steals it, and
 * two indexers run concurrently (additive write-IO; re-pressures SMI-5310).
 *
 * This helper periodically calls the holder-scoped `refresh_indexer_lock` RPC
 * (migration 20260618000002) to bump `locked_at` while the run is still working,
 * and FAILS SAFE — it aborts an exposed `AbortSignal` when it can no longer prove
 * the lock is held, so the orchestrator can skip the IO-damaging Phase-4 upsert:
 *
 *   - `data === false`  → lock stolen (another run holds it) → abort immediately.
 *   - transient `error` → warn + retry; abort only after MAX_CONSECUTIVE_ERRORS
 *     consecutive misses (the 20-min window has likely elapsed and we cannot
 *     prove we still hold it).
 *
 * Freshness is DB-side: both the refresh and the stale check use `now()`, so app
 * clock skew is irrelevant. run.ts auto-execs `main()` on import, so the
 * heartbeat lives here as an exported, unit-testable helper.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** 5 min << the 20-min stale window — tolerates up to 3 consecutive misses. */
const HEARTBEAT_MS = 5 * 60 * 1000
/** Consecutive transient errors before we conclude the window has elapsed. */
const MAX_CONSECUTIVE_ERRORS = 3

/** Handle returned by {@link startLockHeartbeat}. */
export interface LockHeartbeat {
  /** Stop the timer and suppress any in-flight refresh callback. */
  stop(): void
  /** Aborts when the lock is provably or probably lost (steal / repeated misses). */
  readonly signal: AbortSignal
}

/**
 * Start a periodic holder-scoped lock refresh.
 *
 * @param supabase   - service-role client (same one that holds the lock)
 * @param runId      - this run's request id (the lock's `locked_by`)
 * @param intervalMs - refresh cadence (default 5 min); injectable for tests
 * @returns a {@link LockHeartbeat} — call `stop()` in the run's `finally`, and
 *          thread `signal` to the orchestrator's pre-upsert abort check.
 */
export function startLockHeartbeat(
  supabase: SupabaseClient,
  runId: string,
  intervalMs: number = HEARTBEAT_MS
): LockHeartbeat {
  const controller = new AbortController()
  let stopping = false
  let consecutiveErrors = 0

  const timer = setInterval(() => {
    if (stopping) return
    // Error-before-data ordering on the RPC result (carried from run.ts).
    void supabase.rpc('refresh_indexer_lock', { run_id: runId }).then(({ data, error }) => {
      // A late callback after stop() must not abort or log — the run is done.
      if (stopping) return
      if (error) {
        consecutiveErrors++
        console.error(
          JSON.stringify({
            event: 'lock_heartbeat_error',
            error: error.message,
            consecutive: consecutiveErrors,
            request_id: runId,
          })
        )
        // Window likely elapsed; we can no longer prove we hold the lock.
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) controller.abort()
        return
      }
      consecutiveErrors = 0
      if (data === false) {
        // Holder is no longer us → the lock was stolen → another indexer is live.
        console.error(JSON.stringify({ event: 'lock_stolen_aborting', request_id: runId }))
        controller.abort()
      }
    })
  }, intervalMs)

  // Don't keep the event loop alive on the heartbeat alone (in-flight I/O still
  // pins it). Node's setInterval handle has unref; guard for non-Node timers.
  if (typeof timer.unref === 'function') timer.unref()

  return {
    stop() {
      stopping = true
      clearInterval(timer)
    },
    signal: controller.signal,
  }
}
