/**
 * Topic-based GitHub repository search (Node port)
 * @module scripts/indexer/topic-search
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/topic-search.ts`.
 * Body is byte-identical for the non-fetch logic; every GitHub HTTP call
 * is wrapped in `withBackoff(() => withRateLimitTracking(...))`
 * per Hard Rule 1 (retro 2026-05-10). Parity is guarded by
 * `scripts/indexer/tests/parity.test.ts`.
 *
 * Original SMI-2661: Added cross-ecosystem topics (gemini-skill, gemini-cli-skill, ai-coding-skill).
 * SMI-2662: countGitHubSkillFiles now sums .claude/skills, .gemini/skills, .github/skills.
 * SMI-2658: GitHubRepository and search response include license field from GitHub API.
 */

import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { validateGitHubParams, isValidGitHubTopic, sanitizeForLog } from './_shared/validation.ts'
import {
  GITHUB_API_DELAY,
  delay,
  withBackoff,
  withRateLimitTracking,
  type RateLimitTelemetry,
} from './_shared/rate-limit.ts'

/**
 * GitHub repository metadata
 */
export interface GitHubRepository {
  owner: string
  name: string
  fullName: string
  description: string | null
  url: string
  stars: number
  forks: number
  topics: string[]
  updatedAt: string
  defaultBranch: string
  installable: boolean
  // SMI-2376: Preserve GitHub repo name and skill path separately from display name.
  // `name` may be overridden by frontmatter metadata; these fields preserve the
  // original values needed for validation cache key construction.
  repoName: string
  skillPath?: string
  // SMI-2658: SPDX license identifier from GitHub API. Present for topic-search
  // repos (included in search response). Absent for code-search repos (requires
  // a separate fetchRepoLicense() call from license-filter.ts).
  license?: string | null
  // SMI-4387: Discovery path that surfaced this repo; used for per-run yield
  // attribution in audit_logs.metadata.discovery_path_counts. Stamped at the
  // discovery site (topic-search / code-search / high-trust) and consumed in
  // indexer-runners.ts runUpsertPhase after successful upsert.
  discoveryPath?: string
}

/**
 * GitHub API response
 */
interface GitHubSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: Array<{
    id: number
    full_name: string
    name: string
    owner: { login: string }
    description: string | null
    html_url: string
    stargazers_count: number
    forks_count: number
    topics: string[]
    updated_at: string
    default_branch: string
    // SMI-2658: License field from GitHub repository search API
    license: { spdx_id: string } | null
  }>
}

export const DEFAULT_TOPICS = [
  'claude-code-skill',
  'claude-code',
  'anthropic-claude',
  'claude-skill',
  // Phase 2a: Expanded discovery topics
  'claude-skills',
  'claude-code-plugin',
  'claude-plugin',
  // SMI-4388 (2026-04-21): Removed `gemini-skill`, `gemini-cli-skill`,
  // `ai-coding-skill` (SMI-2661 cross-ecosystem seeds). 2026-04-20 vendor-org
  // probe measured 0-1 repos total across all three — pure budget waste.
  // Gemini coverage retained via google-gemini/gemini-cli high-trust author
  // entry (.gemini/skills) — stronger discovery signal than topic-tagging.
  // Slot 18 redistributed to [claude-code-plugin, claude-plugin] in
  // topic-rotation.ts; slot 12 shrunk accordingly to preserve 3/2/2 balance.
]

// SMI-2575: Re-export from shared module for backward compatibility
export { GITHUB_API_DELAY, delay }

/**
 * Search GitHub repositories by topic.
 *
 * SMI-4852: Threads `telemetry` and routes the fetch through
 * `withBackoff(withRateLimitTracking(...))` per Hard Rule 1.
 */
