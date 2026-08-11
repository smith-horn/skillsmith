/**
 * Subdirectory-search helpers: BackfillFacetPlan + runBackfillFacetCrawl.
 * @module scripts/indexer/subdirectory-search.helpers
 *
 * Extracted from `subdirectory-search.ts` to keep that entrypoint under the
 * 500-line CI gate (SMI-5286 1c). The per-skill result processor and shared
 * types live in `subdirectory-search.process.ts` (split out when the SMI-5319
 * per-dispatch skill cap pushed this file over 500 lines). Re-exports everything
 * from the process module so callers that import from this path continue to work
 * unchanged. The dependency is one-way
 * (`subdirectory-search.ts` -> this file -> subdirectory-search.process.ts).
 *
 * NOT parity-guarded (`parity.test.ts` exempts the subdirectory surface, C-2),
 * so divergence from the Deno copy is safe and intended (the backfill engine is
 * the Node GHA runner only).
 */

import { delay, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { searchCodeForSkillMdInSubdirectory } from './code-search.ts'
import {
  buildSizeFacets,
  facetId,
  facetToQualifier,
  firstFacetIndexForMinSize,
} from './code-search.facets.ts'
import {
  type BackfillCursor,
  type BackfillCrawlOutcome,
  advanceFacet,
  bisectCurrentFacet,
  cursorToFacetState,
  currentFacetRange,
  facetStateToCursor,
  isFacetCrawlDone,
} from './backfill-checkpoint.ts'
import type { GitHubRepository } from './topic-search.ts'
import type { SkillMdValidation } from './skill-processor.ts'
import type { EnumerateTelemetry } from './trees-enumerate.ts'
// SMI-5964 §1e: escalation policy, split into its own module to keep this
// file under the 500-line convention (see subdirectory-search.escalation.ts's
// module docstring for the full split rationale).
import {
  NO_PROGRESS_ESCALATION_THRESHOLD,
  logEscalation,
} from './subdirectory-search.escalation.ts'

// Types and the result-processor used internally by runBackfillFacetCrawl.
// Also re-exported so callers that import from this path continue to work.
import {
  processSearchResults,
  type RepoMeta,
  type SubdirSearchStats,
} from './subdirectory-search.process.ts'
export {
  repoCacheKey,
  processSearchResults,
  type RepoMeta,
  type SubdirSearchStats,
  type ProcessBudget,
  type ProcessOutcome,
} from './subdirectory-search.process.ts'
export { NO_PROGRESS_ESCALATION_THRESHOLD } from './subdirectory-search.escalation.ts'

/**
 * SMI-5286 1c: a single dispatch's facet-crawl plan. The driver in `run.ts`
 * builds this from the resumed checkpoint cursor + raised caps and hands it to
 * `runSubdirectorySearch`; the returned {@link BackfillCrawlOutcome} carries the
 * advanced cursor back for the next checkpoint write.
 */
export interface BackfillFacetPlan {
  /** Cursor to resume from (null = cold start at facet 0, page 0). */
  startCursor: BackfillCursor | null
  /**
   * Restrict the crawl to this single `path:` prefix (the `BACKFILL_PATH_PREFIX`
   * one-ecosystem DRY_RUN / targeted-recovery mode). `undefined` = the broad
   * `filename:SKILL.md` query (no `path:` constraint), which subsumes root +
   * every subdirectory.
   */
  pathPrefix: string | undefined
  /** Results per code-search page (GitHub max 100). */
  perPage: number
  /** Pages to crawl per (sub)range before treating it as exhausted (approx ceil(1000 / perPage)). */
  maxPagesPerRange: number
  /** Dispatch budget: stop after this many (sub)ranges so the run fits the GHA cap. */
  maxRangesPerDispatch: number
  /**
   * SMI-5319 W4: minimum file size (bytes) for the FRESH-START facet index.
   * On a cold start (no resume cursor), the crawl begins at the first facet in
   * the static 9-bucket ladder whose `hi >= minSizeBytes`, skipping the
   * low-byte noise band. Default (undefined/0) = start at facet 0 (all facets).
   *
   * RESUMES are unaffected: when `startCursor` is non-null the cursor's own
   * `facet_index` is used as-is and `minSizeBytes` is ignored.
   */
  minSizeBytes?: number
  /**
   * Per-dispatch skill cap: stop the crawl at a clean range boundary once
   * `repos.length >= maxSkillsPerDispatch`, checkpoint, and exit so the next
   * dispatch resumes. The overshoot by at most the last range's contribution is
   * intentional -- the break occurs AFTER the full range completes (bisect or
   * advance), so the cursor is always clean. Default 0 (or undefined) = no cap.
   * Distinct from the per-repo cap `BACKFILL_MAX_SKILLS_PER_REPO`.
   */
  maxSkillsPerDispatch?: number
  /**
   * SMI-5448: per-dispatch wall-clock budget (ms). When > 0, the crawl
   * checkpoint-and-exits at a clean boundary once elapsed >= this budget,
   * converting a GHA-timeout rollback into forward progress. Two checks:
   * mid-range (between pages -- the cursor holds at state.lastPage, the range
   * is NOT advanced) and range-boundary (after advance/bisect, like
   * maxSkillsPerDispatch). 0/undefined = disabled (byte-identical to pre-5448).
   */
  maxElapsedMs?: number
  /**
   * SMI-5321: opt-in fetch-with-truncation floor. When true, a saturated
   * unbisectable leaf (>=1000 identical-byte-size SKILL.md files) is processed
   * instead of skipped. The leaf is still recorded truncated=true so
   * observability continues to surface the cap. Reuses the page-1 result
   * already fetched during saturation detection — NO additional code-search
   * request is issued — and processes those up-to-perPage results, marking
   * the leaf truncated=true for observability.
   * Default false (or undefined) = current skip-only behavior, byte-identical.
   */
  acceptTruncation?: boolean
}

/** GitHub code-search retrievable-results ceiling per query (any query caps here). */
const CODE_SEARCH_RESULT_CAP = 1000

/**
 * SMI-5286 1c: depth-first size-faceted crawl of the broad `filename:SKILL.md`
 * query (or a single `path:` prefix). Pages each size (sub)range to the 1000-cap;
 * a range whose `total_count` exceeds the cap is BISECTED (its halves crawled
 * before the next top-level facet) so every file is reachable. A range that
 * saturates but cannot subdivide further (>=1000 identical-byte-size files --
 * almost always denylist-caught boilerplate) is recorded as truncated, logged,
 * and skipped (never silently dropped). The frontier (facet index + bisection
 * stack + page) is fully captured by the returned cursor so a dispatch boundary
 * mid-bisection resumes losslessly. Reuses {@link processSearchResults} (Trees
 * per-skill enumeration + per-path validation + once-per-repo license metadata
 * resolution) unchanged.
 */
export async function runBackfillFacetCrawl(
  plan: BackfillFacetPlan,
  seenUrls: Set<string>,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number },
  repos: GitHubRepository[],
  stats: SubdirSearchStats,
  telemetry: RateLimitTelemetry,
  enumerateTelemetry: EnumerateTelemetry,
  enumeratedRepos: Set<string>,
  repoMetaCache: Map<string, RepoMeta>,
  errors: string[]
): Promise<BackfillCrawlOutcome> {
  const facets = buildSizeFacets()
  const state = cursorToFacetState(plan.startCursor)

  // SMI-5319 W4: on a FRESH START (null startCursor), advance the facet index
  // to skip the low-byte noise band. A resume (non-null startCursor) carries
  // its own facet_index from the checkpoint cursor and must NOT be overridden --
  // `cursorToFacetState` already restored it above, so we only act when there
  // was no prior cursor to restore from.
  if (plan.startCursor == null && (plan.minSizeBytes ?? 0) > 0) {
    const skipToIndex = firstFacetIndexForMinSize(plan.minSizeBytes ?? 0)
    if (skipToIndex > 0) {
      console.log(
        `[Backfill] min_size_bytes=${plan.minSizeBytes} -> starting at facet ${skipToIndex} ` +
          `(${facets[skipToIndex].lo}-${Number.isFinite(facets[skipToIndex].hi) ? facets[skipToIndex].hi : String(facets[skipToIndex].hi)}), ` +
          `skipping facets 0-${skipToIndex - 1}`
      )
      state.facetIndex = skipToIndex
    }
  }

  const pathLabel = plan.pathPrefix ?? 'broad'
  let capSaturated = false
  let truncatedRanges = 0
  let rangesCrawled = 0
  // SMI-5448: per-dispatch wall-clock anchor for the elapsed-budget guard.
  const startedAt = Date.now()
  // SMI-5964 §1a/§1b: absolute deadline threaded into `processSearchResults` so
  // the budget is observed INSIDE a page/leaf, not just between them (the
  // SMI-5448 mid-range/range-boundary checks below still observe it between
  // pages/ranges -- both are required; see §1a Context in the plan). `null`
  // when the budget is disabled (0/undefined), preserving the SMI-5448
  // falsy-disabled convention.
  const deadlineAt = plan.maxElapsedMs ? startedAt + plan.maxElapsedMs : null

  // SMI-5964 §1e: consecutive zero-progress dispatches recorded at the crawl
  // position the incoming cursor stopped at. Hoisted because the post-loop
  // return reads `stallsAtThisPosition`.
  const inheritedStalls = plan.startCursor?.no_progress_stalls ?? 0
  let stallsAtThisPosition = 0
  // SMI-5964 §1e: true only when this dispatch exits via one of the two
  // partial-stop sites this section polices (the page-loop intra-page stop, or
  // the acceptTruncation-leaf intra-leaf stop). Any OTHER exit (ladder
  // exhausted, maxRangesPerDispatch reached) writes the counter back to 0.
  let partialStop = false

  while (rangesCrawled < plan.maxRangesPerDispatch) {
    const range = currentFacetRange(state, facets)
    if (!range) break // ladder exhausted

    // SMI-5964 §1e(ii): position-scoped read, immediately after `range` is
    // resolved. The (path, facet, last_page) triple IS the crawl position; the
    // C-1 retirement invariant in `bisectCurrentFacet` guarantees a facet is
    // never revisited within a dispatch, so at most the FIRST range of a
    // dispatch can match -- no later range accidentally inherits a stale count.
    stallsAtThisPosition =
      plan.startCursor != null &&
      plan.startCursor.path === (plan.pathPrefix ?? '') &&
      plan.startCursor.facet === facetId(range) &&
      plan.startCursor.last_page === state.lastPage
        ? inheritedStalls
        : 0
    // SMI-5964 §1e(iv): a second consecutive zero-progress dispatch at this
    // exact position is unambiguous -- forces the stalled unit through (cap
    // suppressed first; the deadline still applies).
    const escalate = stallsAtThisPosition >= NO_PROGRESS_ESCALATION_THRESHOLD

    const qualifier = facetToQualifier(range)

    let saturated = false
    let errored = false
    // SMI-5448: write-once-true flag set only after `state.lastPage = page`
    // (never on the saturation/error path), so a timed-out range is not
    // advanced/bisected -- resume re-enters this facet at lastPage+1. SMI-5964:
    // now also set on the NEW intra-page stop (§1b), which has the identical
    // "hold, don't advance" semantic -- see the escalated exception below.
    let timedOut = false
    // SMI-5964: logging-only -- must never be tested for control flow (the
    // four-branch post-page structure below is unchanged).
    let stopReason: string | undefined
    // SMI-5321: capture page-1 repos during saturation detection so the
    // acceptTruncation floor can reuse them without a second code-search fetch.
    let saturatedPageRepos: GitHubRepository[] | null = null
    for (let page = state.lastPage + 1; page <= plan.maxPagesPerRange; page++) {
      const result = await searchCodeForSkillMdInSubdirectory(
        plan.pathPrefix,
        page,
        plan.perPage,
        telemetry,
        qualifier
      )
      if (result.error) {
        errors.push(`[backfill ${pathLabel} ${facetId(range)} p${page}] ${result.error}`)
        errored = true
        break
      }
      // The 1000-cap is detected from total_count on the first page: rather than
      // waste pages on the unreachable tail, bisect immediately -- the sub-ranges
      // (each < cap, or bisected further) cover the same files.
      if (page === 1 && result.total > CODE_SEARCH_RESULT_CAP) {
        saturated = true
        saturatedPageRepos = result.repos
        break
      }
      // SMI-5964 §1b/§1e: intra-page budget -- observed INSIDE this page's
      // per-repo/per-entry processing, not just at the range/page boundaries
      // below. The skill cap is suppressed on an escalated dispatch; the
      // deadline is never suppressed. Announce the escalation BEFORE the
      // attempt (§1e(iv)) -- cap suppression alone often completes the page
      // losslessly, with no further "forced past" event below.
      if (escalate) logEscalation(state, range, pathLabel, stallsAtThisPosition)
      const outcome = await processSearchResults(
        result.repos,
        seenUrls,
        validationCache,
        validationOptions,
        repos,
        stats,
        telemetry,
        enumerateTelemetry,
        enumeratedRepos,
        repoMetaCache,
        { deadlineAt, maxSkills: escalate ? undefined : plan.maxSkillsPerDispatch }
      )
      if (outcome.stopped) {
        stopReason = outcome.reason === 'skill-cap' ? 'skill-cap-intra-page' : 'elapsed-intra-page'
        if (escalate) {
          // SMI-5964 §1e(iv) limb 2: the cap-suppressed attempt STILL stopped
          // (necessarily on the deadline) -- force the cursor forward rather
          // than repeat the same livelock a fourth time. `partialStop` is
          // deliberately NOT set here: the escalated attempt DID move the
          // cursor (the forced `state.lastPage` assignment below), so this is
          // progress, not a stall -- the counter must reset to 0, not keep
          // climbing. Only the un-escalated "hold" branch below counts as a
          // stall against this position.
          truncatedRanges++
          errors.push(
            `[backfill ${pathLabel} ${facetId(range)} p${page}] escalated past a ` +
              `no-progress page after ${stallsAtThisPosition} stalled dispatches (${stopReason})`
          )
          state.lastPage = page // the ONLY guarded assignment on this limb -- forced progress
        } else {
          partialStop = true
        }
        timedOut = true
        break // page is PARTIAL unless `escalate` moved the cursor above
      }
      state.lastPage = page
      if (result.repos.length < plan.perPage) break // short page -> range exhausted
      if (plan.maxElapsedMs && Date.now() - startedAt >= plan.maxElapsedMs) {
        timedOut = true
        break // range NOT exhausted -- hold cursor at lastPage, resume next dispatch
      }
      await delay(6000) // 10 code-search req/min -> 6s between pages
    }

    rangesCrawled++

    if (errored) {
      // M-1: a page error (rate-limiter already retried transient 403/429, so a
      // returned error is exceptional) -- count it as truncated so it surfaces in
      // the dispatch summary + errors[], then advance past the range rather than
      // re-crawl it forever this dispatch. The operator can re-run the facet under
      // a narrower BACKFILL_PATH_PREFIX once the cause is cleared (SPARC sec#3).
      truncatedRanges++
      console.warn(
        `[Backfill] facet ${facetId(range)} (${pathLabel}) errored -- recorded as truncated, advancing`
      )
      advanceFacet(state)
    } else if (saturated) {
      capSaturated = true
      if (!bisectCurrentFacet(state, range)) {
        // Saturated AND unbisectable: record as truncated (always — for
        // observability), then either fetch the first ≤1000 results (opt-in)
        // or skip (default, byte-identical to the prior behavior).
        truncatedRanges++
        // SMI-5964 §1c: gates `advanceFacet` below on THIS branch only -- a
        // dedicated flag (not `timedOut`) so the SMI-5448 F-1 mutual-exclusivity
        // invariant (`timedOut` never set in the same iteration as `saturated`)
        // stays true byte-for-byte.
        let truncationStopped = false
        if (plan.acceptTruncation) {
          // SMI-5321: fetch-with-truncation floor. Reuses the page-1 result
          // already in memory from the saturation detection branch above —
          // NO additional code-search request is issued. The leaf is still
          // marked truncated=true (above) so the dispatch summary continues
          // to surface the cap; only the first up-to-perPage results are
          // admitted.
          console.warn(
            `[Backfill] facet ${facetId(range)} (${pathLabel}) saturated and unbisectable -- ` +
              `acceptTruncation=true, admitting page-1 results already in memory (up to ${plan.perPage}), recorded as truncated`
          )
          if (saturatedPageRepos !== null) {
            // SMI-5964 §1c: the SAME budget as the page loop -- this call site
            // was previously unbounded (review blocker 2). Announce the
            // escalation BEFORE the attempt (§1e(iv)) -- cap suppression
            // alone often completes the leaf losslessly, with no further
            // "forced past" event below.
            if (escalate) logEscalation(state, range, pathLabel, stallsAtThisPosition)
            const outcome = await processSearchResults(
              saturatedPageRepos,
              seenUrls,
              validationCache,
              validationOptions,
              repos,
              stats,
              telemetry,
              enumerateTelemetry,
              enumeratedRepos,
              repoMetaCache,
              { deadlineAt, maxSkills: escalate ? undefined : plan.maxSkillsPerDispatch }
            )
            if (outcome.stopped) {
              stopReason =
                outcome.reason === 'skill-cap'
                  ? 'skill-cap-intra-truncation'
                  : 'elapsed-intra-truncation'
              // Normal path: hold the leaf (advanceFacet below is skipped) --
              // this IS a stall against this position, so `partialStop` is
              // set. Escalated path: leave `truncationStopped` false so the
              // `advanceFacet(state)` below runs and the cursor moves (§1e) --
              // `partialStop` is deliberately NOT set here, matching the
              // page-loop limb above: a forced advance is progress, not a
              // stall, so the counter must reset to 0 on the next write.
              truncationStopped = !escalate
              if (escalate) {
                errors.push(
                  `[backfill ${pathLabel} ${facetId(range)}] escalated past a no-progress ` +
                    `acceptTruncation leaf after ${stallsAtThisPosition} stalled dispatches ` +
                    `(${stopReason}) -- remaining page-1 results skipped, leaf recorded truncated`
                )
              } else {
                partialStop = true
              }
            }
          }
        } else {
          console.warn(
            `[Backfill] facet ${facetId(range)} (${pathLabel}) saturated at the 1000-cap and cannot subdivide -- recorded as truncated, skipping`
          )
        }
        // :279 (original) -- advance when the truncated leaf was fully
        // consumed, OR when §1e escalated (truncationStopped left false).
        if (!truncationStopped) advanceFacet(state)
        if (truncationStopped) {
          console.log(
            `[Backfill] budget reached inside acceptTruncation leaf (facet ${facetId(range)}, ` +
              `reason ${stopReason}) -- leaf NOT advanced, checkpointing and exiting`
          )
          break // outer while loop -- the leaf is NOT advanced (see above)
        }
      }
    } else if (timedOut) {
      // SMI-5448: elapsed budget tripped mid-range -- the range is NOT exhausted.
      // Do NOT advance/bisect; hold the cursor at state.lastPage so the next
      // dispatch resumes at lastPage+1 for this same facet. Outer loop breaks below.
      // Edge case (page-cap boundary): if the trip landed on the final page
      // (state.lastPage == maxPagesPerRange), the next dispatch's page loop opens
      // at lastPage+1 > maxPagesPerRange, its body never runs, no flags are set,
      // and the outer `else` advances the facet -- correct: this range is treated
      // as page-cap exhausted, identical to the pre-5448 exhaustion path.
      // SMI-5964: on the ESCALATED page-loop limb, `state.lastPage` was already
      // forced forward (above, before this branch runs) -- this comment's "hold"
      // description applies to the unescalated case only.
    } else {
      // Range exhausted (short page, or page cap reached with total <= cap).
      advanceFacet(state)
    }

    // SMI-5448: mid-range elapsed break -- the facet was NOT advanced (the
    // `else if (timedOut)` branch above left the cursor at state.lastPage), so
    // the next dispatch resumes at lastPage+1 for this same facet. Break before
    // the skill-cap check to avoid double-logging on the same exit.
    if (timedOut) {
      console.log(
        `[Backfill] elapsed budget ${plan.maxElapsedMs}ms reached mid-range ` +
          `(facet ${facetId(range)}, resuming at page ${state.lastPage + 1}), checkpointing and exiting`
      )
      break
    }

    // Per-dispatch skill cap: checked at the range boundary (after bisect/advance)
    // so the cursor is always clean and `done` is computed normally below. The
    // overshoot by at most the last range's contribution is intentional. The crawl
    // is NOT done -- there is more to do; the next dispatch resumes from the
    // checkpoint cursor written by the caller.
    if (plan.maxSkillsPerDispatch && repos.length >= plan.maxSkillsPerDispatch) {
      console.log(
        `[Backfill] Skill cap reached: ${repos.length} skills >= cap ${plan.maxSkillsPerDispatch}, checkpointing and exiting`
      )
      break
    }

    // SMI-5448: range-boundary elapsed break -- the last range fully completed
    // (advanced/bisected), so the cursor is clean. This bounds cumulative
    // multi-range dispatches, mirroring the skill-cap check above.
    if (plan.maxElapsedMs && Date.now() - startedAt >= plan.maxElapsedMs) {
      console.log(
        `[Backfill] elapsed budget ${plan.maxElapsedMs}ms reached at range boundary ` +
          `(${rangesCrawled} ranges), checkpointing and exiting`
      )
      break
    }
  }

  return {
    cursor: facetStateToCursor(
      state,
      plan.pathPrefix ?? '',
      facets,
      // SMI-5964 §1e(iii): position-scoped, not dispatch-scoped -- the ONLY
      // write sites for this counter are the two partial-stop sites above.
      // Any other exit (ladder exhausted, maxRangesPerDispatch reached) writes
      // 0. Whether this dispatch made progress EARLIER at a different position
      // is irrelevant: `stallsAtThisPosition` (read above) already resets to 0
      // whenever the incoming cursor's position doesn't match the position now
      // being crawled.
      partialStop ? stallsAtThisPosition + 1 : 0
    ),
    done: isFacetCrawlDone(state, facets),
    cap_saturated: capSaturated,
    truncated_repo_count: truncatedRanges,
    facets_completed: state.facetIndex,
    facets_total: facets.length,
    ranges_crawled: rangesCrawled,
  }
}
