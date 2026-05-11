/**
 * High-trust author repository indexing (Node port)
 * @module scripts/indexer/high-trust-indexer
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/high-trust-indexer.ts`. Two mechanical changes
 * from the Deno parent:
 *   1. Imports switch from `../_shared/...` (Deno edge-function layout) to
 *      `./_shared/...` (Node indexer layout).
 *   2. Every `fetch('https://api.github.com/...')` is wrapped in
 *      `withRateLimitTracking(telemetry, url, init)` per the Hard Rule
 *      enforced by `scripts/indexer/_shared/rate-limit.ts:197`. Callers must
 *      thread the run-scoped `RateLimitTelemetry` instance through; the
 *      entrypoint (`run.ts`) creates it and flushes to `audit_logs.metadata`.
 *
 * Original docblock (preserved for context):
 *
 * Extracted from index.ts (Phase 0 refactor) to pass 500-line CI gate.
 * Scans verified publisher repositories (Anthropic, Microsoft, Google, etc.)
 * for SKILL.md files in subdirectories and root.
 *
 * SMI-2672: Adds wildcard skillsPaths support via the GitHub Trees API.
 * Plain skillsPaths entries (no '*') continue to use the existing Contents API
 * path unchanged. See trees-search.ts for the wildcard implementation.
 */

