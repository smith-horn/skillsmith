/**
 * Subdirectory-search helpers: shared per-skill result processor + the SMI-5286
 * 1c size-faceted backfill crawl.
 * @module scripts/indexer/subdirectory-search.helpers
 *
 * Extracted from `subdirectory-search.ts` to keep that entrypoint under the
 * 500-line CI gate (SMI-5286 1c). `processSearchResults` is shared by the legacy
 * broad/fallback loop AND the backfill crawl; `runBackfillFacetCrawl` is the
 * size-faceted depth-first driver. The dependency is one-way
 * (`subdirectory-search.ts` → this file) — this file never imports the entrypoint.
 *
 * NOT parity-guarded (`parity.test.ts` exempts the subdirectory surface, C-2),
 * so divergence from the Deno copy is safe and intended (the backfill engine is
 * the Node GHA runner only).
 */

import { delay, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { searchCodeForSkillMdInSubdirectory } from './code-search.ts'
import { checkSkillMdExists } from './skill-processor.ts'
import { fetchRepoLicense, isPermissiveLicense } from './license-filter.ts'
import { enumerateRepoSkillPaths, type EnumerateTelemetry } from './trees-enumerate.ts'
import { buildSkillTreeUrl } from './skill-url.ts'
import { buildSizeFacets, facetId, facetToQualifier } from './code-search.facets.ts'
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

/**
 * Process code search results: deduplicate, license-gate, validate, and collect repos.
 * Shared by both broad and fallback search paths.
 *
 * SMI-4852: Threads `telemetry` to downstream `fetchRepoLicense` and
 * `checkSkillMdExists` calls so every GitHub API hit lands in the shared
 * collector.
 *
 * SMI-5286 Wave 1a (§#1, C-1): per-skill (collection) extraction. Each candidate
 * repo is enumerated ONCE via the Trees API (`enumerateRepoSkillPaths`) and EVERY
 * valid SKILL.md parent dir becomes its own `GitHubRepository`, with a DISTINCT
 * per-skill tree URL (`buildSkillTreeUrl`) so N skills in one repo yield N distinct
 * `repo_url` rows that never collide on `onConflict: 'repo_url'`. Each per-path row
 * is validated independently (§#4 strict gate) before it is collected; validated
 * rows are `installable:true` (`skill-processor.ts:440` then persists the non-null
 * tree URL). Edit E: only the enumeration loop changed — the dedup-key /
 * freshness-qualifier lines (`:89`) are byte-stable for the SMI-5176 rebase.
 */
export async function processSearchResults(
  resultRepos: GitHubRepository[],
  seenUrls: Set<string>,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number },
  repos: GitHubRepository[],
  stats: { licenseFiltered: number; licenseFetchFailed: number },
  telemetry: RateLimitTelemetry,
  enumerateTelemetry: EnumerateTelemetry,
  enumeratedRepos: Set<string>
): Promise<void> {
  for (const repo of resultRepos) {
    // Deduplication key includes skillPath: one repo can have multiple skills
    const dedupKey = repo.skillPath ? `${repo.url}/${repo.skillPath}` : repo.url
    if (seenUrls.has(dedupKey)) continue

    // License gate: fetch SPDX from GitHub API (not included in code search response)
    const { license: spdxId, fetchFailed } = await fetchRepoLicense(
      repo.owner,
      repo.repoName,
      telemetry
    )

    if (fetchFailed) {
      // API failure — skip this run but don't count as license-filtered.
      // NOT added to seenUrls so the repo is retried on the next indexer run.
      console.log(`[BroadDiscovery] License fetch failed (will retry next run): ${repo.fullName}`)
      stats.licenseFetchFailed++
      await delay(200)
      continue
    }

    if (!isPermissiveLicense(spdxId)) {
      // Confirmed non-permissive license — permanently excluded.
      console.log(`[BroadDiscovery] License excluded: ${repo.fullName} spdx=${spdxId ?? 'null'}`)
      stats.licenseFiltered++
      await delay(200)
      continue
    }

    // Mark this code-search result consumed (per-repo+skillPath identity) so the
    // same surfaced file is not re-processed across pages/prefixes.
    seenUrls.add(dedupKey)

    // SMI-5286 Wave 1a (§#1): enumerate the repo's full tree ONCE. The broad query
    // can surface the same repo via multiple SKILL.md hits; guard re-enumeration.
    const repoKey = `${repo.owner}/${repo.repoName}`
    if (enumeratedRepos.has(repoKey)) {
      await delay(50)
      continue
    }
    enumeratedRepos.add(repoKey)

    const { entries, truncatedByApi, truncatedByCap } = await enumerateRepoSkillPaths(
      repo.owner,
      repo.repoName,
      repo.defaultBranch,
      telemetry,
      enumerateTelemetry
    )

    if (truncatedByApi) {
      // Trees API truncated — do NOT emit a partial set (deterministic skip).
      console.log(
        `[BroadDiscovery] Trees truncated, skipping for manual handling: ${repo.fullName}`
      )
      await delay(50)
      continue
    }
    if (truncatedByCap) {
      console.log(`[BroadDiscovery] Per-repo cap reached, taking first N: ${repo.fullName}`)
    }

    // Validate each enumerated SKILL.md independently (§#4 strict gate) and emit
    // one per-skill GitHubRepository with a distinct tree URL (C-1) per valid path.
    for (const entry of entries) {
      const skillPath = entry.path
      const installable = await checkSkillMdExists(
        repo.owner,
        repo.repoName,
        repo.defaultBranch,
        validationCache,
        telemetry,
        skillPath,
        validationOptions
      )

      // C-1: build the per-skill tree URL from the BARE repo html_url
      // (reconstructed from owner/repoName), NOT from `repo.url` — by this point
      // `repo.url` is already the code-search mapper's tree URL, so reusing it
      // would double the `/tree/<branch>` segment. `skillUrl` already encodes
      // `skillPath`, so it alone is the dedup key.
      const skillUrl = buildSkillTreeUrl(
        `https://github.com/${repo.owner}/${repo.repoName}`,
        repo.defaultBranch,
        skillPath
      )
      if (seenUrls.has(skillUrl)) continue
      seenUrls.add(skillUrl)

      repos.push({
        ...repo,
        url: skillUrl,
        installable,
        skillPath,
        treeHash: entry.blobSha,
        license: spdxId,
      })
      await delay(50)
    }
  }
}

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
  /** Pages to crawl per (sub)range before treating it as exhausted (≈ ceil(1000 / perPage)). */
  maxPagesPerRange: number
  /** Dispatch budget: stop after this many (sub)ranges so the run fits the GHA cap. */
  maxRangesPerDispatch: number
}

