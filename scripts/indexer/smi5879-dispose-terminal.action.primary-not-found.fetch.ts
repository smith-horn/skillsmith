/**
 * SMI-6444 `dispose --outcome-class=primary_not_found` — the live re-fetch
 * loop, split out of `.action.primary-not-found.ts` purely for the repo's
 * 500-line file policy.
 * @module scripts/indexer/smi5879-dispose-terminal.action.primary-not-found.fetch
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 5/8 — "live re-fetch each pendingIds row ... using the same fetch
 *   discrimination the simulator uses (confirmed 404 -> 'verified' [the
 *   claim holds], fetch succeeded -> 'mismatched', transient/rate-limited
 *   after retries -> 'unavailable'), recordResult per row, bounded
 *   concurrency via the existing fetch-retry/rate-limit primitives."
 */

import { runCancellablePool } from './_shared/rate-limit.ts'
import { parseSkillMdUrl, type ParsedSkillUrl } from './_shared/skill-md-fetch.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { retryPrimaryFetch } from './smi5879-simulate-full.helpers.ts'
import type { FetchRetryOutcome } from './smi5879-fetch-retry.ts'
import type { SampleRunHandle } from './smi5879-dispose-terminal.sidecar.ts'
import type { SimSnapshotRow } from './smi5879-simulate-full.types.ts'

/** Matches `PROCESS_CONCURRENCY` in `smi5879-simulate-full.helpers.ts` — the
 *  same polite bound the simulator's own primary-fetch pass already uses. */
export const DEFAULT_PRIMARY_NOT_FOUND_FETCH_CONCURRENCY = 5

export interface LiveRecheckDeps {
  getHeaders?: () => Promise<Record<string, string>>
  concurrency?: number
  /**
   * Injection seam for the actual primary fetch — defaults to the SAME
   * `retryPrimaryFetch` (`smi5879-simulate-full.helpers.ts`) the simulator
   * itself uses, so production wiring reuses the identical fetch path and
   * 404-vs-success discrimination `processRow` depends on. Tests inject a
   * fake here rather than mocking the global `fetch`/GitHub auth surface.
   */
  fetchPrimary?: (parsed: ParsedSkillUrl) => Promise<FetchRetryOutcome>
}

/**
 * Live re-fetch every still-pending selected row — unrecorded, or previously
 * `'unavailable'` (retryable, never terminal) — via the SAME fetch path and
 * 404-vs-success discrimination `processRow` itself uses
 * (`retryPrimaryFetch`): a confirmed 404 means the row's `primary_not_found`
 * claim holds (`'verified'`); the fetch succeeding (content found) means the
 * claim does NOT hold (`'mismatched'`); retries exhausted means transient/
 * rate-limited (`'unavailable'`, re-attempted on a future resume — never
 * priced as a permanent mismatch by this loop). Every result is
 * checkpointed to the sidecar synchronously as it lands
 * (`handle.recordResult`), so a crash mid-run loses at most the
 * in-flight-at-crash-time attempts, never previously recorded results.
 */
export async function liveRecheckPendingRows(
  handle: SampleRunHandle,
  populationById: ReadonlyMap<string, SimSnapshotRow>,
  deps: LiveRecheckDeps = {}
): Promise<void> {
  const pendingIds = handle.pendingIds()
  if (pendingIds.length === 0) return
  const getHeaders =
    deps.getHeaders ??
    ((): Promise<Record<string, string>> =>
      buildGitHubHeaders('skillsmith-smi5879-dispose-terminal/1.0'))
  const fetchPrimary = deps.fetchPrimary ?? ((parsed) => retryPrimaryFetch(parsed, getHeaders))
  const concurrency = deps.concurrency ?? DEFAULT_PRIMARY_NOT_FOUND_FETCH_CONCURRENCY

  const { abortedBy } = await runCancellablePool(
    pendingIds,
    async (id) => {
      const populationRow = populationById.get(id)
      const parsed = populationRow
        ? parseSkillMdUrl(populationRow.repo_url, populationRow.skill_path)
        : null
      if (!parsed) {
        // Should not happen: a pending id was only selected because its
        // stratum key was derivable from a parseable URL at sampling time.
        // Never silently drop — price as unavailable, retryable on resume.
        return { id, value: 'unavailable' as const }
      }
      const outcome = await fetchPrimary(parsed)
      if ('removed' in outcome) return { id, value: 'verified' as const }
      if ('content' in outcome) return { id, value: 'mismatched' as const }
      return { id, value: 'unavailable' as const }
    },
    (outcome) => {
      handle.recordResult(outcome.id, outcome.value)
    },
    concurrency
  )
  // `runCancellablePool` CAPTURES a thrown `processItem` error into
  // `abortedBy` and returns normally — it never rethrows. Rethrowing here is
  // mandatory, and matches `runMainPass`'s own `if (abortedBy) throw abortedBy`
  // (`smi5879-simulate-full.helpers.ts`), the established consumer contract in
  // this codebase. Without it, a fatal, non-transient failure — a
  // `PrimaryFetchAuthError` on HTTP 401, which `withFetchRetry` deliberately
  // rethrows rather than retrying — would silently abort the pool, leave every
  // remaining row unrecorded, and then be laundered by `observations()` (which
  // prices an unrecorded row as `unavailable`) into an ordinary
  // rate-limited-looking result. A late-run abort could still clear both
  // acceptance arms and STAGE, recording a credential failure as transient
  // unavailability in the batch's own audit trail.
  if (abortedBy) throw abortedBy
}
