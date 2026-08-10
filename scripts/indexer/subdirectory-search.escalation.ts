/**
 * SMI-5964 §1e: no-progress escalation policy -- the threshold constant and
 * shared log line consumed by `runBackfillFacetCrawl` (`subdirectory-search.helpers.ts`).
 * @module scripts/indexer/subdirectory-search.escalation
 *
 * Split out of `subdirectory-search.helpers.ts` to keep that file under the
 * 500-line convention this repo enforces on the `subdirectory-search.*`
 * family (SMI-5286 1c originally split `subdirectory-search.ts`;
 * SMI-5319 then split `subdirectory-search.process.ts` out of THIS file for
 * the same reason; this is the same pattern applied a third time). No
 * upward imports -- `code-search.facets.ts` and `backfill-checkpoint.ts`
 * only.
 */

import { facetId, type SizeFacet } from './code-search.facets.ts'
import type { FacetCrawlState } from './backfill-checkpoint.ts'

/**
 * SMI-5964 §1e: consecutive zero-progress dispatches tolerated at one crawl
 * position before forward progress is forced. `2` is the smallest value that
 * never escalates a recoverable stall: a FIRST stall is genuinely ambiguous
 * (the dispatch may have reached the unit late, with its budget already spent
 * elsewhere), but a SECOND consecutive stall began at that exact position with
 * a full budget and still failed -- by construction, a livelock. Deliberately
 * NOT an env var (a source constant with no override) -- the termination bound
 * (`NO_PROGRESS_ESCALATION_THRESHOLD + 1` dispatches per position) is only a
 * guarantee if it cannot be turned off.
 */
export const NO_PROGRESS_ESCALATION_THRESHOLD = 2

/**
 * SMI-5964 §1e: shared escalation log line for both stop sites (the §1b
 * page-loop limb and the §1c acceptTruncation-leaf limb). Fired whenever
 * `escalate` is true, BEFORE the (possibly cap-suppressed, possibly still
 * deadline-bound) `processSearchResults` attempt -- not just when that
 * attempt ALSO has to force progress. Cap suppression alone often completes
 * the unit losslessly (no forced advance at all); the caller pushes a
 * separate, more specific `errors[]` entry only in the forced-progress case.
 * MUST be called BEFORE the forced `state.lastPage` assignment on the
 * page-loop limb (when that limb is reached) -- it reads `state.lastPage + 1`,
 * which is the about-to-be-escalated page there. On the truncation leaf
 * `state.lastPage` is always 0 (the saturation break happens at page 1,
 * before any `state.lastPage = page` assignment), so the same expression
 * correctly reports page 1 -- the leaf's only page.
 */
export function logEscalation(
  state: FacetCrawlState,
  range: SizeFacet,
  pathLabel: string,
  stallsAtThisPosition: number
): void {
  console.warn(
    `[Backfill] ESCALATED past no-progress position (facet ${facetId(range)}, ` +
      `page ${state.lastPage + 1}, path ${pathLabel}) after ${stallsAtThisPosition} ` +
      `zero-progress dispatches -- suppressing the skill cap for this unit. If the ` +
      `deadline still stops it, the remainder is forced forward and recorded truncated. ` +
      `Raise max_elapsed_minutes or narrow BACKFILL_PATH_PREFIX to crawl it completely.`
  )
}