export async function searchRepositories(
  topic: string,
  page: number,
  perPage = 30,
  createdAfter: string | undefined,
  telemetry: RateLimitTelemetry
): Promise<{ repos: GitHubRepository[]; total: number; error?: string }> {
  try {
    // SMI-2271: Validate topic before URL construction
    if (!isValidGitHubTopic(topic)) {
      return { repos: [], total: 0, error: `Invalid topic: ${sanitizeForLog(topic)}` }
    }

    // SMI-2576: Validate date format before URL construction
    if (createdAfter && !/^\d{4}-\d{2}-\d{2}$/.test(createdAfter)) {
      return { repos: [], total: 0, error: `Invalid date format: ${sanitizeForLog(createdAfter)}` }
    }

    // Build query with optional freshness qualifier
    let queryStr = `topic:${topic}`
    if (createdAfter) {
      queryStr += ` created:>${createdAfter}`
    }
    const query = encodeURIComponent(queryStr)
    const url = `https://api.github.com/search/repositories?q=${query}&per_page=${perPage}&page=${page}&sort=stars&order=desc`

    const response = await withBackoff(
      async () =>
        withRateLimitTracking(telemetry, url, {
          headers: await buildGitHubHeaders(),
        }),
      { baseMs: 1000, maxMs: 60000, maxRetries: 5 }
    )

    if (!response.ok) {
      if (response.status === 403) {
        const remaining = response.headers.get('X-RateLimit-Remaining')
        const reset = response.headers.get('X-RateLimit-Reset')
        return {
          repos: [],
          total: 0,
          error: `GitHub rate limit exceeded. Remaining: ${remaining}, Reset: ${reset}`,
        }
      }
      return {
        repos: [],
        total: 0,
        error: `GitHub API error: ${response.status}`,
      }
    }

    const data = (await response.json()) as GitHubSearchResponse

    // SMI-2271: Filter out repos with invalid identifiers before processing
    const repos: GitHubRepository[] = data.items
      .filter((item) => {
        try {
          validateGitHubParams(item.owner.login, item.name)
          return true
        } catch {
          console.log(`Skipping repo with invalid identifiers: ${sanitizeForLog(item.full_name)}`)
          return false
        }
      })
      .map((item) => ({
        owner: item.owner.login,
        name: item.name,
        fullName: item.full_name,
        description: item.description,
        url: item.html_url,
        stars: item.stargazers_count,
        forks: item.forks_count,
        topics: item.topics || [],
        updatedAt: item.updated_at,
        defaultBranch: item.default_branch,
        installable: false, // Will be checked separately
        // SMI-2376: For topic-search repos, name IS the GitHub repo name
        repoName: item.name,
        // SMI-2658: Capture SPDX license from search response (avoids extra API call)
        license: item.license?.spdx_id ?? null,
        // SMI-4387: Topic-search repos are root-level by convention; mark the file
        // location as empty-string (root) and stamp the discovery path for telemetry.
        skillPath: '',
        discoveryPath: `topic_search:${topic}`,
      }))

    return { repos, total: data.total_count }
  } catch (error) {
    return {
      repos: [],
      total: 0,
      error: `Network error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * SMI-2662: Count total SKILL.md files on GitHub via code search API.
 * Used for the "X skills on GitHub" stat on the homepage.
 *
 * SMI-4852: Threads `telemetry` and routes each fetch through
 * `withBackoff(withRateLimitTracking(...))` per Hard Rule 1.
 */
export async function countGitHubSkillFiles(telemetry: RateLimitTelemetry): Promise<{
  total: number
  breakdown: Record<string, number>
  error?: string
}> {
  const paths = ['.claude/skills', '.gemini/skills', '.github/skills']
  const breakdown: Record<string, number> = {}
  let total = 0
  const errors: string[] = []

  for (const path of paths) {
    try {
      const query = encodeURIComponent(`path:${path} filename:SKILL.md`)
      const url = `https://api.github.com/search/code?q=${query}&per_page=1`

      const response = await withBackoff(
        async () =>
          withRateLimitTracking(telemetry, url, {
            headers: await buildGitHubHeaders(),
          }),
        { baseMs: 1000, maxMs: 60000, maxRetries: 5 }
      )

      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          const remaining = response.headers.get('X-RateLimit-Remaining')
          errors.push(`Rate limit (${response.status}) for path:${path}. Remaining: ${remaining}`)
          continue
        }
        errors.push(`Code search error for path:${path}: ${response.status}`)
        continue
      }

      const data = (await response.json()) as { total_count: number }
      breakdown[path] = data.total_count
      total += data.total_count

      // Code search rate limit: 10 req/min — delay between path queries.
      // Skip delay after the last path to avoid adding 6s to every invocation.
      if (path !== paths[paths.length - 1]) {
        await delay(6000)
      }
    } catch (error) {
      errors.push(
        `Network error for path:${path}: ${error instanceof Error ? error.message : 'Unknown'}`
      )
    }
  }

  return {
    total,
    breakdown,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  }
}