import { buildGitHubHeaders } from './_shared/github-auth.ts'
import {
  validateGitHubParams,
  validateGitHubPath,
  isValidGitHubIdentifier,
  isValidBranchName,
  sanitizeForLog,
} from './_shared/validation.ts'
import { withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'

import { type HighTrustAuthor, shouldExcludeSkill } from './high-trust-authors.ts'

import type { GitHubRepository } from './topic-search.ts'
import {
  type SkillMdValidation,
  checkSkillMdExists,
  getCachedValidation,
  sanitizeSkillName,
} from './skill-processor.ts'
import { delay } from './topic-search.ts'
import { expandGlobSkillsPaths, fetchPlainPathTreeMap } from './trees-search.ts'

/**
 * SMI-4861 Wave 1: tree-hash TTL cache shape. Maps `${repo_url}:${skill_path}`
 * to its prior `tree_hash` + `last_tree_hash_check`. When non-empty, callers
 * skip the raw.* SKILL.md fetch on matching blob SHA AND fresh check (<24h).
 */
export type TreeHashCacheEntry = { tree_hash: string; last_tree_hash_check: string | null }
export type TreeHashCache = Map<string, TreeHashCacheEntry>

/** SMI-4861 Wave 1: hit/miss counters threaded through Phase 1 callers. */
export interface TreeHashCacheCounters {
  hits: number
  misses: number
}

/** TTL for tree-hash cache (24h). Future TTL A/B test tracked in SMI-4872. */
export const TREE_HASH_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Cache key used by Phase 1 callers (mirrors skill-processor.ts:496 fallback). */
export function treeHashCacheKey(repoUrl: string, skillPath: string | undefined): string {
  return `${repoUrl}:${skillPath ?? ''}`
}

/**
 * SMI-4861 Wave 1: cache check helper. Returns true when the cache holds
 * a non-stale entry whose blob SHA matches `currentBlobSha`. Callers
 * increment `counters` accordingly (hits on match, misses on fall-through).
 */
export function treeHashCacheHit(
  cache: TreeHashCache | undefined,
  cacheKey: string,
  currentBlobSha: string | undefined,
  now: number = Date.now()
): boolean {
  if (!cache || !currentBlobSha) return false
  const entry = cache.get(cacheKey)
  if (!entry || entry.tree_hash !== currentBlobSha || !entry.last_tree_hash_check) return false
  const lastMs = Date.parse(entry.last_tree_hash_check)
  if (!Number.isFinite(lastMs)) return false
  return now - lastMs < TREE_HASH_CACHE_TTL_MS
}

/**
 * Shared repo metadata shape fetched from GitHub API
 */
interface RepoData {
  default_branch: string
  stargazers_count: number
  forks_count: number
  description: string | null
  topics: string[]
}

/**
 * Index skills from a base directory using the GitHub Contents API.
 * Handles one level of subdirectory scanning below basePath.
 *
 * Used for plain skillsPaths entries (no wildcard). Extracted as a named helper
 * so both the plain-path branch and the wildcard branch in indexHighTrustRepository()
 * are structurally symmetric and independently testable.
 *
 * SMI-2672: Extracted from indexHighTrustRepository() to enable symmetrical
 * wildcard branch in the same function.
 *
 * @param author - High-trust author config
 * @param basePath - Base directory path to scan (e.g. '', 'skills', '.github/skills')
 * @param repoData - Pre-fetched repository metadata
 * @param validationCache - Request-scoped SKILL.md validation cache
 * @param validationOptions - Strict validation and minimum content length options
 * @param telemetry - SMI-4852: Run-scoped rate-limit telemetry for the GitHub fetch wrapper.
 */
async function indexSkillsFromContents(
  author: HighTrustAuthor,
  basePath: string,
  repoData: RepoData,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number },
  telemetry: RateLimitTelemetry,
  // SMI-4861 Wave 1: optional tree-hash cache plumbing. When the caller passes
  // a populated `plainPathBlobShas` map (via SKILLSMITH_TREE_HASH_PLAIN_PATH
  // opt-in or the Trees API fallback inside indexHighTrustRepository), each
  // subdirectory's blob SHA is checked against the cache; matches skip the
  // raw.* fetch entirely. Default `undefined` = no-op (behavior unchanged).
  treeHashCache?: TreeHashCache,
  cacheCounters?: TreeHashCacheCounters,
  plainPathBlobShas?: Map<string, string>
): Promise<{ skills: GitHubRepository[]; errors: string[] }> {
  const skills: GitHubRepository[] = []
  const errors: string[] = []

  const contentsUrl = basePath
    ? `https://api.github.com/repos/${author.owner}/${author.repo}/contents/${basePath}`
    : `https://api.github.com/repos/${author.owner}/${author.repo}/contents`

  // SMI-4852 Hard Rule 1: wrap GitHub fetch in withRateLimitTracking. Pass
  // `_throwOnRateLimit: false` to preserve the Deno parent's behavior of
  // letting 403/429 fall through to the `!ok` branch below (so the original
  // 404 / 403 error handling reads identically). Telemetry side-effect still
  // records header counts + 403/429 incidents.
  const contentsResponse = await withRateLimitTracking(telemetry, contentsUrl, {
    headers: await buildGitHubHeaders(),
    _throwOnRateLimit: false,
  })

  if (!contentsResponse.ok) {
    // skills/ subdirectory might not exist, that's OK
    if (basePath && contentsResponse.status === 404) {
      return { skills, errors }
    }
    errors.push(
      `Failed to fetch contents for ${author.owner}/${author.repo}/${basePath}: ${contentsResponse.status}`
    )
    return { skills, errors }
  }

  const contents = (await contentsResponse.json()) as Array<{
    name: string
    type: string
    path: string
  }>

  // SMI-2415: Defensive check — Contents API should return an array
  if (!Array.isArray(contents)) {
    errors.push(
      `Unexpected response format for ${author.owner}/${author.repo}/${basePath || '(root)'}: expected array`
    )
    return { skills, errors }
  }

  // SMI-2415: Warn if directory listing may be truncated
  if (contents.length >= 1000) {
    console.warn(
      `[HighTrust] WARNING: ${author.owner}/${author.repo}/${basePath || '(root)'} returned ${contents.length} items — response may be truncated. Some skills may be missed.`
    )
    errors.push(
      `Directory listing may be truncated for ${author.owner}/${author.repo}/${basePath || '(root)'} (${contents.length} items)`
    )
  }

  // Check each directory for SKILL.md
  for (const item of contents) {
    if (item.type !== 'dir') continue

    // SMI-2282: Validate item.name from GitHub contents API
    if (!isValidGitHubIdentifier(item.name)) {
      console.warn(`Skipping directory with invalid name: ${sanitizeForLog(item.name)}`)
      continue
    }
    // Skip common non-skill directories
    if (
      [
        '.github',
        '.claude-plugin',
        'scripts',
        'assets',
        'agents',
        'apps',
        'packages',
        'spec',
        'template',
      ].includes(item.name)
    ) {
      continue
    }

    // Check if this skill should be excluded
    if (shouldExcludeSkill(author, item.name)) {
      console.log(`Skipping excluded skill: ${author.owner}/${author.repo}/${item.name}`)
      continue
    }

    // Build the path to check for SKILL.md
    const skillPath = basePath ? `${basePath}/${item.name}` : item.name

    // SMI-4861 Wave 1: tree-hash TTL cache gate. When the caller threaded a
    // plain-path blob-SHA map (opt-in via SKILLSMITH_TREE_HASH_PLAIN_PATH) and
    // the cache holds a fresh matching tree_hash, skip the raw.* fetch. The
    // existing DB row is left untouched; counters surface in audit meta.
    const repoUrl = `https://github.com/${author.owner}/${author.repo}`
    const blobSha = plainPathBlobShas?.get(skillPath)
    if (treeHashCacheHit(treeHashCache, treeHashCacheKey(repoUrl, skillPath), blobSha)) {
      if (cacheCounters) cacheCounters.hits++
      continue
    }
    if (treeHashCache && blobSha) {
      // We have a blob SHA but no cache hit — record the miss for telemetry.
      if (cacheCounters) cacheCounters.misses++
    }

    // Check if SKILL.md exists and is valid in this directory
    const hasSkill = await checkSkillMdExists(
      author.owner,
      author.repo,
      repoData.default_branch,
      validationCache,
      telemetry,
      skillPath,
      validationOptions
    )

    if (hasSkill) {
      const validation = getCachedValidation(
        author.owner,
        author.repo,
        repoData.default_branch,
        validationCache,
        skillPath
      )
      const metadata = validation?.metadata
      const skillName = sanitizeSkillName(metadata?.name || item.name)

      skills.push({
        owner: author.owner,
        name: skillName,
        fullName: `${author.owner}/${skillName}`,
        description:
          metadata?.description ||
          `${item.name} — a Claude Code skill by ${author.owner}/${author.repo}`,
        url: `https://github.com/${author.owner}/${author.repo}/tree/${repoData.default_branch}/${skillPath}`,
        stars: repoData.stargazers_count,
        forks: repoData.forks_count,
        topics: repoData.topics || [],
        updatedAt: new Date().toISOString(),
        defaultBranch: repoData.default_branch,
        installable: author.installable ?? true,
        repoName: author.repo,
        skillPath,
        // SMI-4387: plain Contents API path — not wildcard
        discoveryPath: `high_trust:${author.owner}`,
        // SMI-4861 Wave 1: persist blob SHA so the next cron can cache-hit.
        treeHash: blobSha,
      })
    }

    await delay(50) // Rate limiting
  }

  return { skills, errors }
}

