/**
 * Claim heartbeat for smi5879-census.ts (design doc 8.3.5.2.5).
 * @module scripts/indexer/smi5879-census.heartbeat
 *
 * Split out of smi5879-census.ts (CLAUDE.md's <500-line-per-file budget —
 * the SMI-5879 checkpoint/resume follow-up's own additions pushed that file
 * over) — no logical boundary change, same code `runCensus()` already called.
 */

/** Exported (round-4 cross-model review) so `smi5879-census.heartbeat.test.ts` can assert the migration's own documented HEARTBEAT_INTERVAL/TAKEOVER_AFTER/GC_STALE_AFTER/GC_GRACE_PERIOD ordering invariant against these actual constants. */
export const HEARTBEAT_INTERVAL_MS = 60_000
/**
 * SMI-5879 checkpoint/resume round-3 (cross-model review, High): passed
 * EXPLICITLY to `smi5879_claim_run` (`smi5879-census.resume.ts`'s
 * `obtainClaimedRun`) rather than relying on that function's own DEFAULT
 * interval '30 minutes' staying in sync by comment convention — this
 * constant is now the AUTHORITATIVE value on both sides, not merely a
 * mirror of the SQL default. {@link startCensusHeartbeat} uses the SAME
 * constant to escalate a PERSISTENTLY failing (thrown/rejected, not
 * NULL-returning) heartbeat to fatal once it has gone stale long enough
 * that the claim is provably stealable.
 *
 * ORDERING INVARIANT (round-4 cross-model review, Medium): the migration's
 * SECTION 7 comment claims "Invariant (CI-asserted, scripts/tests/indexer/
 * smi5879-census.test.ts): HEARTBEAT_INTERVAL x 10 <= TAKEOVER_AFTER <
 * GC_STALE_AFTER, and GC_STALE_AFTER x 4 <= GC_GRACE_PERIOD" — that
 * assertion did not actually exist anywhere in this repo (confirmed by
 * grep) until `smi5879-census.heartbeat.test.ts`'s "migration's documented
 * ordering invariant" test restored it. This constant now being the
 * authoritative value (not just documentation of the SQL default) makes
 * that gap matter more than it did pre-round-3: raising this past
 * `smi5879_gc_force_abandon`'s own `p_stale_after` default (2h, still a
 * bare SQL literal, never passed explicitly) would make GC's force-abandon
 * reachable BEFORE takeover — inverting the migration's own stated
 * "takeover — which is recoverable — is always reachable before GC, which
 * is not."
 */
export const HEARTBEAT_TAKEOVER_AFTER_MS = 30 * 60_000

/** Handle returned by {@link startCensusHeartbeat}. */
export interface CensusHeartbeat {
  /** Stop the timer and suppress any in-flight tick's fatal-abort/error logging. */
  stop(): void
}

/**
 * Start the claim's independent heartbeat (design doc 8.3.5.2.5): calls
 * `heartbeat(runId, token)` on a fixed interval. A `null` return means the
 * claim was stolen or the run was abandoned — design doc 8.3.5.2.5 states
 * this is "fatal and immediate: the runner stops fetching, stops writing
 * checkpoints... and exits non-zero. It must not attempt to re-claim" — so
 * `onFatal` fires and the timer stops itself; the caller must not re-claim.
 *
 * SMI-5879 retro finding (sibling-implementation audit, 2026-08-08): this
 * runner previously called `smi5879_heartbeat` on a bare `setInterval` and
 * only ever caught a THROWN error — it never read the call's own return
 * value, so a stolen claim (which `smi5879_heartbeat` signals by returning
 * SQL NULL, not by throwing — see
 * `smi5879-census.claim-gc.test.ts`'s "heartbeat returns NULL for a
 * stolen/mismatched token" case, which asserts the DB function's half of
 * this contract) went completely undetected: this tool would keep
 * populating/resolving branches/sealing under a claim it no longer actually
 * held. Extracted as its own exported, unit-testable function — mirroring
 * `lock-heartbeat.ts`'s `startLockHeartbeat` (SMI-5311), which exists for
 * the identical "auto-execing main() on import" testability reason — so the
 * fatal-abort path can be exercised with a fake `heartbeat` function and
 * fake timers instead of a live Postgres claim-theft race.
 *
 * `takeoverAfterMs` (SMI-5879 checkpoint/resume round-2 review, Medium): a
 * thrown/rejected `heartbeat` call is non-fatal (log + retry) ONLY until
 * `takeoverAfterMs` has elapsed since the last SUCCESSFUL heartbeat — at
 * that point `smi5879_claim_run`'s own CAS makes this claim legitimately
 * stealable (e.g. by `--resume`), so this process must stop writing rather
 * than keep silently retrying a heartbeat that can no longer protect it.
 * Before `--resume` existed a persistently-failing heartbeat (e.g. the
 * `EMFILE`/`EAGAIN` transient OS-resource exhaustion `smi5879-census.pg.ts`'s
 * header documents as realistic under this tool's tens-of-thousands-of-
 * subprocess branch-resolution pass) was non-fatal forever — low-stakes when
 * nobody else could ever contend for the same run_id, not so once they can.
 */
export function startCensusHeartbeat(
  heartbeat: (runId: string, token: string) => Promise<string | null>,
  runId: string,
  token: string,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  onFatal: (message: string) => void = (message) => {
    console.error(`[smi5879-census] FATAL: ${message} Exiting without re-claiming.`)
    process.exit(1)
  },
  takeoverAfterMs: number = HEARTBEAT_TAKEOVER_AFTER_MS
): CensusHeartbeat {
  let stopped = false
  let lastSuccessAtMs = Date.now()
  const timer = setInterval(() => {
    if (stopped) return
    void heartbeat(runId, token)
      .then((result) => {
        // A late callback after stop() must not fire — the run is done.
        if (stopped) return
        if (result === null) {
          stopped = true
          clearInterval(timer)
          onFatal(
            `heartbeat lost for run_id=${runId} — claim was stolen or the run was abandoned ` +
              '(design doc 8.3.5.2.5).'
          )
          return
        }
        lastSuccessAtMs = Date.now()
      })
      .catch((err) => {
        if (stopped) return
        console.error(`[smi5879-census] heartbeat failed: ${(err as Error).message}`)
        const staleMs = Date.now() - lastSuccessAtMs
        if (staleMs >= takeoverAfterMs) {
          stopped = true
          clearInterval(timer)
          onFatal(
            `heartbeat has not succeeded in ${Math.round(staleMs / 60_000)}min for run_id=${runId} — ` +
              `at/past the ${Math.round(takeoverAfterMs / 60_000)}min takeover threshold, this claim is ` +
              'now provably stealable by another process (e.g. via --resume). Stopping rather than risk ' +
              'writing under a claim that may no longer be exclusively held.'
          )
        }
      })
  }, intervalMs)
  // Don't keep the event loop alive on the heartbeat alone (in-flight I/O still
  // pins it). Node's setInterval handle has unref; guard for non-Node timers.
  timer.unref?.()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
