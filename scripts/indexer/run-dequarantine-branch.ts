/**
 * Indexer `dequarantine` run-type branch (SMI-5356)
 * @module scripts/indexer/run-dequarantine-branch
 *
 * Runs the SMI-5161 false-positive sweep
 * (`scripts/indexer/dequarantine-false-positives.ts:runSweep`) under the indexer
 * entrypoint so it executes in CI with the GitHub App creds, the staging/prod
 * env selector, and the shared advisory lock — instead of flipping the live
 * `quarantined` column from a dev box (no creds + auto-mode classifier block).
 *
 * Lives in its own module (not inlined in `run.ts`) for two reasons:
 *   1. `run.ts` is at the edge of the 500-line `audit:standards` gate.
 *   2. `run.ts`'s top-level `main()` self-invokes on import, so the apply-gate +
 *      audit row can only be unit-tested from a sibling that has no such side
 *      effect (see `scripts/tests/indexer/run-dequarantine-branch.test.ts`).
 *
 * The apply gate is `apply = !env.DEQUARANTINE_DRY_RUN` — NOT `!env.DRY_RUN`.
 * `DEQUARANTINE_DRY_RUN` is an independent dry-run-first failsafe defaulting
 * `true` (mirrors recheck's `RECHECK_DRY_RUN`, SMI-5166 E6): the workflow
 * `dry_run` input defaults `false`, so a misfired dispatch must never apply.
 */

import { createSupabaseAdminClient } from './_shared/supabase.ts'
import { runSweep, type SweepCounts } from './dequarantine-false-positives.ts'
import { writeIndexerAuditLog } from './indexer-audit-log.ts'
import type { IndexerEnv } from './parse-env.ts'

/** Shape returned to `run.ts` and emitted as `RunSummary.data`. */
export interface DequarantineBranchResult {
  dequarantine: SweepCounts
  dryRun: boolean
}

/**
 * Execute the false-positive sweep and write a top-level `indexer:run` audit
 * row carrying the counts (parity with the other run-types for
 * `v_indexer_health`). Errors in the sweep surface as a thrown error to `run.ts`
 * (which records `run_error` and exits 1); a partial sweep (some rows errored)
 * still returns and logs an `eventResult: 'partial'` row.
 */
export async function runDequarantineBranch(
  env: IndexerEnv,
  requestId: string
): Promise<DequarantineBranchResult> {
  const dryRun = env.DEQUARANTINE_DRY_RUN
  const counts = await runSweep({ apply: !dryRun })

  const supabase = createSupabaseAdminClient()
  await writeIndexerAuditLog(supabase, counts.errors > 0 ? 'partial' : 'success', {
    requestId,
    topics: [],
    runType: 'dequarantine',
    dryRun,
    // The sweep neither discovers nor quarantines — `found` mirrors the scoped
    // candidate count; `failed` mirrors per-row DB errors. Discovery-centric
    // fields stay zero. The real signal lives in the `dequarantine` sub-object.
    found: counts.total,
    indexed: 0,
    updated: 0,
    failed: counts.errors,
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
    cron_slot: null,
    rotation_source: 'fallback',
    discovery_path_counts: {},
    subdirectory_search: undefined,
    high_trust_fallback_hits: 0,
    dequarantine: counts,
  })

  return { dequarantine: counts, dryRun }
}
