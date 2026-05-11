/**
 * GitHub Trees API integration for depth-agnostic SKILL.md discovery (Node port)
 * @module scripts/indexer/trees-search
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/trees-search.ts`.
 * Body is byte-identical except every GitHub HTTP call routes
 * through `withRateLimitTracking(telemetry, ..., _throwOnRateLimit: false)`
 * per Hard Rule 1 (retro 2026-05-10). Telemetry is threaded through to
 * preserve the explicit retry loop the result-shape callers depend on.
 * Parity is guarded by `scripts/indexer/tests/parity.test.ts`.
 *
 * Original module docs:
 *
 * SMI-2672: Extends high-trust author discovery to support wildcard skillsPaths
 * (e.g. 'plugins/star/skills') by fetching the full repository file tree and
 * filtering locally. Depth is irrelevant — all SKILL.md files at any depth
 * are returned in a single API call.
 *
 * Glob depth assumption: single star matches one non-slash path segment ([^/]+).
 * If a future publisher requires multi-segment wildcard (starstar), the
 * globToSkillMdRegex() function already supports it via '(?:[^/]+/)*[^/]*'
 * — no interface change to skillsPaths is required. See globToSkillMdRegex docs.
 *
 * Trees API rate limit: same bucket as main GitHub API (5,000 req/hr).
 * Separate from code search budget (10 req/min).
 *
 * Branch ref note: trees API accepts both branch names and commit SHAs.
 * Callers should pass repoData.default_branch (branch name). This is
 * simpler and always resolves to the current HEAD of that branch.
 */

