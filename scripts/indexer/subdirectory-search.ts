/**
 * Broad SKILL.md discovery for cross-ecosystem indexing (Node port)
 * @module scripts/indexer/subdirectory-search
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/subdirectory-search.ts`. This module performs no
 * direct GitHub fetches; it dispatches to `searchCodeForSkillMdInSubdirectory`
 * (already wrapped per Hard Rule 1) and the sibling-module helpers
 * `checkSkillMdExists` / `fetchRepoLicense` (each wrapped in their own
 * cluster). Telemetry is threaded through to every downstream call so the
 * single run-scoped collector aggregates header data from every consumer.
 * Parity is guarded by `scripts/indexer/tests/parity.test.ts`.
 *
 * Original module docs:
 *
 * SMI-2660: Phase 3b of the indexer — finds SKILL.md files via GitHub Code Search.
 * SMI-3229: Replaced hardcoded path-prefix loop with broad `filename:SKILL.md` query.
 *
 * Extracted from index.ts to satisfy the 500-line CI gate.
 *
 * Strategy:
 * 1. Primary: broad query (no path: constraint) — discovers SKILL.md at any depth
 * 2. Fallback: if any page returns incomplete_results, re-runs with 7 path-scoped
 *    queries to ensure known ecosystems are fully covered
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
import { checkSkillMdExists } from './skill-processor.ts'
import { fetchRepoLicense, isPermissiveLicense } from './license-filter.ts'
import { enumerateRepoSkillPaths, type EnumerateTelemetry } from './trees-enumerate.ts'
import { buildSkillTreeUrl } from './skill-url.ts'
import type { GitHubRepository } from './topic-search.ts'
import type { SkillMdValidation } from './skill-processor.ts'

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
async function processSearchResults(
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
 * @param freshnessDate - ISO date string for freshness targeting (or undefined for full scan)
 * @param validationCache - Request-scoped SKILL.md validation cache
 * @param validationOptions - Strict validation and minimum content length options
 * @param maxPages - Maximum pages per query (capped by caller)
 * @param telemetry - Shared rate-limit telemetry collector.
 */
export async function runSubdirectorySearch(
  seenUrls: Set<string>,
  freshnessDate: string | undefined,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number },
  maxPages: number,
  telemetry: RateLimitTelemetry
): Promise<{
  repos: GitHubRepository[]
  totalFound: number
  retries: number
  licenseFiltered: number
  licenseFetchFailed: number
  incompleteResults: number
  searchMode: 'broad' | 'prefix-fallback'
  errors: string[]
}> {
  const repos: GitHubRepository[] = []
  const errors: string[] = []
  let totalFound = 0
  let totalRetries = 0
  const stats = { licenseFiltered: 0, licenseFetchFailed: 0 }
  let incompleteResults = 0
  let searchMode: 'broad' | 'prefix-fallback' = 'broad'
  // SMI-5286 Wave 1a: run-scoped per-skill extraction state. `enumerateTelemetry`
  // accumulates denylist/cap/truncation counters across the whole run;
  // `enumeratedRepos` guards one Trees call per repo across pages and prefixes.
  const enumerateTelemetry: EnumerateTelemetry = {}
  const enumeratedRepos = new Set<string>()

  // ── Primary: broad query (no path constraint) ────────────────────────
  console.log('[BroadDiscovery] Running broad filename:SKILL.md query...')

  for (let page = 1; page <= maxPages; page++) {
    const result = await searchCodeForSkillMdInSubdirectory(
      undefined, // no pathPrefix → broad query
      page,
      30,
      freshnessDate,
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

    if (result.repos.length < 30) break
    // Code search rate limit: 10 req/min → 6s between pages
    await delay(6000)
  }

  // ── Fallback: path-scoped queries if broad had incomplete results ────
  if (incompleteResults > 0) {
    searchMode = 'prefix-fallback'
    console.log(
      `[BroadDiscovery] ${incompleteResults} page(s) had incomplete results — falling back to path-scoped queries`
    )

    for (const pathPrefix of FALLBACK_PATH_PREFIXES) {
      console.log(`[BroadDiscovery] Fallback searching path:${pathPrefix}...`)

      for (let page = 1; page <= maxPages; page++) {
        const result = await searchCodeForSkillMdInSubdirectory(
          pathPrefix,
          page,
          30,
          freshnessDate,
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

        if (result.repos.length < 30) break
        // Code search rate limit: 10 req/min → 6s between pages
        await delay(6000)
      }

      // Delay between path prefixes (separate code search quota calls)
      await delay(GITHUB_API_DELAY)
    }
  }

  console.log(
    `[BroadDiscovery] Complete (${searchMode}): ${repos.length} added, ${stats.licenseFiltered} license-filtered, ${stats.licenseFetchFailed} fetch-failed, ${incompleteResults} incomplete, ${totalRetries} retries`
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
    searchMode,
    errors,
  }
}
