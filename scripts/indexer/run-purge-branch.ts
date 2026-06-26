/**
 * Indexer `purge` run-type branch (SMI-5357)
 * @module scripts/indexer/run-purge-branch
 *
 * Runs the SMI-5167 dead-quarantine purge
 * (`scripts/indexer/purge-dead-quarantines.ts:runPurge`) under the indexer
 * entrypoint so it executes in CI with the shared advisory lock — instead of
 * running ad-hoc from a dev box (which carries auto-mode classifier risk for
 * destructive prod mutations).
 *
 * Lives in its own module (not inlined in `run.ts`) for two reasons:
 *   1. `run.ts` is at the edge of the 500-line `audit:standards` gate.
 *   2. `run.ts`'s top-level `main()` self-invokes on import, so the apply-gate +
 *      audit row can only be unit-tested from a sibling with no such side effect
 *      (see `scripts/tests/indexer/run-purge-branch.test.ts`).
 *
 * The apply gate is `apply = !env.PURGE_DRY_RUN` — NOT `!env.DRY_RUN`.
 * `PURGE_DRY_RUN` is an independent dry-run-first failsafe defaulting `true`
 * (mirrors DEQUARANTINE_DRY_RUN, SMI-5356): the workflow `dry_run` input
 * defaults `false`, so a misfired dispatch must never delete prod rows.
 *
 * Error model: `runPurge` throws on export-integrity failure or batch-delete
 * failure. Those errors surface to `run.ts` which records `run_error` and exits
 * 1. There is no partial-error tally (unlike the sweep) because batch failures
 * throw rather than tallying, so `writeIndexerAuditLog` is only reached on a
 * clean run.
 */

import { createSupabaseAdminClient } from './_shared/supabase.ts'
import { runPurge, type PurgeCounts } from './purge-dead-quarantines.ts'
import { writeIndexerAuditLog } from './indexer-audit-log.ts'
import type { IndexerEnv } from './parse-env.ts'

/** Shape returned to `run.ts` and emitted as `RunSummary.data`. */
export interface PurgeBranchResult {
  purge: PurgeCounts
  dryRun: boolean
}

/**
 * Execute the dead-quarantine purge and write a top-level `indexer:run` audit
 * row carrying the counts (parity with the other run-types for
 * `v_indexer_health`). Errors surface as a thrown error to `run.ts` (records
 * `run_error` and exits 1).
 */
export async function runPurgeBranch(
  env: IndexerEnv,
  requestId: string
): Promise<PurgeBranchResult> {
  const dryRun = env.PURGE_DRY_RUN
  // SMI-5357: PURGE_LIMIT (optional) caps rows per apply for a staged first prod
  // run; undefined = no cap (delete the full dead set).
  const counts = await runPurge({ apply: !dryRun, limit: env.PURGE_LIMIT })

  const supabase = createSupabaseAdminClient()
  await writeIndexerAuditLog(supabase, 'success', {
    requestId,
    topics: [],
    runType: 'purge',
    dryRun,
    // The purge neither discovers nor quarantines — `found` mirrors the
    // dead-set count. Discovery-centric fields stay zero. The real signal
    // lives in the `purge` sub-object (deleted/byCohort/approvalsDeleted).
    found: counts.total,
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
    cron_slot: null,
    rotation_source: 'fallback',
    discovery_path_counts: {},
    subdirectory_search: undefined,
    high_trust_fallback_hits: 0,
    purge: counts,
  })

  return { purge: counts, dryRun }
}
