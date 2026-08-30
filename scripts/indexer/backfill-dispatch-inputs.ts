/**
 * SMI-6246: campaign-defining backfill dispatch inputs, echoed into both the
 * backfill checkpoint (on real progress) and the lock-skip audit row (on a
 * lost lock race) so the `indexer-backfill-autochain.yml` watcher can recover
 * a failed attempt's own recorded intent instead of guessing from a
 * globally-"latest" lookup. See docs/internal/implementation/
 * indexer-backfill-lock-yield-plan.md, change #3, and ADR-140.
 * @module scripts/indexer/backfill-dispatch-inputs
 */

import type { IndexerEnv } from './parse-env.ts'

/**
 * Every `indexer-backfill.yml` `workflow_dispatch` input that defines what a
 * campaign actually crawls, minus `resume_from`/`kill_switch` (never replayed)
 * and `dry_run` (already a top-level field on the checkpoint payload).
 * `maxSkillsPerRepo`/`supabaseEnv`/`tokenSource` are not part of {@link IndexerEnv}
 * — they're read directly from `process.env` since the workflow maps them to
 * job-level env vars (`BACKFILL_MAX_SKILLS_PER_REPO`, `SUPABASE_ENV`,
 * `TOKEN_SOURCE`) rather than through `parse-env.ts`'s centralized parsing.
 */
export interface BackfillDispatchInputs {
  maxSkillsPerRepo: string
  pathPrefix: string
  maxRanges: number
  minSizeBytes: number
  maxSkillsPerDispatch: number
  maxElapsedMinutes: number
  acceptTruncation: boolean
  supabaseEnv: string
  tokenSource: string
}

/**
 * Builds the dispatch-inputs echo from the current process's own environment.
 * Safe to call for any backfill dispatch, whether it goes on to make real
 * progress (checkpoint) or lock-skips immediately (audit row) — every field
 * is read from `env`/`process.env`, never from a DB round-trip.
 */
export function buildBackfillDispatchInputs(env: IndexerEnv): BackfillDispatchInputs {
  return {
    maxSkillsPerRepo: process.env.BACKFILL_MAX_SKILLS_PER_REPO ?? '50',
    pathPrefix: env.BACKFILL_PATH_PREFIX ?? '',
    maxRanges: env.BACKFILL_MAX_RANGES,
    minSizeBytes: env.BACKFILL_MIN_SIZE_BYTES,
    maxSkillsPerDispatch: env.BACKFILL_MAX_SKILLS_PER_DISPATCH,
    maxElapsedMinutes: env.BACKFILL_MAX_ELAPSED_MINUTES,
    acceptTruncation: env.BACKFILL_ACCEPT_TRUNCATION,
    supabaseEnv: process.env.SUPABASE_ENV ?? 'prod',
    tokenSource: process.env.TOKEN_SOURCE ?? 'backfill',
  }
}
