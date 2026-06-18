/**
 * Broad SKILL.md discovery for cross-ecosystem indexing (Node port)
 * @module scripts/indexer/subdirectory-search
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/subdirectory-search.ts`. This module performs no
 * direct GitHub fetches; it dispatches to `searchCodeForSkillMdInSubdirectory`
 * (already wrapped per Hard Rule 1) and the sibling-module helper
 * `processSearchResults` (license-gate + Trees per-skill enumeration). Telemetry
 * is threaded through to every downstream call so the single run-scoped collector
 * aggregates header data from every consumer. NOTE (SMI-5286 1c): this surface is
 * NOT parity-guarded (`parity.test.ts` exempts subdirectory-search), so the Node
 * copy may diverge from the Deno parent.
 *
 * Original module docs:
 *
 * SMI-2660: Phase 3b of the indexer — finds SKILL.md files via GitHub Code Search.
 * SMI-3229: Replaced hardcoded path-prefix loop with broad `filename:SKILL.md` query.
 *
 * Extracted from index.ts to satisfy the 500-line CI gate. SMI-5286 1c moved the
 * shared `processSearchResults` + the size-faceted backfill crawl to
 * `subdirectory-search.helpers.ts` to stay under that gate.
 *
 * Strategy:
 * 1. Primary: broad query (no path: constraint) — discovers SKILL.md at any depth
 * 2. Fallback: if any page returns incomplete_results, re-runs with 7 path-scoped
 *    queries to ensure known ecosystems are fully covered
 * 3. SMI-5286 1c backfill: when a `BackfillFacetPlan` is supplied, the legacy loop
 *    is replaced by a resumable size-faceted depth-first crawl.
 *
 * Rate limit: 10 code search requests/minute (separate from main API).
 * Gated by SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH=true env var to prevent
 * accidental budget exhaustion when not needed.
 *
 * License gate: code search does not return license data. Each unique repo found
 * here requires a separate fetchRepoLicense() call before indexing. This means
 * N subdirectory repos = N additional /repos/{owner}/{repo} API calls (main API,
 * 5000 req/hr authenticated — budget is generous but must be monitored).
 */