/**
 * Fetch skills from a high-trust author's repository
 * Scans subdirectories for SKILL.md files
 * SMI-2404: Accepts request-scoped validationCache to avoid shared state across concurrent requests
 * SMI-2672: Adds wildcard skillsPaths support via the GitHub Trees API
 * SMI-4852: Accepts run-scoped `telemetry` for GitHub fetch rate-limit accounting.
 */
export async function indexHighTrustRepository(
  author: HighTrustAuthor,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number } = {},
  telemetry: RateLimitTelemetry,
  // SMI-4861 Wave 1: optional cross-run tree-hash cache + counters. When
  // omitted, all callers behave as today (no cache check, no opportunistic
  // Trees fetch on plain-path repos).
  treeHashCache?: TreeHashCache,
  cacheCounters?: TreeHashCacheCounters
): Promise<{
  skills: GitHubRepository[]
  errors: string[]
  wildcardExpansionCount: number
  treesApiCallCount: number
  truncatedResponseCount: number
}> {
  const skills: GitHubRepository[] = []
  const errors: string[] = []
  let wildcardExpansionCount = 0
  let treesApiCallCount = 0
  let truncatedResponseCount = 0

  try {
    // SMI-2271: Validate high-trust author parameters before URL construction
    try {
      validateGitHubParams(author.owner, author.repo)
    } catch (e) {
      errors.push(`Invalid high-trust author config: ${e instanceof Error ? e.message : 'Unknown'}`)
      return { skills, errors, wildcardExpansionCount, treesApiCallCount, truncatedResponseCount }
    }

    // Get repository info
    const repoApiUrl = `https://api.github.com/repos/${author.owner}/${author.repo}`
    // SMI-4852 Hard Rule 1: wrap GitHub fetch.
    const repoResponse = await withRateLimitTracking(telemetry, repoApiUrl, {
      headers: await buildGitHubHeaders(),
      _throwOnRateLimit: false,
    })

    if (!repoResponse.ok) {
      errors.push(`Failed to fetch ${author.owner}/${author.repo}: ${repoResponse.status}`)
      return { skills, errors, wildcardExpansionCount, treesApiCallCount, truncatedResponseCount }
    }

    const repoData = (await repoResponse.json()) as RepoData

    // SMI-2280: Validate branch name before URL interpolation
    if (!isValidBranchName(repoData.default_branch)) {
      errors.push(
        `Invalid branch name for ${author.owner}/${author.repo}: ${sanitizeForLog(repoData.default_branch)}`
      )
      return { skills, errors, wildcardExpansionCount, treesApiCallCount, truncatedResponseCount }
    }

    const allSkillsPaths = author.skillsPaths ?? ['', 'skills']
    const hasWildcard = allSkillsPaths.some((p) => p.includes('*'))
    // SMI-4861 Wave 1: opt-in opportunistic Trees fetch for plain-path repos.
    // Default false — staged rollout. When true and the repo has no wildcards,
    // we still fetch the Trees API once to map parent dir → blob SHA so plain
    // Contents API scans can cache-hit. Adds +1 Trees call per cold repo;
    // breaks even after first warm cron.
    const plainPathTreeHashEnabled =
      process.env.SKILLSMITH_TREE_HASH_PLAIN_PATH === 'true' && !!treeHashCache
    const repoUrlForCache = `https://github.com/${author.owner}/${author.repo}`

    // ── Wildcard branch: GitHub Trees API ────────────────────────────────
    // SMI-2672: If any skillsPath contains '*', use the Trees API to resolve
    // all matching skill directories in a single recursive API call.
    if (hasWildcard) {
      const expanded = await expandGlobSkillsPaths(
        author.owner,
        author.repo,
        allSkillsPaths,
        repoData.default_branch,
        telemetry
      )

      if (expanded.fetchFailed) {
        errors.push(`Trees API fetch failed for ${author.owner}/${author.repo}`)
      }

      wildcardExpansionCount = expanded.wildcardExpansionCount
      treesApiCallCount = expanded.treesApiCallCount
      truncatedResponseCount = expanded.truncatedResponseCount

      console.log(
        `[HighTrust/Trees] ${author.owner}/${author.repo}: ${expanded.wildcardExpansionCount} path(s) expanded via wildcard, fetchFailed=${expanded.fetchFailed}`
      )

      // SMI-4861 Wave 1: the wildcard Trees fetch above already carries blob
      // SHAs for every SKILL.md in the repo. Build a path → blobSha map from
      // those entries to seed the plain-path branch below as well, so mixed
      // wildcard+plain skillsPaths arrays (e.g. Salesforce) get the same
      // cache treatment without an extra API call.
      const blobShaMap = new Map<string, string>()
      for (const entry of expanded.resolved) blobShaMap.set(entry.path, entry.blobSha)

      // Handle plain paths via Contents API directory scan (same as non-wildcard branch).
      // This supports mixed wildcard+plain skillsPaths arrays (e.g. Salesforce:
      // ['.claude/skills', 'skills/*/skills']). Plain paths are parent directories
      // that need one-level subdirectory scanning, not concrete skill directories.
      for (const basePath of expanded.plainPaths) {
        const { skills: pathSkills, errors: pathErrors } = await indexSkillsFromContents(
          author,
          basePath,
          repoData,
          validationCache,
          validationOptions,
          telemetry,
          treeHashCache,
          cacheCounters,
          blobShaMap
        )
        skills.push(...pathSkills)
        errors.push(...pathErrors)
      }

      // Index each wildcard-resolved skill path using Contents API validation
      for (const entry of expanded.resolved) {
        const resolvedPath = entry.path
        // Validate paths from external GitHub API before URL construction (Path Column DB Standards)
        if (!validateGitHubPath(resolvedPath)) {
          console.warn(
            `[HighTrust/Trees] Skipping invalid path from Trees API: ${sanitizeForLog(resolvedPath)}`
          )
          continue
        }

        // Apply same security and exclusion checks as plain-path branch
        const skillDirName = resolvedPath.split('/').pop() ?? ''
        if (!isValidGitHubIdentifier(skillDirName)) {
          console.warn(
            `[HighTrust/Trees] Skipping path with invalid dir name: ${sanitizeForLog(resolvedPath)}`
          )
          continue
        }
        if (shouldExcludeSkill(author, skillDirName)) {
          console.log(
            `[HighTrust/Trees] Skipping excluded skill: ${author.owner}/${author.repo}/${skillDirName}`
          )
          continue
        }

        // SMI-4861 Wave 1: tree-hash cache gate. Wildcard branch always has
        // blob SHA from the Trees response.
        if (
          treeHashCacheHit(
            treeHashCache,
            treeHashCacheKey(repoUrlForCache, resolvedPath),
            entry.blobSha
          )
        ) {
          if (cacheCounters) cacheCounters.hits++
          await delay(50)
          continue
        }
        if (treeHashCache) {
          if (cacheCounters) cacheCounters.misses++
        }

        const hasSkill = await checkSkillMdExists(
          author.owner,
          author.repo,
          repoData.default_branch,
          validationCache,
          telemetry,
          resolvedPath,
          validationOptions
        )

        if (hasSkill) {
          const validation = getCachedValidation(
            author.owner,
            author.repo,
            repoData.default_branch,
            validationCache,
            resolvedPath
          )
          const metadata = validation?.metadata
          // Skill name: last path segment of resolvedPath (e.g. 'deploy' from 'plugins/deploy-on-aws/skills/deploy')
          const lastSegment = resolvedPath.split('/').pop() ?? resolvedPath
          const skillName = sanitizeSkillName(metadata?.name || lastSegment)

          skills.push({
            owner: author.owner,
            name: skillName,
            fullName: `${author.owner}/${skillName}`,
            description:
              metadata?.description ||
              `${lastSegment} — a Claude Code skill by ${author.owner}/${author.repo}`,
            url: `https://github.com/${author.owner}/${author.repo}/tree/${repoData.default_branch}/${resolvedPath}`,
            stars: repoData.stargazers_count,
            forks: repoData.forks_count,
            topics: repoData.topics || [],
            updatedAt: new Date().toISOString(),
            defaultBranch: repoData.default_branch,
            installable: author.installable ?? true,
            repoName: author.repo,
            skillPath: resolvedPath,
            // SMI-4387: Trees API wildcard-expansion path
            discoveryPath: `wildcard:${author.owner}`,
            // SMI-4861 Wave 1: blob SHA from Trees response; persisted into
            // skills.tree_hash on UPSERT so future crons can cache-hit.
            treeHash: entry.blobSha,
          })
        }

        await delay(50) // Rate limiting
      }
    } else {
      // ── Plain branch: Contents API (existing logic) ───────────────────────
      // No wildcards — use the existing one-level directory scan per basePath.
      // SMI-4861 Wave 1: if SKILLSMITH_TREE_HASH_PLAIN_PATH=true and cache
      // present, fetch the Trees API once to seed a path→blobSha map.
      let blobShaMap: Map<string, string> | undefined
      if (plainPathTreeHashEnabled) {
        const treeMap = await fetchPlainPathTreeMap(
          author.owner,
          author.repo,
          repoData.default_branch,
          telemetry
        )
        treesApiCallCount += treeMap.treesApiCallCount
        if (!treeMap.fetchFailed) blobShaMap = treeMap.blobShas
      }
      for (const basePath of allSkillsPaths) {
        const { skills: pathSkills, errors: pathErrors } = await indexSkillsFromContents(
          author,
          basePath,
          repoData,
          validationCache,
          validationOptions,
          telemetry,
          treeHashCache,
          cacheCounters,
          blobShaMap
        )
        skills.push(...pathSkills)
        errors.push(...pathErrors)
      }
    }

    // Also check for root-level SKILL.md (single-skill repos)
    const hasRootSkill = await checkSkillMdExists(
      author.owner,
      author.repo,
      repoData.default_branch,
      validationCache,
      telemetry,
      undefined,
      validationOptions
    )

    if (hasRootSkill && !shouldExcludeSkill(author, author.repo)) {
      const rootValidation = getCachedValidation(
        author.owner,
        author.repo,
        repoData.default_branch,
        validationCache
      )
      const rootMetadata = rootValidation?.metadata
      const rootSkillName = sanitizeSkillName(rootMetadata?.name || author.repo)

      skills.push({
        owner: author.owner,
        name: rootSkillName,
        fullName: `${author.owner}/${rootSkillName}`,
        description:
          rootMetadata?.description ||
          repoData.description ||
          `${author.repo} — a Claude Code skill by ${author.owner}`,
        url: `https://github.com/${author.owner}/${author.repo}`,
        stars: repoData.stargazers_count,
        forks: repoData.forks_count,
        topics: repoData.topics || [],
        updatedAt: new Date().toISOString(),
        defaultBranch: repoData.default_branch,
        installable: author.installable ?? true,
        repoName: author.repo,
        // SMI-4387: root-level single-skill high-trust repo; skillPath: '' marks root
        skillPath: '',
        discoveryPath: `high_trust:${author.owner}`,
      })
    }
  } catch (error) {
    errors.push(
      `Error indexing ${author.owner}/${author.repo}: ${error instanceof Error ? error.message : 'Unknown'}`
    )
  }

  return { skills, errors, wildcardExpansionCount, treesApiCallCount, truncatedResponseCount }
}
