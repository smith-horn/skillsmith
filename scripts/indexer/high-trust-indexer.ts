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

import {
  validateGitHubParams,
  validateGitHubPath,
  isValidGitHubIdentifier,
  isValidBranchName,
  sanitizeForLog,
} from './_shared/validation.ts'
import { withRateLimitTracking, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { buildGitHubHeaders } from './_shared/github-auth.ts'

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
import {
  treeHashCacheHit,
  treeHashCacheKey,
  type TreeHashCache,
  type TreeHashCacheCounters,
} from './tree-hash-cache.ts'
import { indexSkillsFromContents, type RepoData } from './index-skills-from-contents.ts'
import type { TreeHashTouchEntry } from './tree-hash-touch.ts'

// Re-export for callers still importing from this module (run.ts, phases/high-trust.ts).
export { treeHashCacheHit, treeHashCacheKey, TREE_HASH_CACHE_TTL_MS } from './tree-hash-cache.ts'
export type { TreeHashCache, TreeHashCacheCounters, TreeHashCacheEntry } from './tree-hash-cache.ts'

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
  // SMI-4861 Wave 1: cross-run tree-hash cache. Omitted = behavior unchanged.
  treeHashCache?: TreeHashCache,
  cacheCounters?: TreeHashCacheCounters,
  // SMI-4861 cache-refresh-on-hit: list to collect rows whose cache hit should
  // bump last_tree_hash_check post-Phase-1.
  treeHashTouches?: TreeHashTouchEntry[]
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
    // SMI-4861 Wave 1: opt-in plain-path Trees prefetch. Adds +1 Trees call
    // per cold repo; breaks even after first warm cron. Default false.
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

      // SMI-4861 Wave 1: seed plain-path branch from the wildcard Trees fetch
      // for mixed skillsPaths arrays (e.g. Salesforce) — no extra API call.
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
          blobShaMap,
          treeHashTouches
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

        // SMI-4861 Wave 1: wildcard branch always has blob SHA from Trees.
        if (
          treeHashCacheHit(
            treeHashCache,
            treeHashCacheKey(repoUrlForCache, resolvedPath),
            entry.blobSha
          )
        ) {
          if (cacheCounters) cacheCounters.hits++
          // SMI-4861 cache-refresh-on-hit: record touch so post-Phase-1 batch
          // refreshes last_tree_hash_check. Without this, hits don't refresh
          // and rows age past TTL, capping steady-state hit ratio at ~50%.
          if (treeHashTouches) {
            treeHashTouches.push({
              repo_url: `https://github.com/${author.owner}/${author.repo}/tree/${repoData.default_branch}/${resolvedPath}`,
              skill_path: resolvedPath,
            })
          }
          await delay(50)
          continue
        }
        if (treeHashCache && cacheCounters) cacheCounters.misses++

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
            // SMI-4861 Wave 1: persisted to skills.tree_hash for future crons.
            treeHash: entry.blobSha,
          })
        }

        await delay(50) // Rate limiting
      }
    } else {
      // ── Plain branch: Contents API (existing logic) ───────────────────────
      // SMI-4861 Wave 1: opt-in Trees prefetch seeds path→blobSha for caching.
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
          blobShaMap,
          treeHashTouches
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
        // SMI-4861 Wave 2 scope: root-skill blob-SHA lookup will populate
        // tree_hash here (deferred — requires a separate Contents API call).
      })
    }
  } catch (error) {
    errors.push(
      `Error indexing ${author.owner}/${author.repo}: ${error instanceof Error ? error.message : 'Unknown'}`
    )
  }

  return { skills, errors, wildcardExpansionCount, treesApiCallCount, truncatedResponseCount }
}