import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { delay, withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'

/** Retry delays for exponential backoff on rate-limit responses (ms) */
const RETRY_DELAYS = [1000, 2000, 4000]

/**
 * A single entry in the GitHub Trees API response
 */
interface TreeEntry {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
  url: string
}

/**
 * GitHub Trees API response shape
 */
interface TreesApiResponse {
  sha: string
  url: string
  tree: TreeEntry[]
  truncated: boolean
}

/**
 * A SKILL.md entry resolved from the Trees API, carrying the parent directory
 * path AND the git blob SHA. SMI-4861 Wave 1 introduces the SHA so per-skill
 * tree-hash TTL cache lookups can decide whether to skip the raw.* fetch.
 */
export interface TreeSkillEntry {
  path: string
  blobSha: string
}

/**
 * Fetch all SKILL.md entries from a repository's git tree using the recursive
 * Trees API. Returns the parent directory path AND blob SHA for each match.
 *
 * SMI-4852: Threads `telemetry` and wraps each fetch in
 * `withRateLimitTracking(_throwOnRateLimit: false)` to record telemetry
 * without disrupting the existing retry-count contract.
 *
 * SMI-4861 Wave 1: Return shape changed from `{paths: string[], ...}` to
 * `{entries: TreeSkillEntry[], ...}` to thread the blob SHA through to the
 * tree-hash cache gate. Callers that only need paths read `entry.path`.
 *
 * @param owner - GitHub repository owner (org or user)
 * @param repo - Repository name
 * @param treeRef - Branch name or commit SHA (e.g. 'main').
 * @param telemetry - Shared rate-limit telemetry collector.
 */
export async function fetchSkillPathsFromTree(
  owner: string,
  repo: string,
  treeRef: string,
  telemetry: RateLimitTelemetry
): Promise<{ entries: TreeSkillEntry[]; truncated: boolean; errors: string[] }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeRef}?recursive=1`
  const fetchErrors: string[] = []

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await withRateLimitTracking(telemetry, url, {
        headers: await buildGitHubHeaders(),
        _throwOnRateLimit: false,
      })

      if (response.ok) {
        const data = (await response.json()) as TreesApiResponse

        // Collect parent directories + blob SHAs of all SKILL.md blob entries
        const skillEntries: TreeSkillEntry[] = []
        for (const entry of data.tree) {
          if (entry.type !== 'blob') continue
          // Match SKILL.md case-insensitively at any depth
          if (!entry.path.endsWith('/SKILL.md') && entry.path.toUpperCase() !== 'SKILL.MD') continue
          const slashIdx = entry.path.lastIndexOf('/')
          if (slashIdx < 0) continue // root SKILL.md — no parent dir to extract
          skillEntries.push({ path: entry.path.slice(0, slashIdx), blobSha: entry.sha })
        }

        if (data.truncated) {
          const truncMsg = `Tree truncated for ${owner}/${repo} — some skill paths may be missing`
          console.warn(`[Trees] WARNING: ${truncMsg}`)
          fetchErrors.push(truncMsg)
        }

        return { entries: skillEntries, truncated: data.truncated, errors: fetchErrors }
      }

      // Rate limit — retry with backoff
      if (response.status === 403 || response.status === 429) {
        if (attempt < RETRY_DELAYS.length) {
          const delayMs = RETRY_DELAYS[attempt]
          console.log(
            `[Trees] Rate limited for ${owner}/${repo}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})`
          )
          await delay(delayMs)
          continue
        }
        const remaining = response.headers.get('X-RateLimit-Remaining')
        console.log(`[Trees] Rate limit exhausted for ${owner}/${repo}. Remaining: ${remaining}`)
        return {
          entries: [],
          truncated: false,
          errors: [`Rate limit exhausted fetching tree for ${owner}/${repo}`],
        }
      }

      // Non-retryable HTTP error (404, 5xx, etc.)
      console.log(`[Trees] HTTP ${response.status} for ${owner}/${repo}`)
      return {
        entries: [],
        truncated: false,
        errors: [`HTTP ${response.status} fetching tree for ${owner}/${repo}`],
      }
    } catch (err) {
      if (attempt < RETRY_DELAYS.length) {
        const delayMs = RETRY_DELAYS[attempt]
        console.log(
          `[Trees] Network error for ${owner}/${repo}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})`
        )
        await delay(delayMs)
        continue
      }
      console.log(
        `[Trees] Network error exhausted retries for ${owner}/${repo}: ${err instanceof Error ? err.message : 'Unknown'}`
      )
      return {
        entries: [],
        truncated: false,
        errors: [`Network error fetching tree for ${owner}/${repo}`],
      }
    }
  }

  return {
    entries: [],
    truncated: false,
    errors: [`Failed to fetch tree for ${owner}/${repo} after all retries`],
  }
}

// Convert a glob pattern to a RegExp that matches SKILL.md paths in a repository tree.
//
// Rules:
//   - Single star matches one non-slash path segment ([^/]+)
//   - Double star matches any depth including slashes
//   - All other glob characters are regex-escaped
//   - Pattern is anchored (^...$) against the full SKILL.md path
//
// Glob depth assumption: single star is designed for patterns like 'plugins/{name}/skills'
// where there is exactly one variable path segment. Covers all known high-trust layouts.
//
// The regex filters the flat path list returned by fetchSkillPathsFromTree.
// Input paths are SKILL.md parent directories, so the regex matches
// parentDir + '/SKILL.md'.
export function globToSkillMdRegex(glob: string): RegExp {
  let regexStr = ''
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      // '**' → match any depth including slashes
      regexStr += '(?:[^/]+/)*[^/]*'
      i += 2
    } else if (ch === '*') {
      // '*' → match exactly one non-slash path segment
      regexStr += '[^/]+'
      i += 1
    } else {
      // Escape regex special characters in literal parts
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }

  // The glob pattern covers up to the skills base directory.
  // Below that, there is exactly one skill directory ([^/]+), then SKILL.md.
  const fullPattern = `^${regexStr}/[^/]+/SKILL\\.md$`
  return new RegExp(fullPattern, 'i')
}

/**
 * Result of expandGlobSkillsPaths
 *
 * SMI-4861 Wave 1: `resolved` entries now carry `blobSha` so the per-skill
 * tree-hash TTL cache can match against the stored `tree_hash` column. Plain
 * (non-wildcard) paths remain bare strings because their blob SHAs are only
 * known when `SKILLSMITH_TREE_HASH_PLAIN_PATH=true` opts the repo into an
 * opportunistic Trees fetch — see fetchPlainPathTreeMap below.
 */
export interface ExpandGlobResult {
  /** Resolved skill entries (parent dirs + blob SHAs of matched SKILL.md files) */
  resolved: TreeSkillEntry[]
  /** Plain (non-wildcard) paths returned separately for Contents API scanning */
  plainPaths: string[]
  /** True if any Trees API fetch failed (partial or total) */
  fetchFailed: boolean
  /** Count of paths produced by wildcard expansion (for observability) */
  wildcardExpansionCount: number
  /** Number of Trees API calls made (one per repository with wildcard patterns) */
  treesApiCallCount: number
  /** Number of repositories where the Trees API response was truncated */
  truncatedResponseCount: number
}

/**
 * Given a list of skillsPaths entries (may contain wildcards) for a repository,
 * resolve them to concrete skill directory paths:
 *
 * - Entries without '*': returned as-is (pass-through, no API call)
 * - Entries with '*': fetched via Trees API and matched against the glob pattern
 *
 * Only one Trees API call is made per repository regardless of how many wildcard
 * patterns are configured, since the recursive tree covers the entire repository.
 *
 * SMI-4852: Threads `telemetry` through to the underlying Trees API fetch.
 *
 * @param owner - GitHub repository owner
 * @param repo - Repository name
 * @param skillsPaths - skillsPaths entries from HighTrustAuthor config
 * @param treeRef - Branch name or commit SHA to pass to fetchSkillPathsFromTree
 * @param telemetry - Shared rate-limit telemetry collector.
 */
export async function expandGlobSkillsPaths(
  owner: string,
  repo: string,
  skillsPaths: string[],
  treeRef: string,
  telemetry: RateLimitTelemetry
): Promise<ExpandGlobResult> {
  const wildcardPaths = skillsPaths.filter((p) => p.includes('*'))
  const plainPaths = skillsPaths.filter((p) => !p.includes('*'))

  const resolved: TreeSkillEntry[] = []
  let fetchFailed = false
  let wildcardExpansionCount = 0
  let treesApiCallCount = 0
  let truncatedResponseCount = 0

  if (wildcardPaths.length === 0) {
    // No wildcards — return plain paths immediately without any API call
    return {
      resolved,
      plainPaths,
      fetchFailed: false,
      wildcardExpansionCount: 0,
      treesApiCallCount: 0,
      truncatedResponseCount: 0,
    }
  }

  // Fetch the full tree once for all wildcard patterns
  treesApiCallCount = 1
  const {
    entries: treeEntries,
    truncated,
    errors: treeErrors,
  } = await fetchSkillPathsFromTree(owner, repo, treeRef, telemetry)

  if (treeErrors.length > 0 && treeEntries.length === 0) {
    // Fetch failed entirely (not just truncated)
    fetchFailed = true
    return {
      resolved,
      plainPaths,
      fetchFailed,
      wildcardExpansionCount,
      treesApiCallCount,
      truncatedResponseCount,
    }
  }

  if (truncated) {
    // Partial results — mark as fetch failed for error reporting but still use
    // whatever paths we got (partial discovery is better than none)
    fetchFailed = true
    truncatedResponseCount = 1
  }

  // Match each wildcard pattern against the tree paths
  const seen = new Set<string>(plainPaths)
  for (const wildcardPattern of wildcardPaths) {
    const regex = globToSkillMdRegex(wildcardPattern)
    let patternCount = 0

    for (const entry of treeEntries) {
      // entry.path is the parent dir of SKILL.md (e.g. 'plugins/deploy/skills/deploy')
      // Append /SKILL.md to test against the regex (which expects the full path)
      if (regex.test(`${entry.path}/SKILL.md`)) {
        if (!seen.has(entry.path)) {
          seen.add(entry.path)
          resolved.push({ path: entry.path, blobSha: entry.blobSha })
          patternCount++
        }
      }
    }

    wildcardExpansionCount += patternCount
    console.log(
      `[Trees] ${owner}/${repo}: glob '${wildcardPattern}' matched ${patternCount} skill path(s)`
    )
  }

  return {
    resolved,
    plainPaths,
    fetchFailed,
    wildcardExpansionCount,
    treesApiCallCount,
    truncatedResponseCount,
  }
}

/**
 * SMI-4861 Wave 1: Opportunistic Trees fetch for plain-path repos to populate
 * a `(skillPath → blobSha)` map. Gated by the caller via
 * `SKILLSMITH_TREE_HASH_PLAIN_PATH=true`. Costs +1 Trees API call per cold
 * plain-path repo; saves 1 raw.* fetch per cached skill on warm-cache runs.
 *
 * Default disabled (caller checks env var) — this is the staged-rollout
 * flag from plan §1.1. Returns an empty map (and `treesApiCallCount: 0`) when
 * the fetch fails so callers fall back to behavior-unchanged plain-path scan.
 */
export async function fetchPlainPathTreeMap(
  owner: string,
  repo: string,
  treeRef: string,
  telemetry: RateLimitTelemetry
): Promise<{ blobShas: Map<string, string>; treesApiCallCount: number; fetchFailed: boolean }> {
  const { entries, errors, truncated } = await fetchSkillPathsFromTree(
    owner,
    repo,
    treeRef,
    telemetry
  )
  const blobShas = new Map<string, string>()
  if (errors.length > 0 && entries.length === 0) {
    return { blobShas, treesApiCallCount: 1, fetchFailed: true }
  }
  for (const entry of entries) {
    blobShas.set(entry.path, entry.blobSha)
  }
  return { blobShas, treesApiCallCount: 1, fetchFailed: truncated }
}
