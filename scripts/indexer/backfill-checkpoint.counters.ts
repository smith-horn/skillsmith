/**
 * SMI-7121: per-dispatch counters and the loaded cursor, persisted on the checkpoint row
 * @module scripts/indexer/backfill-checkpoint.counters
 *
 * The backfill autochain evaluates the local driver's safety halts (B1 foreign cursor,
 * `noDefaultBranch`, `license_filtered`) against the completed run's checkpoint, the only
 * `audit_logs` row keyed to that run. These builders produce the two checkpoint fields
 * those halts read. Both are fail-closed by construction: a counter that is absent or not
 * a non-negative integer yields NO `dispatch_counters` at all, which the autochain treats
 * as the `counters_missing` halt, never as zero.
 *
 * See docs/internal/implementation/smi-7121-autochain-driver-halts.md (D1, D2).
 */

/** The four per-dispatch counters the autochain's halts read. */
export interface BackfillDispatchCounters {
  admitted: number
  no_default_branch: number
  license_filtered: number
  ranges_crawled: number
}

/**
 * The checkpoint a dispatch actually resumed from. `null` on the checkpoint means a true
 * cold start (no row loaded); the field being ABSENT means the row predates SMI-7121.
 */
export interface BackfillResumedFrom {
  run_id: string
  path: string
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/**
 * Build `dispatch_counters` from the run's Phase 3b stats and its facet-crawl outcome.
 * Returns undefined unless all four counters are present non-negative integers.
 */
export function buildDispatchCounters(
  subdirectorySearch:
    | { admitted?: number; no_default_branch?: number; license_filtered?: number }
    | undefined,
  crawl: { ranges_crawled?: number } | undefined
): BackfillDispatchCounters | undefined {
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

/** Build `resumed_from` from the checkpoint `loadResumeCheckpoint` returned (null = cold start). */
export function buildResumedFrom(
  loaded: { run_id: string; cursor: { path: string } } | null
): BackfillResumedFrom | null {
  return loaded ? { run_id: loaded.run_id, path: loaded.cursor.path } : null
}