import { GITHUB_API_DELAY, delay, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { searchCodeForSkillMdInSubdirectory } from './code-search.ts'
import { type EnumerateTelemetry } from './trees-enumerate.ts'
import {
  processSearchResults,
  runBackfillFacetCrawl,
  type BackfillFacetPlan,
} from './subdirectory-search.helpers.ts'
import type { BackfillCrawlOutcome } from './backfill-checkpoint.ts'
import type { GitHubRepository } from './topic-search.ts'
import type { SkillMdValidation } from './skill-processor.ts'
import type { IndexerResult } from './indexer-types.ts'

export type { BackfillFacetPlan } from './subdirectory-search.helpers.ts'

/**
 * Results per code-search page. SMI-5286 1c (C-5): GitHub allows 100 (was a
 * hardcoded 30 → 3.3x fewer requests for the same coverage). The cron leaves
 * Phase 3b disabled, so this only affects manual-enable + backfill runs.
 */
const BROAD_QUERY_PER_PAGE = 100

/**
 * Fallback path prefixes used when broad query returns incomplete results.
 * SMI-4385: Extended from 3 to 7 prefixes covering cross-framework conventions.
 * SMI-5175: Added `.agent/skills` + `.windsurf/skills` — the two 2026 conventions
 * the broad-query fallback was missing (see
 * docs/internal/research/cross-ecosystem-skill-index-expansion.md §A).
 * See docs/internal/research/vendor-org-coverage-2026-04-20.md for probe counts.
 *
 * Exported so the cross-ecosystem coverage test can assert membership without
 * re-deriving the list.
 */
export const FALLBACK_PATH_PREFIXES = [
  '.gemini/skills', // Google Gemini CLI skills
  '.github/skills', // GitHub-hosted skills (community + Microsoft pattern)
  'skills', // Generic skills/ subdirectory at repo root
  // SMI-4385: Cross-framework skill paths (LangChain/CrewAI, OpenAI Codex,
  // Cursor, cross-framework neutral) discovered via SMI-4380 vendor-org probe.
  '.agents/skills', // Agent-framework convention (LangChain, CrewAI, etc.)
  '.codex/skills', // OpenAI Codex / Cursor shared convention
  '.cursor/skills', // Cursor-specific authoring convention
  '.ai/skills', // Cross-framework neutral convention
  // SMI-5175: 2026 conventions. Note `.agent/skills` (singular) is Antigravity's
  // project-local path and is DISTINCT from `.agents/skills` (the cross-tool plural).
  '.agent/skills', // Antigravity (project-local, singular)
  '.windsurf/skills', // Windsurf (native, since 2026-03)
]

/**
 * SMI-3229: Run Phase 3b broad SKILL.md discovery with incomplete_results fallback.
 *
 * Primary: single broad query (no path: constraint), paginating up to maxPages.
 * Fallback: if any page returns incomplete_results, re-runs with 7 path-scoped
 * queries to ensure known ecosystems (FALLBACK_PATH_PREFIXES) are fully covered.
 *
 * Deduplicates results against the shared seenUrls set from earlier phases
 * so repos discovered via topic search are not re-validated.
 *
 * License gate: repos without a permissive license (MIT, Apache-2.0, etc.) are
 * excluded and counted in licenseFiltered. Repos where the license fetch failed
 * (rate limit / network error) are counted separately in licenseFetchFailed and
 * are NOT added to seenUrls — they will be retried on the next indexer run.
 *
 * SMI-4852: Threads `telemetry` through to every downstream GitHub call.
 *
 * @param seenUrls - Shared deduplication set from the indexer (modified in place)
 * @param validationCache - Request-scoped SKILL.md validation cache
 * @param validationOptions - Strict validation and minimum content length options
 * @param maxPages - Maximum pages per query (capped by caller)
 * @param telemetry - Shared rate-limit telemetry collector.
 * @param backfillPlan - SMI-5286 1c: when present, run the size-faceted backfill
 *   crawl instead of the legacy broad+fallback loop. Optional → every existing
 *   5-arg caller (the cron Phase-3b path + tests) is byte-stable.
 */
export async function runSubdirectorySearch(
  seenUrls: Set<string>,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number },
  maxPages: number,
  telemetry: RateLimitTelemetry,
  backfillPlan?: BackfillFacetPlan
): Promise<{
  repos: GitHubRepository[]
  totalFound: number
  retries: number
  licenseFiltered: number
  licenseFetchFailed: number
  incompleteResults: number
  searchMode: 'broad' | 'prefix-fallback'
  errors: string[]
  /** SMI-5286 1c: present only when `backfillPlan` was supplied. */
  backfill?: BackfillCrawlOutcome
}> {
  const repos: GitHubRepository[] = []
  const errors: string[] = []
  let totalFound = 0
  let totalRetries = 0
  const stats = { licenseFiltered: 0, licenseFetchFailed: 0 }
  let incompleteResults = 0
  const searchMode: 'broad' | 'prefix-fallback' = 'broad'
  // SMI-5286 Wave 1a: run-scoped per-skill extraction state. `enumerateTelemetry`
  // accumulates denylist/cap/truncation counters across the whole run;
  // `enumeratedRepos` guards one Trees call per repo across pages and prefixes.
  const enumerateTelemetry: EnumerateTelemetry = {}
  const enumeratedRepos = new Set<string>()

  // ── SMI-5286 1c: size-faceted backfill crawl (replaces the legacy loop) ──
  if (backfillPlan) {
    const backfill = await runBackfillFacetCrawl(
      backfillPlan,
      seenUrls,
      validationCache,
      validationOptions,
      repos,
      stats,
      telemetry,
      enumerateTelemetry,
      enumeratedRepos,
      errors
    )
    console.log(
      `[Backfill] Facet crawl: ${repos.length} skills added, ${backfill.facets_completed}/${backfill.facets_total} facets, ${backfill.ranges_crawled} ranges this dispatch, ` +
        `${stats.licenseFiltered} license-filtered, cap_saturated=${backfill.cap_saturated}, truncated=${backfill.truncated_repo_count}, done=${backfill.done}`
    )
    console.log(
      `[Backfill] Per-skill extraction: ${enumeratedRepos.size} repos enumerated, ${enumerateTelemetry.denylistSkipped ?? 0} denylist-skipped, ${enumerateTelemetry.cappedRepoCount ?? 0} capped, ${enumerateTelemetry.truncatedRepoCount ?? 0} api-truncated`
    )
    return {
      repos,
      totalFound: repos.length,
      retries: totalRetries,
      licenseFiltered: stats.licenseFiltered,
      licenseFetchFailed: stats.licenseFetchFailed,
      incompleteResults,
      searchMode,
      errors,
      backfill,
    }
  }

  // ── Primary: broad query (no path constraint) ────────────────────────
  console.log('[BroadDiscovery] Running broad filename:SKILL.md query...')

  let primaryMode: 'broad' | 'prefix-fallback' = 'broad'
  for (let page = 1; page <= maxPages; page++) {
    const result = await searchCodeForSkillMdInSubdirectory(
      undefined, // no pathPrefix → broad query
      page,
      BROAD_QUERY_PER_PAGE,
      telemetry
    )

    totalRetries += result.retries

    if (result.error) {
      errors.push(`[broad p${page}] ${result.error}`)
      break
    }

    if (result.incomplete_results) {
      incompleteResults++
    }

    if (page === 1) {
      totalFound += result.total
      console.log(`[BroadDiscovery] broad query — ${result.total} total SKILL.md files found`)
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

    if (result.repos.length < BROAD_QUERY_PER_PAGE) break
    // Code search rate limit: 10 req/min → 6s between pages
    await delay(6000)
  }

  // ── Fallback: path-scoped queries if broad had incomplete results ────
  if (incompleteResults > 0) {
    primaryMode = 'prefix-fallback'
    console.log(
      `[BroadDiscovery] ${incompleteResults} page(s) had incomplete results — falling back to path-scoped queries`
    )

    for (const pathPrefix of FALLBACK_PATH_PREFIXES) {
      console.log(`[BroadDiscovery] Fallback searching path:${pathPrefix}...`)

      for (let page = 1; page <= maxPages; page++) {
        const result = await searchCodeForSkillMdInSubdirectory(
          pathPrefix,
          page,
          BROAD_QUERY_PER_PAGE,
          telemetry
        )

        totalRetries += result.retries

        if (result.error) {
          errors.push(`[path:${pathPrefix} p${page}] ${result.error}`)
          break
        }

        if (result.incomplete_results) {
          incompleteResults++
        }

        if (page === 1) {
          totalFound += result.total
          console.log(
            `[BroadDiscovery] path:${pathPrefix} — ${result.total} total SKILL.md files found`
          )
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

        if (result.repos.length < BROAD_QUERY_PER_PAGE) break
        // Code search rate limit: 10 req/min → 6s between pages
        await delay(6000)
      }

      // Delay between path prefixes (separate code search quota calls)
      await delay(GITHUB_API_DELAY)
    }
  }

  console.log(
    `[BroadDiscovery] Complete (${primaryMode}): ${repos.length} added, ${stats.licenseFiltered} license-filtered, ${stats.licenseFetchFailed} fetch-failed, ${incompleteResults} incomplete, ${totalRetries} retries`
  )
  // SMI-5286 Wave 1a: per-skill extraction observability (§#1, Edit D).
  console.log(
    `[BroadDiscovery] Per-skill extraction: ${enumeratedRepos.size} repos enumerated, ${enumerateTelemetry.denylistSkipped ?? 0} denylist-skipped, ${enumerateTelemetry.cappedRepoCount ?? 0} capped, ${enumerateTelemetry.truncatedRepoCount ?? 0} api-truncated`
  )
  if (
    enumerateTelemetry.denylistSkippedSample &&
    enumerateTelemetry.denylistSkippedSample.length > 0
  ) {
    console.log(
      `[BroadDiscovery] Denylist-skipped sample: ${enumerateTelemetry.denylistSkippedSample.join(', ')}`
    )
  }

  return {
    repos,
    totalFound,
    retries: totalRetries,
    licenseFiltered: stats.licenseFiltered,
    licenseFetchFailed: stats.licenseFetchFailed,
    incompleteResults,
    searchMode: primaryMode,
    errors,
  }
}

/**
 * Phase 3b wrapper: runs {@link runSubdirectorySearch}, folds its repos/errors/
 * stats into the orchestrator's accumulators, and (SMI-5286 1c) surfaces the
 * backfill cursor on `result.backfill_crawl`. Extracted here so
 * `discovery-orchestrator.ts` stays under the 500-line gate. Never throws — a
 * Phase-3b failure records a zeroed `subdirectory_search` and is swallowed
 * (one phase must not abort the cycle), matching the prior inline behavior.
 */
export async function runSubdirectorySearchPhase(args: {
  seenUrls: Set<string>
  validationCache: Map<string, SkillMdValidation>
  validationOptions: { strictValidation?: boolean; minContentLength?: number }
  codeSearchMaxPages: number
  telemetry: RateLimitTelemetry
  repositories: GitHubRepository[]
  result: IndexerResult
  backfillFacetPlan?: BackfillFacetPlan
}): Promise<void> {
  try {
    const subdirResult = await runSubdirectorySearch(
      args.seenUrls,
      args.validationCache,
      args.validationOptions,
      args.codeSearchMaxPages,
      args.telemetry,
      args.backfillFacetPlan
    )
    for (const repo of subdirResult.repos) {
      args.repositories.push(repo)
    }
    args.result.errors.push(...subdirResult.errors)
    args.result.subdirectory_search = {
      repos_found: subdirResult.repos.length,
      total_found: subdirResult.totalFound,
      retries: subdirResult.retries,
      license_filtered: subdirResult.licenseFiltered,
      license_fetch_failed: subdirResult.licenseFetchFailed,
      incomplete_results: subdirResult.incompleteResults,
      search_mode: subdirResult.searchMode,
    }
    if (subdirResult.backfill) {
      args.result.backfill_crawl = subdirResult.backfill
    }
  } catch (err) {
    console.warn(`[CodeSearch] Phase 3b failed: ${err instanceof Error ? err.message : 'Unknown'}`)
    args.result.subdirectory_search = {
      repos_found: 0,
      total_found: 0,
      retries: 0,
      license_filtered: 0,
      license_fetch_failed: 0,
      error: 'phase_failed',
    }
  }
}
