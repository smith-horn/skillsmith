/**
 * GitHub Code Search for SKILL.md discovery (Node port)
 * @module scripts/indexer/code-search
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/code-search.ts`.
 * Body is byte-identical except every GitHub HTTP call routes
 * through `withRateLimitTracking(telemetry, ...)` per Hard Rule 1
 * (retro 2026-05-10). Telemetry is threaded as the trailing parameter on every
 * exported function. Parity is guarded by `scripts/indexer/tests/parity.test.ts`.
 *
 * The wrapper is invoked with `_throwOnRateLimit: false` so the existing
 * exponential-backoff retry loop (which returns a structured error + retry
 * count in the result object) is preserved verbatim — telemetry is purely
 * additive. Retry-count semantics are part of the return contract callers
 * depend on (see indexer-runners.codesearch.ts).
 *
 * Original module docs:
 *
 * Phase 2b: Discovers repositories containing SKILL.md files via GitHub's
 * Code Search API. This complements topic-based search by finding repos
 * that lack topic tags but still contain valid skills.
 *
 * Phase 3b (SMI-2657): Adds subdirectory-aware search for cross-ecosystem paths
 * (.gemini/skills, .github/skills, skills/). Each subdirectory path requires a
 * separate code search query because the GitHub code search API does not support
 * OR on path: qualifiers.
 *
 * Rate limit: 10 requests/minute (separate from main API).
 * Retry: Exponential backoff (1s, 2s, 4s) on 403/429.
 */

import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { validateGitHubParams, sanitizeForLog } from './_shared/validation.ts'
import { delay, withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import type { GitHubRepository } from './topic-search.ts'

/**
 * Code search API response
 */
interface CodeSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: Array<{
    name: string
    path: string
    repository: {
      id: number
      full_name: string
      name: string
      owner: { login: string }
      description: string | null
      html_url: string
      stargazers_count: number
      forks_count: number
      topics: string[]
      default_branch: string
    }
  }>
}

/**
 * Retry delays for exponential backoff (ms)
 */
const RETRY_DELAYS = [1000, 2000, 4000]

/**
 * Search GitHub Code Search API for repositories containing SKILL.md files.
 *
 * SMI-4852: Threads `telemetry` and wraps each fetch in
 * `withRateLimitTracking(_throwOnRateLimit: false)` so telemetry is recorded
 * without disrupting the function's explicit retry-count return semantics.
 */
export async function searchCodeForSkillMd(
  page: number,
  perPage = 30,
  createdAfter: string | undefined,
  telemetry: RateLimitTelemetry
): Promise<{ repos: GitHubRepository[]; total: number; retries: number; error?: string }> {
  // SMI-2576: Validate date format before URL construction
  if (createdAfter && !/^\d{4}-\d{2}-\d{2}$/.test(createdAfter)) {
    return {
      repos: [],
      total: 0,
      retries: 0,
      error: `Invalid date format: ${sanitizeForLog(createdAfter)}`,
    }
  }

  // Build query: find root-level SKILL.md files
  let queryStr = 'filename:SKILL.md path:/'
  if (createdAfter) {
    queryStr += ` created:>${createdAfter}`
  }
  const query = encodeURIComponent(queryStr)
  const url = `https://api.github.com/search/code?q=${query}&per_page=${perPage}&page=${page}`

  let retries = 0

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await withRateLimitTracking(telemetry, url, {
        headers: await buildGitHubHeaders(),
        _throwOnRateLimit: false,
      })

      if (response.ok) {
        const data = (await response.json()) as CodeSearchResponse
        const seen = new Set<string>()

        const repos: GitHubRepository[] = data.items
          .filter((item) => {
            // Deduplicate: code search can return multiple SKILL.md per repo
            const key = item.repository.full_name
            if (seen.has(key)) return false
            seen.add(key)
            try {
              validateGitHubParams(item.repository.owner.login, item.repository.name)
              return true
            } catch {
              console.log(
                `[CodeSearch] Skipping invalid: ${sanitizeForLog(item.repository.full_name)}`
              )
              return false
            }
          })
          .map((item) => ({
            owner: item.repository.owner.login,
            name: item.repository.name,
            fullName: item.repository.full_name,
            description: item.repository.description,
            url: item.repository.html_url,
            stars: item.repository.stargazers_count,
            forks: item.repository.forks_count,
            topics: item.repository.topics || [],
            updatedAt: new Date().toISOString(),
            defaultBranch: item.repository.default_branch,
            installable: false,
            repoName: item.repository.name,
            // SMI-4387: Root-level code-search uses `path:/` — file is at repo root.
            skillPath: '',
            discoveryPath: 'root_code_search',
          }))

        return { repos, total: data.total_count, retries }
      }

      // Rate limit or secondary rate limit
      if (response.status === 403 || response.status === 429) {
        if (attempt < RETRY_DELAYS.length) {
          const delayMs = RETRY_DELAYS[attempt]
          console.log(
            `[CodeSearch] Rate limited (${response.status}), retrying in ${delayMs}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})`
          )
          await delay(delayMs)
          retries++
          continue
        }
        // All retries exhausted
        const remaining = response.headers.get('X-RateLimit-Remaining')
        return {
          repos: [],
          total: 0,
          retries,
          error: `Code search rate limit exhausted after ${RETRY_DELAYS.length} retries. Remaining: ${remaining}`,
        }
      }

      return {
        repos: [],
        total: 0,
        retries,
        error: `Code search error: ${response.status}`,
      }
    } catch (error) {
      if (attempt < RETRY_DELAYS.length) {
        const delayMs = RETRY_DELAYS[attempt]
        console.log(`[CodeSearch] Network error, retrying in ${delayMs}ms`)
        await delay(delayMs)
        retries++
        continue
      }
      return {
        repos: [],
        total: 0,
        retries,
        error: `Code search network error: ${error instanceof Error ? error.message : 'Unknown'}`,
      }
    }
  }

  // Should not reach here, but TypeScript needs it
  return { repos: [], total: 0, retries, error: 'Unexpected code path' }
}