/** GitHub code-search retrievable-results ceiling per query (any query caps here). */
const CODE_SEARCH_RESULT_CAP = 1000

/**
 * SMI-5286 1c: depth-first size-faceted crawl of the broad `filename:SKILL.md`
 * query (or a single `path:` prefix). Pages each size (sub)range to the 1000-cap;
 * a range whose `total_count` exceeds the cap is BISECTED (its halves crawled
 * before the next top-level facet) so every file is reachable. A range that
 * saturates but cannot subdivide further (≥1000 identical-byte-size files —
 * almost always denylist-caught boilerplate) is recorded as truncated, logged,
 * and skipped (never silently dropped). The frontier (facet index + bisection
 * stack + page) is fully captured by the returned cursor so a dispatch boundary
 * mid-bisection resumes losslessly. Reuses {@link processSearchResults} (license
 * gate + Trees per-skill enumeration + per-path validation) unchanged.
 */
export async function runBackfillFacetCrawl(
  plan: BackfillFacetPlan,
  seenUrls: Set<string>,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number },
  repos: GitHubRepository[],
  stats: { licenseFiltered: number; licenseFetchFailed: number },
  telemetry: RateLimitTelemetry,
  enumerateTelemetry: EnumerateTelemetry,
  enumeratedRepos: Set<string>,
  errors: string[]
): Promise<BackfillCrawlOutcome> {
  const facets = buildSizeFacets()
  const state = cursorToFacetState(plan.startCursor)
  const pathLabel = plan.pathPrefix ?? 'broad'
  let capSaturated = false
  let truncatedRanges = 0
  let rangesCrawled = 0

  while (rangesCrawled < plan.maxRangesPerDispatch) {
    const range = currentFacetRange(state, facets)
    if (!range) break // ladder exhausted
    const qualifier = facetToQualifier(range)

    let saturated = false
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
        break
      }
      // The 1000-cap is detected from total_count on the first page: rather than
      // waste pages on the unreachable tail, bisect immediately — the sub-ranges
      // (each < cap, or bisected further) cover the same files.
      if (page === 1 && result.total > CODE_SEARCH_RESULT_CAP) {
        saturated = true
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
        enumeratedRepos
      )
      state.lastPage = page
      if (result.repos.length < plan.perPage) break // short page → range exhausted
      await delay(6000) // 10 code-search req/min → 6s between pages
    }

    rangesCrawled++

    if (saturated) {
      capSaturated = true
      if (!bisectCurrentFacet(state, range)) {
        // Saturated AND unbisectable: record + skip (never silent). The operator
        // can re-run this facet under a narrower BACKFILL_PATH_PREFIX (SPARC §#3).
        truncatedRanges++
        console.warn(
          `[Backfill] facet ${facetId(range)} (${pathLabel}) saturated at the 1000-cap and cannot subdivide — recorded as truncated, skipping`
        )
        advanceFacet(state)
      }
    } else {
      // Range exhausted (short page, or page cap reached with total <= cap).
      advanceFacet(state)
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
