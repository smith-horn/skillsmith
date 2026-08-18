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
import { buildSkillTreeUrl } from './skill-url.ts'
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
      // SMI-5286 Wave 1a (§#6): light fork guard — skip forked repos.
      fork: boolean
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
 * GitHub code-search retrievable-results ceiling per query (any query caps
 * here, regardless of `total_count`). SMI-5286 1c originally defined this
 * locally in `subdirectory-search.helpers.ts` for bisection triggering;
 * exported from here (SMI-6073) and re-imported there so both the bisection
 * trigger and the degraded-response pagination-bounds check below share one
 * source of truth instead of two independently-maintained copies.
 */
export const CODE_SEARCH_RESULT_CAP = 1000

/**
 * SMI-6073: retry delay (ms) for a SINGLE degraded-response retry —
 * deliberately distinct from `RETRY_DELAYS` (the 403/429 exponential-backoff
 * ladder, 1s/2s/4s). That ladder's cadence is tuned for a RATE-LIMIT signal;
 * retrying a CONTENT anomaly (200 + `total_count > 0` + `items: []`) on the
 * same aggressive cadence risks tripping the very 10-req/min code-search
 * bucket this is trying to avoid. Matches the bucket's own established
 * inter-page cadence instead (10 code-search req/min -> 6s between pages,
 * `subdirectory-search.helpers.ts`). Exported so tests can derive a
 * deadline-imminent scenario from the real value instead of a guessed magic
 * number (see `code-search.test.ts`).
 */
export const DEGRADED_RESPONSE_RETRY_DELAY_MS = 6000

/**
 * Search GitHub Code Search API for repositories containing SKILL.md files.
 *
 * SMI-4852: Threads `telemetry` and wraps each fetch in
 * `withRateLimitTracking(_throwOnRateLimit: false)` so telemetry is recorded
 * without disrupting the function's explicit retry-count return semantics.
 */
