/**
 * SMI-6246: lock-hold budget accounting and the cron-side bounded retry loop
 * that together implement ADR-140's timing invariant, plus the lock-skip
 * handler that ties them to the existing `skipped_lock` audit-log branch.
 * Extracted from run.ts to keep it under the 500-line CI gate.
 * @module scripts/indexer/run-lock-retry
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IndexerEnv } from './parse-env.ts'
import { normalizeYieldMinutes } from './parse-env.ts'
import { writeIndexerAuditLog } from './indexer-audit-log.ts'
import { buildBackfillDispatchInputs } from './backfill-dispatch-inputs.ts'

/** SMI-6246/ADR-140: cron-side bounded retry window (`R` in the invariant). */
export const LOCK_RETRY_WINDOW_MS = 22 * 60 * 1000
/** SMI-6246/ADR-140: cron-side poll interval between retry attempts. */
export const LOCK_RETRY_POLL_MS = 20 * 1000
/**
 * SMI-6246: the lock-release RPC's contribution to `H_worst` (ADR-140) must be
 * a real enforced bound, not an unstated assumption — see the implementation
 * plan's Change #1 arithmetic table.
 */
export const LOCK_RELEASE_TIMEOUT_MS = 30_000

/**
 * SMI-6246: releases the lock with an explicit timeout, retrying once on a
 * timeout before giving up. Never throws — a failed/timed-out release still
 * falls through to the existing 20-minute stale-TTL crash-recovery path
 * (`try_indexer_lock`'s own staleness check), so this doesn't need new
 * recovery machinery, only a bounded attempt before relying on that fallback.
 */
export async function releaseLockWithTimeout(
  supabase: SupabaseClient,
  runId: string,
  timeoutMs = LOCK_RELEASE_TIMEOUT_MS
): Promise<{ error: string | null }> {
  const attempt = async (): Promise<{ error: string | null }> => {
    try {
      const releasePromise = supabase.rpc('release_indexer_lock', { run_id: runId })
      const result = await Promise.race([
        releasePromise,
        new Promise<{ error: { message: string } }>((resolve) =>
          setTimeout(() => resolve({ error: { message: 'lock release timed out' } }), timeoutMs)
        ),
      ])
      return { error: result.error ? result.error.message : null }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Unknown release error' }
    }
  }
  const first = await attempt()
  if (!first.error) {
    return first
  }
  return attempt()
}

/**
 * SMI-6246: the crawl loop's remaining elapsed-ms budget, anchored at lock
 * acquisition (not crawl-loop start, per round-1 review) so prefetch/setup
 * time and the `try_indexer_lock` RPC's own round-trip latency both count
 * against the stated ceiling. Never resolves to the literal `0` that
 * `subdirectory-search.helpers.ts` treats as "disabled/unbounded" — a `0`
 * result here would silently reopen the exact bug this change closes.
 */
export function computeRemainingElapsedMs(params: {
  backfillMaxElapsedMinutes: number
  yieldCeilingMinutes: number
  lockAcquireAttemptedAt: number
  now?: () => number
}): number {
  const now = params.now ?? Date.now
  const yieldCeiling = normalizeYieldMinutes(params.yieldCeilingMinutes)
  const effectiveMaxElapsedMinutes =
    params.backfillMaxElapsedMinutes > 0
      ? Math.min(params.backfillMaxElapsedMinutes, yieldCeiling)
      : yieldCeiling
  const elapsedSinceLock = now() - params.lockAcquireAttemptedAt
  return Math.max(1000, effectiveMaxElapsedMinutes * 60_000 - elapsedSinceLock)
}

/**
 * SMI-6246/ADR-140: bounded retry loop for a lock-skipped acquisition attempt.
 * Guarantees a final attempt at (never after) the deadline — the invariant's
 * proof requires this; a loop that merely stops whenever its last sleep
 * happens to land is not covered by it. Never applied to backfill's own
 * acquisition (see {@link isBackfillAcquisition}) — those dispatches are
 * already GHA-serialized against each other via the `skill-indexer-backfill`
 * concurrency group.
 */
export async function retryAcquireLock(
  supabase: SupabaseClient,
  runId: string,
  opts: {
    windowMs?: number
    pollMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  } = {}
): Promise<{ acquired: boolean; error: string | null }> {
  const windowMs = opts.windowMs ?? LOCK_RETRY_WINDOW_MS
  const pollMs = opts.pollMs ?? LOCK_RETRY_POLL_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + windowMs

  for (;;) {
    const result = await supabase.rpc('try_indexer_lock', { run_id: runId })
    if (result.error) {
      return { acquired: false, error: result.error.message }
    }
    if (result.data) {
      return { acquired: true, error: null }
    }
    const remaining = deadline - now()
    if (remaining <= 0) {
      return { acquired: false, error: null }
    }
    await sleep(Math.min(pollMs, remaining))
  }
}

