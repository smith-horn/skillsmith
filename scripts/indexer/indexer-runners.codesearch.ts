/**
 * Phase 3a code search — Node port (SMI-4852).
 * @module scripts/indexer/indexer-runners.codesearch
 *
 * Node-flavored sibling of `supabase/functions/indexer/indexer-runners.codesearch.ts`.
 * Extracted to keep `indexer-runners.ts` ≤ 500 lines.
 *
 * SMI-4854 added the skip-gate parameter, pushing the function past the
 * audit:standards line cap; broken out here. Re-exported by indexer-runners.ts
 * for existing import sites.
 *
 * SMI-4852: Threads `RateLimitTelemetry` so the downstream
 * `searchCodeForSkillMd` and `checkSkillMdExists` calls can record GitHub
 * rate-limit headers / 403-429 incidents into the per-run telemetry bag.
 *
 * **Code-search 10 rpm quota stays serial in Wave 1.** The 6000ms inter-page
 * `delay` is preserved verbatim — code search has its own quota separate from
 * main search, and parallelizing without a dedicated token bucket would
 * 403-cascade silently (the existing error handler treats 403 as non-fatal
 * break). Replace with `codeSearchTokenBucket` in follow-up — see plan H-3.
 */

import { searchCodeForSkillMd } from './code-search.ts'
import { checkSkillMdExists, type SkillMdValidation } from './skill-processor.ts'
import { repoUpdatedAtKey } from './skill-processor.helpers.ts'
import { delay, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import type { GitHubRepository } from './topic-search.ts'

/**
 * Phase 3a: Run root-level SKILL.md code search.
 *
 * Deduplicates against the shared seenUrls set (modified in place) so repos
 * already discovered via topic search are not re-validated.
 *
 * Note: license gate is NOT applied here — root-level SKILL.md repos are
 * predominantly Claude Code skills with permissive licenses. The license gate
 * is intentionally limited to Phase 3b where cross-ecosystem repos with mixed
 * licensing are more common; applying it here would require N extra
 * /repos/{owner}/{repo} API calls at significant rate-limit cost.
 *
 * SMI-4854: `existingRepoUpdatedAt` is the upstream skip-gate map. When
 * `repo.updatedAt` matches the prior upsert's `repo_updated_at`, bypass the
 * `checkSkillMdExists` HTTP fetch — saves ~500-800ms per unchanged repo.
 * Optional so callers without the prefetch (legacy tests) keep compiling.
 *
 * SMI-4852: `telemetry` is threaded into `searchCodeForSkillMd` and
 * `checkSkillMdExists`. Each downstream fetch wraps with `withRateLimitTracking`
 * so 403/429 incidents and `x-ratelimit-remaining` headers flow into the
 * run-scoped telemetry bag.
 */
export async function runCodeSearch(
  seenUrls: Set<string>,
  freshnessDate: string | undefined,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number },
  maxPages: number,
  telemetry: RateLimitTelemetry,
  existingRepoUpdatedAt?: Map<string, string | null>
): Promise<{
  repos: GitHubRepository[]
  repos_found: number
  retries: number
  error?: string
  skipGateHits?: number
}> {
  const repos: GitHubRepository[] = []
  let repos_found = 0
  let retries = 0
  let error: string | undefined
  let skipGateHits = 0

  for (let page = 1; page <= maxPages; page++) {
    const codeResult = await searchCodeForSkillMd(page, 30, freshnessDate, telemetry)
    retries += codeResult.retries
    if (codeResult.error) {
      error = codeResult.error
      break
    }
    for (const repo of codeResult.repos) {
      if (!seenUrls.has(repo.url)) {
        seenUrls.add(repo.url)
        // SMI-4854: skip-gate mirrors Phase 2 in discovery-orchestrator.ts.
        const cachedKey = existingRepoUpdatedAt?.get(repo.url)
        if (cachedKey != null && cachedKey === repoUpdatedAtKey(repo)) {
          skipGateHits++
          repos.push(repo)
          repos_found++
          continue
        }
        repo.installable = await checkSkillMdExists(
          repo.owner,
          repo.name,
          repo.defaultBranch,
          validationCache,
          telemetry,
          undefined,
          validationOptions
        )
        repos.push(repo)
        repos_found++
        await delay(50)
      }
    }
    if (codeResult.repos.length < 30) break
    // SMI-4846: 6s delay = code-search 10 rpm budget. Replace with
    // codeSearchTokenBucket in follow-up — see plan H-3. Phase 3a stays serial
    // in this PR; parallelizing without the dedicated bucket would 403-cascade
    // silently (the existing error handler treats 403 as non-fatal break).
    await delay(6000) // Code search rate limit: 10 req/min → 6s delay
  }

  return { repos, repos_found, retries, error, skipGateHits }
}