export async function searchCodeForSkillMd(
  page: number,
  // SMI-5286 1c: default per_page raised 30 → 100 (GitHub max) so each page
  // drains the 1000-result ceiling in fewer requests. The root phase stays
  // disabled in 1c, so no size facet is threaded here.
  perPage = 100,
  telemetry: RateLimitTelemetry
): Promise<{ repos: GitHubRepository[]; total: number; retries: number; error?: string }> {
  // Build query: find root-level SKILL.md files.
  // SMI-5176: date qualifiers (created:>/pushed:>) are NOT functional on GitHub
  // code search — they are tokenized as free-text content, crushing results to
  // files that literally contain the date string. No freshness qualifier here.
  const queryStr = 'filename:SKILL.md path:/'
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
            // SMI-5286 Wave 1a (§#6): light fork guard — forks are ~0% of the
            // searchable population; skip them to cut noise without dedup cost.
            if (item.repository.fork) return false
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
            // SMI-5286 Wave 1a (§#1, C-1): per-skill tree URL (root SKILL.md →
            // `${html_url}/tree/${branch}`) so rows never collide on repo_url.
            url: buildSkillTreeUrl(item.repository.html_url, item.repository.default_branch, ''),
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
  // SMI-5286 1c: default per_page raised 30 → 100 (GitHub max).
  perPage = 100,
  telemetry: RateLimitTelemetry,
  // SMI-5286 1c: optional pre-formatted GitHub `size:` qualifier (e.g.
  // `size:0..127`) appended to the query so the broad backfill can partition the
  // 1000-result-capped query by file size. The caller (the facet driver) formats
  // it via code-search.facets.ts; this file stays free of the facet dependency.
  sizeQualifier?: string,
  // SMI-6073: absolute wall-clock deadline (ms, `Date.now()`-comparable) for
  // the SMI-5964 per-dispatch elapsed budget. When supplied, the degraded-
  // response retry below is skipped (falls straight to the error return)
  // once fewer than one retry-delay's worth of budget remains — a wasted
  // retry this close to a hard timeout would only shrink the window left to
  // checkpoint cleanly. `undefined` = no deadline (byte-identical to the
  // pre-SMI-6073 unbounded case).
  deadlineAtMs?: number
): Promise<{
  repos: GitHubRepository[]
  total: number
  retries: number
  incomplete_results: boolean
  error?: string
}> {
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

  // Build query: broad (no path constraint) or scoped to pathPrefix.
  // SMI-5176: date qualifiers (created:>/pushed:>) are NOT functional on GitHub
  // code search — they are tokenized as free-text content. No freshness qualifier.
  const baseQuery = pathPrefix ? `filename:SKILL.md path:${pathPrefix}` : 'filename:SKILL.md'
  // SMI-5286 1c: append the size facet qualifier (already INCLUSIVE-INCLUSIVE,
  // e.g. `size:0..127`) BEFORE encoding so the partitioned backfill stays under
  // the 1000-result ceiling. The qualifier is part of queryStr pre-encode.
  const queryStr = sizeQualifier ? `${baseQuery} ${sizeQualifier}` : baseQuery
  const query = encodeURIComponent(queryStr)
  const url = `https://api.github.com/search/code?q=${query}&per_page=${perPage}&page=${page}`

  let retries = 0
  // SMI-6073: the degraded retry's ENTIRE budget (at most one use), tracked
  // fully independently of `rateLimitAttempt` below. GPT-5.6-Sol review
  // (2026-08-17): an earlier version shared one `for`-loop counter between
  // the two, so a degraded retry could silently steal one of the 403/429
  // ladder's 3 retries (and its "after N retries" message would then lie
  // about what actually happened) — neither counter reads or writes the other.
  let degradedRetryUsed = false
  // SMI-6073: the 403/429 (+ network-error, pre-existing shared semantics —
  // unchanged here) retry ladder's own counter, independent of the above.
  let rateLimitAttempt = 0

  while (true) {
    try {
      const response = await withRateLimitTracking(telemetry, url, {
        headers: await buildGitHubHeaders(),
        _throwOnRateLimit: false,
      })

      if (response.ok) {
        const data = (await response.json()) as CodeSearchResponse

        const pathLabel = pathPrefix ? `path:${sanitizeForLog(pathPrefix)}` : 'broad'

        // SMI-6073: degraded-response detection. GitHub's code-search endpoint
        // can return HTTP 200 with a nonzero `total_count` but empty `items`
        // (the documented query-timeout-degrades-to-partial-results behavior —
        // see the SMI-6073 plan's Context section). Checked against the RAW
        // `data.items` array, NEVER the post-filter `repos` built below — a
        // page where GitHub returned real items but every one was a
        // fork/duplicate/invalid entry is a legitimate empty result, not
        // degradation. Also requires the requested page to be within GitHub's
        // retrievable range (`(page-1)*perPage` under `min(total_count, cap)`)
        // — a page requested past the actual result count is legitimately
        // empty too, not degraded.
        const pageWithinRetrievableRange =
          (page - 1) * perPage < Math.min(data.total_count, CODE_SEARCH_RESULT_CAP)
        const isDegradedResponse =
          data.items.length === 0 && data.total_count > 0 && pageWithinRetrievableRange

        if (isDegradedResponse) {
          const deadlineImminent =
            deadlineAtMs !== undefined &&
            Date.now() + DEGRADED_RESPONSE_RETRY_DELAY_MS >= deadlineAtMs
          if (!degradedRetryUsed && !deadlineImminent) {
            degradedRetryUsed = true
            console.warn(
              `[CodeSearch] Degraded response for ${pathLabel} p${page} (total_count=${data.total_count}, items=0) -- retrying once in ${DEGRADED_RESPONSE_RETRY_DELAY_MS}ms`
            )
            await delay(DEGRADED_RESPONSE_RETRY_DELAY_MS)
            retries++
            continue
          }
          const requestId = response.headers.get('x-github-request-id')
          const reason = deadlineImminent
            ? 'elapsed-budget deadline imminent, retry skipped'
            : 'retried once, still degraded'
          console.warn(
            `[CodeSearch] Degraded response persisted for ${pathLabel} p${page} (${reason}) (x-github-request-id: ${requestId ?? 'unknown'})`
          )
          return {
            repos: [],
            total: 0,
            retries,
            incomplete_results: false,
            error: `Code search degraded response for ${pathLabel} p${page}: total_count=${data.total_count} but items=0 (${reason}) (x-github-request-id: ${requestId ?? 'unknown'})`,
          }
        }

        if (data.incomplete_results) {
          console.warn(
            `[CodeSearch] Incomplete results for ${pathLabel} p${page} — query timed out, results may be partial`
          )
        }

        const seen = new Set<string>()

        const repos: GitHubRepository[] = data.items
          .filter((item) => {
            // SMI-5286 Wave 1a (§#6): light fork guard — skip forked repos.
            if (item.repository.fork) return false

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
            // SMI-5286 Wave 1a (§#1, C-1): per-skill tree URL keyed on this result's
            // SKILL.md path so N skills in one repo yield N distinct repo_url rows.
            url: buildSkillTreeUrl(
              item.repository.html_url,
              item.repository.default_branch,
              extractSkillPath(item.path)
            ),
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
        if (rateLimitAttempt < RETRY_DELAYS.length) {
          const delayMs = RETRY_DELAYS[rateLimitAttempt]
          console.log(
            `[CodeSearch] Rate limited (${response.status}) for ${pathLabel}, retrying in ${delayMs}ms (attempt ${rateLimitAttempt + 1}/${RETRY_DELAYS.length})`
          )
          await delay(delayMs)
          retries++
          rateLimitAttempt++
          continue
        }
        const remaining = response.headers.get('X-RateLimit-Remaining')
        // SMI-6073: capture x-github-request-id at the point of the outcome —
        // read directly off THIS Response, not threaded through shared
        // telemetry, so it can't be misattributed under concurrent calls.
        const requestId = response.headers.get('x-github-request-id')
        console.warn(
          `[CodeSearch] Rate limit exhausted for ${pathLabel} (x-github-request-id: ${requestId ?? 'unknown'})`
        )
        return {
          repos: [],
          total: 0,
          retries,
          incomplete_results: false,
          error: `Code search rate limit exhausted for ${pathLabel} after ${RETRY_DELAYS.length} retries. Remaining: ${remaining} (x-github-request-id: ${requestId ?? 'unknown'})`,
        }
      }

      {
        // SMI-6073: same request-id capture for any other non-ok status.
        const requestId = response.headers.get('x-github-request-id')
        console.warn(
          `[CodeSearch] Error for ${pathLabel}: ${response.status} (x-github-request-id: ${requestId ?? 'unknown'})`
        )
        return {
          repos: [],
          total: 0,
          retries,
          incomplete_results: false,
          error: `Code search error for ${pathLabel}: ${response.status} (x-github-request-id: ${requestId ?? 'unknown'})`,
        }
      }
    } catch (error) {
      const pathLabel = pathPrefix ? `path:${sanitizeForLog(pathPrefix)}` : 'broad'
      if (rateLimitAttempt < RETRY_DELAYS.length) {
        const delayMs = RETRY_DELAYS[rateLimitAttempt]
        console.log(`[CodeSearch] Network error for ${pathLabel}, retrying in ${delayMs}ms`)
        await delay(delayMs)
        retries++
        rateLimitAttempt++
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
}