/** SMI-6246: backfill's own acquisition never retries — see {@link retryAcquireLock}. */
export function isBackfillAcquisition(
  env: Pick<IndexerEnv, 'RUN_TYPE' | 'BACKFILL_MODE'>
): boolean {
  return env.RUN_TYPE === 'discovery' && env.BACKFILL_MODE
}

/**
 * Handles a failed initial `try_indexer_lock` attempt: retries (unless this is
 * backfill's own acquisition), and on final failure writes the existing
 * `skipped_lock` audit row — extended, for backfill dispatches only, with
 * `github_run_id`/`resumed_from`/`dispatch_inputs` so the auto-chain watcher
 * can recover this failed attempt's own recorded intent (change #3 of the
 * SMI-6246 plan) rather than guessing from a global "latest" lookup.
 *
 * Never returns when the lock could not be acquired — it calls
 * `process.exit(0)` (benign skip) or `process.exit(1)` (RPC hard failure)
 * itself, matching `main()`'s pre-existing behavior exactly. Returns
 * `{ acquired: true }` only when a retry succeeded, so the caller can fall
 * through into the normal acquire path unmodified.
 */
export async function handleLockSkip(
  supabase: SupabaseClient,
  env: IndexerEnv,
  requestId: string
): Promise<{ acquired: true }> {
  console.log(
    JSON.stringify({
      event: 'lock_held_by_other_run',
      request_id: requestId,
    })
  )

  // SMI-6246 kill switch: INDEXER_LOCK_RETRY_DISABLE reverts the skip branch
  // to today's exact instant single-attempt behavior. Registered in
  // docs/internal/process/guards-and-opt-outs.md.
  const retryDisabled = process.env.INDEXER_LOCK_RETRY_DISABLE === '1'

  let acquired = false
  if (!isBackfillAcquisition(env) && !retryDisabled) {
    const retryResult = await retryAcquireLock(supabase, requestId)
    if (retryResult.error) {
      console.error(
        JSON.stringify({
          event: 'lock_rpc_error',
          error: retryResult.error,
          request_id: requestId,
        })
      )
      process.exit(1)
    }
    acquired = retryResult.acquired
  }

  if (acquired) {
    return { acquired: true }
  }

  // SMI-4870 issue #1: write a minimal audit_logs row so per-phase sub-slot
  // skips are observable via SQL (GROUP BY discovery_phase, status). The meta
  // shape mirrors the Phase 7 row written by writeDiscoveryAuditLog — only
  // fields available without running any phase are populated. Assigning to a
  // typed intermediate lets the extra keys survive the excess-property check
  // (same pattern the original inline branch used).
  const skipMeta = {
    request_id: requestId,
    run_type: env.RUN_TYPE,
    rate_limit_remaining_min: 0,
    // SMI-4918: lock-skipped runs make no GitHub calls — zero every bucket.
    core_remaining_min: 0,
    search_remaining_min: 0,
    code_search_remaining_min: 0,
    secondary_rate_limit_hits: 0,
    retry_after_max_seconds: 0,
    concurrency: env.concurrency,
    kill_switch_engaged: env.kill_switch_engaged,
    topics: [],
    cron_slot: env.CRON_SLOT,
    rotation_source: 'fallback' as const,
    tree_hash_cache_hits: 0,
    tree_hash_cache_misses: 0,
    // SMI-4870: observability keys — status marks the skip; discovery_phase
    // identifies which per-phase sub-slot was blocked.
    status: 'skipped_lock' as const,
    discovery_phase: env.DISCOVERY_PHASE ?? null,
    // SMI-6246: backfill-only continuation breadcrumbs (see module docstring).
    ...(isBackfillAcquisition(env)
      ? {
          github_run_id: process.env.GITHUB_RUN_ID ?? null,
          resumed_from: process.env.RESUME_FROM ?? null,
          dispatch_inputs: buildBackfillDispatchInputs(env),
        }
      : {}),
  }

  await writeIndexerAuditLog(supabase, 'success', {
    requestId,
    topics: [],
    runType: env.RUN_TYPE,
    dryRun: env.DRY_RUN,
    found: 0,
    indexed: 0,
    updated: 0,
    failed: 0,
    stale: 0,
    quality_gate_filtered: 0,
    unchanged: 0,
    quarantined: 0,
    github_skill_count: 0,
    code_search: undefined,
    scoreDistribution: { highTrust: 0, community: 0, scores: [] },
    categorizedCount: 0,
    categoryAssignments: 0,
    wildcard_expansion_count: 0,
    cron_slot: env.CRON_SLOT,
    rotation_source: 'fallback',
    discovery_path_counts: {},
    subdirectory_search: undefined,
    high_trust_fallback_hits: 0,
    meta: skipMeta,
  })
  process.exit(0)
}
