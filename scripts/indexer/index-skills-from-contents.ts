/**
 * Plain-path Contents API scan helper (extracted from high-trust-indexer)
 * @module scripts/indexer/index-skills-from-contents
 *
 * Used for plain skillsPaths entries (no wildcard). Both the plain-path branch
 * and the wildcard branch in indexHighTrustRepository() call into this for
 * structural symmetry and independent testability.
 *
 * SMI-2672: Extracted from indexHighTrustRepository() to enable the symmetrical
 * wildcard branch. SMI-4861 Wave 1: optional tree-hash cache plumbing skips
 * the raw.* SKILL.md fetch when a blob SHA matches a fresh cache entry.
 */

import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { isValidGitHubIdentifier, sanitizeForLog } from './_shared/validation.ts'
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
import {
  treeHashCacheHit,
  treeHashCacheKey,
  type TreeHashCache,
  type TreeHashCacheCounters,
} from './tree-hash-cache.ts'

/** Shared repo metadata shape fetched from GitHub API. */
export interface RepoData {
  default_branch: string
  stargazers_count: number
  forks_count: number
  description: string | null
  topics: string[]
}

/**
 * Index skills from a base directory using the GitHub Contents API.
 * Handles one level of subdirectory scanning below basePath.
 */
export async function indexSkillsFromContents(
  author: HighTrustAuthor,
  basePath: string,
  repoData: RepoData,
  validationCache: Map<string, SkillMdValidation>,
  validationOptions: { strictValidation?: boolean; minContentLength?: number },
  telemetry: RateLimitTelemetry,
  // SMI-4861 Wave 1: tree-hash cache plumbing. Defaults `undefined` = no-op.
  treeHashCache?: TreeHashCache,
  cacheCounters?: TreeHashCacheCounters,
  plainPathBlobShas?: Map<string, string>
): Promise<{ skills: GitHubRepository[]; errors: string[] }> {
  const skills: GitHubRepository[] = []
  const errors: string[] = []

  const contentsUrl = basePath
    ? `https://api.github.com/repos/${author.owner}/${author.repo}/contents/${basePath}`
    : `https://api.github.com/repos/${author.owner}/${author.repo}/contents`

  // SMI-4852 Hard Rule 1: wrap GitHub fetch. `_throwOnRateLimit: false` lets
  // 403/429 fall through to the `!ok` branch so error handling reads identical
  // to the Deno parent; telemetry side-effect still records header counts.
  const contentsResponse = await withRateLimitTracking(telemetry, contentsUrl, {
    headers: await buildGitHubHeaders(),
    _throwOnRateLimit: false,
  })

  if (!contentsResponse.ok) {
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

    if (shouldExcludeSkill(author, item.name)) {
      console.log(`Skipping excluded skill: ${author.owner}/${author.repo}/${item.name}`)
      continue
    }

    const skillPath = basePath ? `${basePath}/${item.name}` : item.name

    // SMI-4861 Wave 1: plain-path cache gate (opt-in via SKILLSMITH_TREE_HASH_PLAIN_PATH).
    const repoUrl = `https://github.com/${author.owner}/${author.repo}`
    const blobSha = plainPathBlobShas?.get(skillPath)
    if (treeHashCacheHit(treeHashCache, treeHashCacheKey(repoUrl, skillPath), blobSha)) {
      if (cacheCounters) cacheCounters.hits++
      continue
    }
    if (treeHashCache && blobSha && cacheCounters) cacheCounters.misses++

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

    await delay(50)
  }

  return { skills, errors }
}
