/**
 * SMI-7121: per-dispatch counters and the loaded cursor, persisted on the checkpoint row
 * @module scripts/indexer/backfill-checkpoint.counters
 *
 * The backfill autochain evaluates the local driver's safety halts (B1 foreign cursor,
 * `noDefaultBranch`, `license_filtered`) against the completed run's checkpoint, the only
 * `audit_logs` row keyed to that run. These builders produce the two checkpoint fields
 * those halts read, and {@link buildCheckpointPayload} assembles the whole payload so the
 * mapping is testable without running `run.ts` (which calls `main()` at import).
 *
 * Both fields are fail-closed by construction. A counter that is absent, malformed, or
 * comes from an errored Phase 3b yields NO `dispatch_counters`; a loaded checkpoint
 * without a string path yields NO `resumed_from`. The autochain treats an absent field
 * as the `counters_missing` halt, never as zero or as a cold start.
 *
 * See docs/internal/implementation/smi-7121-autochain-driver-halts.md (D1, D2).
 */

import type { BackfillCheckpointPayload, BackfillCrawlOutcome } from './backfill-checkpoint.ts'
import type { BackfillDispatchInputs } from './backfill-dispatch-inputs.ts'

/** The four per-dispatch counters the autochain's halts read. */
export interface BackfillDispatchCounters {
  admitted: number
  no_default_branch: number
  license_filtered: number
  ranges_crawled: number
}

/**
 * The checkpoint a dispatch actually resumed from. `null` on the checkpoint means a true
 * cold start (no row loaded); the field being ABSENT means it could not be recorded, or
 * the row predates SMI-7121.
 */
export interface BackfillResumedFrom {
  run_id: string
  path: string
}

/** The checkpoint fields SMI-7121 adds; `BackfillCheckpointPayload` extends this. */
export interface CheckpointHaltFields {
  /** This dispatch's halt counters (absent = not all four were available). */
  dispatch_counters?: BackfillDispatchCounters
  /** The checkpoint this dispatch loaded; null = cold start, absent = not recorded. */
  resumed_from?: BackfillResumedFrom | null
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/**
 * Build `dispatch_counters` from the run's Phase 3b stats and its facet-crawl outcome.
 * Returns undefined unless all four counters are present non-negative integers and
 * Phase 3b did not record an error (a disabled/failed marker carries zeroed counters).
 */
export function buildDispatchCounters(
  subdirectorySearch:
    | { admitted?: number; no_default_branch?: number; license_filtered?: number; error?: string }
    | undefined,
  crawl: { ranges_crawled?: number } | undefined
): BackfillDispatchCounters | undefined {
  if (subdirectorySearch?.error !== undefined) return undefined
  const admitted = subdirectorySearch?.admitted
  const noDefaultBranch = subdirectorySearch?.no_default_branch
  const licenseFiltered = subdirectorySearch?.license_filtered
  const rangesCrawled = crawl?.ranges_crawled
  if (
    !isCount(admitted) ||
    !isCount(noDefaultBranch) ||
    !isCount(licenseFiltered) ||
    !isCount(rangesCrawled)
  ) {
    return undefined
  }
  return {
    admitted,
    no_default_branch: noDefaultBranch,
    license_filtered: licenseFiltered,
    ranges_crawled: rangesCrawled,
  }
}

/**
 * Build `resumed_from` from the checkpoint `loadResumeCheckpoint` returned. null = cold
 * start. undefined (field omitted) when the loaded row lacks a string run id or path:
 * `readCheckpoint` validates only `run_id` and `cursor.facet`, and a path silently dropped
 * by JSON would read as "no path" to the B1 halt.
 */
export function buildResumedFrom(
  loaded: { run_id: unknown; cursor: { path?: unknown } } | null
): BackfillResumedFrom | null | undefined {
  if (loaded === null) return null
  const { run_id: runId } = loaded
  const path = loaded.cursor.path
  if (typeof runId !== 'string' || typeof path !== 'string') return undefined
  return { run_id: runId, path }
}

/** Assemble the checkpoint payload `run.ts` writes after a backfill crawl. */
export function buildCheckpointPayload(args: {
  runId: string
  crawl: BackfillCrawlOutcome
  subdirectorySearch: Parameters<typeof buildDispatchCounters>[0]
  dryRun: boolean
  dispatchInputs: BackfillDispatchInputs
  loaded: Parameters<typeof buildResumedFrom>[0]
}): BackfillCheckpointPayload {
  const { crawl } = args
  const payload: BackfillCheckpointPayload = {
    run_id: args.runId,
    cursor: crawl.cursor,
    facets_completed: crawl.facets_completed,
    facets_total: crawl.facets_total,
    cap_saturated: crawl.cap_saturated,
    truncated_repo_count: crawl.truncated_repo_count,
    incomplete_results_ranges: crawl.incomplete_results_ranges, // SMI-6073
    dry_run: args.dryRun,
    // SMI-6246: echoed so indexer-backfill-autochain.yml can replay this
    // exact campaign on auto-chain instead of defaulting every input.
    dispatch_inputs: args.dispatchInputs,
  }
  const counters = buildDispatchCounters(args.subdirectorySearch, crawl)
  if (counters) payload.dispatch_counters = counters
  const resumedFrom = buildResumedFrom(args.loaded)
  if (resumedFrom !== undefined) payload.resumed_from = resumedFrom
  return payload
}
