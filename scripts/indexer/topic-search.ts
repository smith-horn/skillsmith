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
 * SMI-2662 / SMI-5175: countGitHubSkillFiles reports the DISTINCT universe via a
 * broad filename:SKILL.md query, with a per-ecosystem diagnostic breakdown.
 * SMI-2658: GitHubRepository and search response include license field from GitHub API.
 */

import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { validateGitHubParams, isValidGitHubTopic, sanitizeForLog } from './_shared/validation.ts'
import { buildSkillTreeUrl } from './skill-url.ts'
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
  // SMI-4861 Wave 1: git blob SHA of this skill's SKILL.md, when known.
  // Populated by Phase 1 wildcard expansion (Trees API) and by plain-path
  // repos when SKILLSMITH_TREE_HASH_PLAIN_PATH=true triggers an opportunistic
  // Trees fetch. Persisted into skills.tree_hash on UPSERT so the next cron
  // can skip the raw.* fetch when SHA + last_tree_hash_check < 24h match.
  treeHash?: string
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
    // SMI-5286 Wave 1a (§#6): light fork guard — skip forked repos.
    fork: boolean
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
  pushedAfter: string | undefined,
  telemetry: RateLimitTelemetry
): Promise<{ repos: GitHubRepository[]; total: number; error?: string }> {
  try {
    // SMI-2271: Validate topic before URL construction
    if (!isValidGitHubTopic(topic)) {
      return { repos: [], total: 0, error: `Invalid topic: ${sanitizeForLog(topic)}` }
    }

    // SMI-2576: Validate date format before URL construction
    if (pushedAfter && !/^\d{4}-\d{2}-\d{2}$/.test(pushedAfter)) {
      return { repos: [], total: 0, error: `Invalid date format: ${sanitizeForLog(pushedAfter)}` }
    }

    // Build query with optional freshness qualifier (pushed:> matches last-push activity,
    // not repo creation — SMI-5176 corrected created:> which only matched newly-created repos)
    let queryStr = `topic:${topic}`
    if (pushedAfter) {
      queryStr += ` pushed:>${pushedAfter}`
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
        // SMI-5286 Wave 1a (§#6): light fork guard — skip forked repos.
        if (item.fork) return false
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
        // SMI-5286 Wave 1a (§#1, C-1): topic-search knows only the repo root + a
        // root SKILL.md. Emit the per-skill tree URL for that single known path
        // (`${html_url}/tree/${branch}`) rather than the bare html_url so the row
        // carries a distinct, install-correct repo_url. Repos with multiple skills
        // are enumerated by the subdirectory path; topic-search stays root-only.
        url: buildSkillTreeUrl(item.html_url, item.default_branch, ''),
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
 * Per-ecosystem SKILL.md paths reported in the homepage-stat breakdown.
 * SMI-5175: extended from the original 3 (`.claude`/`.gemini`/`.github`) to every
 * indexed convention. The generic `skills` prefix is deliberately EXCLUDED: GitHub
 * code-search `path:` is a path-COMPONENT match, so `path:skills` is a superset of
 * every `.x/skills` entry — including it (or summing the per-path counts) would
 * double-count. These counts are diagnostic only and are NOT summed into `total`.
 */
const COUNT_BREAKDOWN_PATHS = [
  '.claude/skills', // Claude Code
  '.agents/skills', // cross-tool standard (Windsurf + Antigravity read it)
  '.github/skills', // GitHub Copilot
  '.agent/skills', // Antigravity (project-local, singular)
  '.codex/skills', // OpenAI Codex
  '.cursor/skills', // Cursor
  '.gemini/skills', // Gemini CLI
  '.windsurf/skills', // Windsurf (native)
  '.ai/skills', // cross-framework neutral
]

/**
 * SMI-2662 / SMI-5175: Count SKILL.md files on GitHub via the code-search API
 * for the "X skills on GitHub" homepage stat.
 *
 * `total` is the DISTINCT universe, measured by a single broad `filename:SKILL.md`
 * query (no `path:` constraint, ~107k). The pre-SMI-5175 implementation summed a
 * handful of per-path counts, which overshoots the distinct total (path-component
 * overlap) — see COUNT_BREAKDOWN_PATHS. `breakdown` is per-ecosystem diagnostics
 * and is intentionally NOT summed into `total`.
 *
 * Rate budget: 1 broad + COUNT_BREAKDOWN_PATHS.length code-search calls, spaced
 * 6s apart against the 10 req/min code-search limit. Runs once per cycle in the
 * finalize sub-slot (SMI-4870). When Phase 3b (SMI-5184) is enabled, the combined
 * finalize-slot code-search budget must be re-measured against the 30-min GHA run.
 *
 * SMI-4852: Threads `telemetry` and routes each fetch through
 * `withBackoff(withRateLimitTracking(...))` per Hard Rule 1.
 */
export async function countGitHubSkillFiles(telemetry: RateLimitTelemetry): Promise<{
  total: number
  breakdown: Record<string, number>
  error?: string
}> {
  const breakdown: Record<string, number> = {}
  let total = 0
  const errors: string[] = []

  /** Run one code-search count query; returns total_count or null on failure. */
  async function countQuery(rawQuery: string): Promise<number | null> {
    try {
      const query = encodeURIComponent(rawQuery)
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
          errors.push(`Rate limit (${response.status}) for "${rawQuery}". Remaining: ${remaining}`)
          return null
        }
        errors.push(`Code search error for "${rawQuery}": ${response.status}`)
        return null
      }

      const data = (await response.json()) as { total_count: number }
      return data.total_count
    } catch (error) {
      errors.push(
        `Network error for "${rawQuery}": ${error instanceof Error ? error.message : 'Unknown'}`
      )
      return null
    }
  }

  // 1) Authoritative distinct universe count (the homepage number).
  const broadTotal = await countQuery('filename:SKILL.md')
  if (broadTotal !== null) total = broadTotal
  // Code-search rate limit: 10 req/min — space queries 6s apart.
  await delay(6000)

  // 2) Per-ecosystem diagnostic breakdown (NOT summed into total).
  for (const path of COUNT_BREAKDOWN_PATHS) {
    const count = await countQuery(`path:${path} filename:SKILL.md`)
    if (count !== null) breakdown[path] = count
    if (path !== COUNT_BREAKDOWN_PATHS[COUNT_BREAKDOWN_PATHS.length - 1]) {
      await delay(6000)
    }
  }

  return {
    total,
    breakdown,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  }
}
