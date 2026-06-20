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
} from './subdirectory-search.process.ts'

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

  while (rangesCrawled < plan.maxRangesPerDispatch) {
    const range = currentFacetRange(state, facets)
    if (!range) break // ladder exhausted
    const qualifier = facetToQualifier(range)

    let saturated = false
    let errored = false
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
      await processSearchResults(
        result.repos,
        seenUrls,
        validationCache,
        validationOptions,
        repos,
        stats,
        telemetry,
        enumerateTelemetry,
        enumeratedRepos,
        repoMetaCache
      )
      state.lastPage = page
      if (result.repos.length < plan.perPage) break // short page -> range exhausted
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
            await processSearchResults(
              saturatedPageRepos,
              seenUrls,
              validationCache,
              validationOptions,
              repos,
              stats,
              telemetry,
              enumerateTelemetry,
              enumeratedRepos,
              repoMetaCache
            )
          }
        } else {
          console.warn(
            `[Backfill] facet ${facetId(range)} (${pathLabel}) saturated at the 1000-cap and cannot subdivide -- recorded as truncated, skipping`
          )
        }
        advanceFacet(state)
      }
    } else {
      // Range exhausted (short page, or page cap reached with total <= cap).
      advanceFacet(state)
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
  }

  return {
    cursor: facetStateToCursor(state, plan.pathPrefix ?? '', facets),
    done: isFacetCrawlDone(state, facets),
    cap_saturated: capSaturated,
    truncated_repo_count: truncatedRanges,
    facets_completed: state.facetIndex,
    facets_total: facets.length,
    ranges_crawled: rangesCrawled,
  }
}