/**
 * SMI-2657: Extract the skill directory path from a code search item path.
 *
 * Code search returns the full file path (e.g. '.gemini/skills/pr-creator/SKILL.md').
 * This strips the trailing '/SKILL.md' to get the containing directory, which
 * becomes the `skillPath` used for validation and install-time URL construction.
 *
 * @example
 * extractSkillPath('.gemini/skills/pr-creator/SKILL.md') // '.gemini/skills/pr-creator'
 * extractSkillPath('.github/skills/commit/SKILL.md')     // '.github/skills/commit'
 * extractSkillPath('skills/docker/SKILL.md')             // 'skills/docker'
 */
export function extractSkillPath(itemPath: string): string {
  return itemPath.replace(/\/SKILL\.md$/i, '')
}

/**
 * SMI-2657: Search GitHub Code Search API for SKILL.md files, optionally
 * scoped to a subdirectory path prefix.
 *
 * SMI-4852: Threads `telemetry` and wraps each fetch in
 * `withRateLimitTracking(_throwOnRateLimit: false)`.
 */
export async function searchCodeForSkillMdInSubdirectory(
  pathPrefix: string | undefined,
  page: number,
  perPage = 30,
  createdAfter: string | undefined,
  telemetry: RateLimitTelemetry
): Promise<{
  repos: GitHubRepository[]
  total: number
  retries: number
  incomplete_results: boolean
  error?: string
}> {
  // SMI-2576: Validate date format before URL construction
  if (createdAfter && !/^\d{4}-\d{2}-\d{2}$/.test(createdAfter)) {
    return {
      repos: [],
      total: 0,
      retries: 0,
      incomplete_results: false,
      error: `Invalid date format: ${sanitizeForLog(createdAfter)}`,
    }
  }

  // Reject path prefixes with leading/trailing slashes to match DB CHECK constraint
  if (pathPrefix && (pathPrefix.startsWith('/') || pathPrefix.endsWith('/'))) {
    return {
      repos: [],
      total: 0,
      retries: 0,
      incomplete_results: false,
      error: `Invalid pathPrefix (no leading/trailing slashes): ${sanitizeForLog(pathPrefix)}`,
    }
  }

  // Build query: broad (no path constraint) or scoped to pathPrefix
  let queryStr = pathPrefix ? `filename:SKILL.md path:${pathPrefix}` : 'filename:SKILL.md'
  if (createdAfter) {
    queryStr += ` created:>${createdAfter}`
  }
  const query = encodeURIComponent(queryStr)
  const url = `https://api.github.com/search/code?q=${query}&per_page=${perPage}&page=${page}`

  let retries = 0

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await withRateLimitTracking(telemetry, url, {
        headers: await buildGitHubHeaders(),
        _throwOnRateLimit: false,
      })

      if (response.ok) {
        const data = (await response.json()) as CodeSearchResponse

        const pathLabel = pathPrefix ? `path:${sanitizeForLog(pathPrefix)}` : 'broad'

        if (data.incomplete_results) {
          console.warn(
            `[CodeSearch] Incomplete results for ${pathLabel} p${page} — query timed out, results may be partial`
          )
        }

        const seen = new Set<string>()

        const repos: GitHubRepository[] = data.items
          .filter((item) => {
            const skillPath = extractSkillPath(item.path)

            // Reject path traversal sequences — prevents ../ escapes from GitHub results
            if (skillPath.includes('..')) {
              console.log(`[CodeSearch] Rejecting traversal path: ${sanitizeForLog(item.path)}`)
              return false
            }

            // Deduplicate by repo + skillPath: one repo can have multiple skills
            const key = `${item.repository.full_name}/${skillPath}`
            if (seen.has(key)) return false
            seen.add(key)
            try {
              validateGitHubParams(item.repository.owner.login, item.repository.name)
              return true
            } catch {
              console.log(
                `[CodeSearch] Skipping invalid: ${sanitizeForLog(item.repository.full_name)}`
              )
              return false
            }
          })
          .map((item) => ({
            owner: item.repository.owner.login,
            name: item.repository.name,
            fullName: item.repository.full_name,
            description: item.repository.description,
            url: item.repository.html_url,
            stars: item.repository.stargazers_count,
            forks: item.repository.forks_count,
            topics: item.repository.topics || [],
            // Code search API does not include repository updated_at — current
            // time is used as an approximation. The field reflects when the
            // indexer ran, not when the repository was last pushed.
            updatedAt: new Date().toISOString(),
            defaultBranch: item.repository.default_branch,
            installable: false,
            repoName: item.repository.name,
            // SMI-2657: Populate skillPath from the item path in the response
            skillPath: extractSkillPath(item.path),
            // SMI-4387: `broad` sentinel matches the pre-existing pathLabel pattern
            // below (line ~327) for pathPrefix=undefined; dashboards should match
            // WHERE key LIKE 'subdirectory_search:%' to capture both variants.
            discoveryPath: `subdirectory_search:${pathPrefix ?? 'broad'}`,
          }))

        return {
          repos,
          total: data.total_count,
          retries,
          incomplete_results: data.incomplete_results,
        }
      }

      const pathLabel = pathPrefix ? `path:${sanitizeForLog(pathPrefix)}` : 'broad'

      // Rate limit or secondary rate limit
      if (response.status === 403 || response.status === 429) {
        if (attempt < RETRY_DELAYS.length) {
          const delayMs = RETRY_DELAYS[attempt]
          console.log(
            `[CodeSearch] Rate limited (${response.status}) for ${pathLabel}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})`
          )
          await delay(delayMs)
          retries++
          continue
        }
        const remaining = response.headers.get('X-RateLimit-Remaining')
        return {
          repos: [],
          total: 0,
          retries,
          incomplete_results: false,
          error: `Code search rate limit exhausted for ${pathLabel} after ${RETRY_DELAYS.length} retries. Remaining: ${remaining}`,
        }
      }

      return {
        repos: [],
        total: 0,
        retries,
        incomplete_results: false,
        error: `Code search error for ${pathLabel}: ${response.status}`,
      }
    } catch (error) {
      const pathLabel = pathPrefix ? `path:${sanitizeForLog(pathPrefix)}` : 'broad'
      if (attempt < RETRY_DELAYS.length) {
        const delayMs = RETRY_DELAYS[attempt]
        console.log(`[CodeSearch] Network error for ${pathLabel}, retrying in ${delayMs}ms`)
        await delay(delayMs)
        retries++
        continue
      }
      return {
        repos: [],
        total: 0,
        retries,
        incomplete_results: false,
        error: `Code search network error for ${pathLabel}: ${error instanceof Error ? error.message : 'Unknown'}`,
      }
    }
  }

  return { repos: [], total: 0, retries, incomplete_results: false, error: 'Unexpected code path' }
}
