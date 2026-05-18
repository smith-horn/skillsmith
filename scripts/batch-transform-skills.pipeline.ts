/**
 * Database access, GitHub content fetching, and per-skill transformation
 * for the Batch Skill Transformation CLI.
 *
 * Extracted from batch-transform-skills.ts (SMI-4935) to keep each module
 * under the 500-line limit. See batch-transform-skills.ts for the entrypoint.
 */

import { createHash } from 'crypto'
import { type SupabaseClient } from '@supabase/supabase-js'
import {
  type TransformationService,
  type TransformationResult,
  parseRepoUrl,
} from '@skillsmith/core'
import { type GitHubRateLimiter } from './lib/migration-utils'
import type {
  AuditLogEntry,
  CliOptions,
  EnvConfig,
  SkillFilters,
  SkillRecord,
} from './batch-transform-skills.types'
import { loadBatchTransformCheckpoint } from './batch-transform-skills.checkpoint'

/**
 * Write an entry to the audit_logs table (SMI-2200). Best-effort: a failed
 * audit write is logged but never aborts the run.
 */
export async function writeAuditLog(supabase: SupabaseClient, entry: AuditLogEntry): Promise<void> {
  try {
    await supabase.from('audit_logs').insert({
      event_type: entry.event_type,
      result: entry.result,
      metadata: entry.metadata,
    })
  } catch (error) {
    console.warn(`Failed to write audit log: ${error instanceof Error ? error.message : 'Unknown'}`)
  }
}

/**
 * Fetch SKILL.md content from a GitHub repository
 * SMI-2172: Updated to use parseRepoUrl from @skillsmith/core to correctly
 * handle /tree/branch/path URLs from high-trust monorepo skills
 * SMI-2203: Uses GitHubRateLimiter for dynamic rate limiting
 */
async function fetchSkillContent(
  repoUrl: string,
  rateLimiter: GitHubRateLimiter,
  githubToken?: string,
  verbose?: boolean
): Promise<{ content: string | null; error?: string }> {
  try {
    // SMI-2172: Use parseRepoUrl to correctly handle /tree/ URLs
    const parsed = parseRepoUrl(repoUrl)
    const { owner, repo, branch, path: skillPath } = parsed

    // Clean repo name (remove .git suffix if present)
    const cleanRepo = repo.replace(/\.git$/, '')

    // Construct path prefix for subdirectory skills
    const pathPrefix = skillPath ? `${skillPath}/` : ''

    // Log detected subdirectory for debugging
    if (verbose && skillPath) {
      console.log(`    Detected subdirectory skill: ${skillPath}`)
      console.log(`    Will fetch: ${owner}/${cleanRepo}/${branch}/${pathPrefix}SKILL.md`)
    }

    // Fetch SKILL.md from detected branch (fallback to main, then master)
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3.raw',
      'User-Agent': 'Skillsmith-Batch-Transform/1.0',
    }

    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken}`
    }

    // Try detected branch first, then main, then master
    const branchesToTry = [branch]
    if (branch !== 'main') branchesToTry.push('main')
    if (branch !== 'master') branchesToTry.push('master')

    for (const tryBranch of branchesToTry) {
      const url = `https://raw.githubusercontent.com/${owner}/${cleanRepo}/${tryBranch}/${pathPrefix}SKILL.md`

      // SMI-2203: Use rate limiter
      const response = await rateLimiter.withRateLimit(async () => {
        return fetch(url, { headers })
      })

      if (response.ok) {
        const content = await response.text()
        if (content && content.trim().length > 0) {
          return { content }
        }
      }
    }

    // SMI-2175: Distinct error message including path
    const pathDesc = skillPath || 'repo root'
    return { content: null, error: `SKILL.md not found at ${pathDesc}` }
  } catch (error) {
    // SMI-2175: Distinct error for URL parsing failures
    if (error instanceof Error && error.message.includes('Invalid repository host')) {
      return { content: null, error: `Invalid URL format: ${repoUrl}` }
    }
    return {
      content: null,
      error: `Fetch failed: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * Fetch skills from Supabase with pagination and filters (SMI-2201)
 */
export async function* fetchSkillsBatch(
  supabase: SupabaseClient,
  batchSize: number,
  offset: number,
  limit: number,
  filters?: SkillFilters
): AsyncGenerator<SkillRecord[], void, unknown> {
  // Handle --only-missing: Get existing transformation skill IDs to exclude
  let existingTransformationIds: Set<string> | null = null
  if (filters?.onlyMissing) {
    const { data: existingData, error: existingError } = await supabase
      .from('skill_transformations')
      .select('skill_id')

    if (existingError) {
      throw new Error(`Failed to fetch existing transformations: ${existingError.message}`)
    }

    existingTransformationIds = new Set((existingData ?? []).map((r) => r.skill_id))
    console.log(`Found ${existingTransformationIds.size} existing transformations to exclude`)
  }

  // Handle --retry-failed and --retry-skipped (ID-based filters)
  if (filters?.retryFailed || filters?.retrySkipped) {
    const checkpoint = loadBatchTransformCheckpoint()
    const targetIds = filters.retryFailed
      ? (checkpoint?.failedSkillIds ?? [])
      : (checkpoint?.skippedSkillIds ?? [])

    if (targetIds.length === 0) {
      console.log(`No ${filters.retryFailed ? 'failed' : 'skipped'} skills found in checkpoint`)
      return
    }

    // Process in batches by ID
    for (let i = offset; i < Math.min(targetIds.length, offset + limit); i += batchSize) {
      const batchIds = targetIds.slice(i, Math.min(i + batchSize, offset + limit))
      const { data, error } = await supabase
        .from('skills')
        .select('id, name, description, author, repo_url, trust_tier')
        .in('id', batchIds)

      if (error) {
        throw new Error(`Supabase query failed: ${error.message}`)
      }

      if (data && data.length > 0) {
        yield data as SkillRecord[]
      }

      if (!data || data.length < batchIds.length) {
        break
      }
    }
    return
  }

  let currentOffset = offset
  let remaining = limit

  while (remaining > 0) {
    const fetchSize = Math.min(batchSize, remaining)

    // Build query with filters
    let query = supabase
      .from('skills')
      .select('id, name, description, author, repo_url, trust_tier')
      .not('repo_url', 'is', null)

    // Filter: --trust-tier
    if (filters?.trustTier) {
      query = query.eq('trust_tier', filters.trustTier)
    }

    // Filter: --since
    if (filters?.since) {
      query = query.gte('created_at', filters.since)
    }

    // Filter: --monorepo-skills (URLs containing /tree/)
    if (filters?.monorepoSkills) {
      query = query.like('repo_url', '%/tree/%')
    }

    // Apply pagination
    query = query.order('id').range(currentOffset, currentOffset + fetchSize - 1)

    const { data, error } = await query

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`)
    }

    if (!data || data.length === 0) {
      break
    }

    // Filter out skills with existing transformations (--only-missing)
    const filteredData = existingTransformationIds
      ? data.filter((skill) => !existingTransformationIds.has(skill.id))
      : data

    if (filteredData.length > 0) {
      yield filteredData as SkillRecord[]
    }

    currentOffset += data.length
    remaining -= data.length

    if (data.length < fetchSize) {
      break
    }
  }
}

/**
 * Compute SHA-256 hash of content for cache invalidation
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Recursively strip the NUL code point from every string in a value.
 *
 * PostgreSQL `jsonb` cannot represent the NUL code point: storing it (or
 * casting a jsonb string that contains it to `text`) fails with the error
 * `unsupported Unicode escape sequence`. NUL is the *only* code point that
 * triggers that specific error — PG accepts every other `\uXXXX` escape.
 * Skill content occasionally carries a stray NUL (SMI-4935 —
 * github/paracetamol951/caisse-enregistreuse-mcp-server), which aborted the
 * whole batch run on the `upsert_skill_transformation` RPC.
 *
 * Pure and exported for unit testing.
 */
export function stripNullChars<T>(value: T): T {
  if (typeof value === 'string') {
    return value.split(String.fromCharCode(0)).join('') as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripNullChars(item)) as T
  }
  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = stripNullChars(item)
    }
    return sanitized as T
  }
  return value
}

/**
 * Save transformation result to skill_transformations table
 */
async function saveTransformation(
  supabase: SupabaseClient,
  skillId: string,
  content: string,
  result: TransformationResult
): Promise<{ success: boolean; error?: string }> {
  try {
    const sourceHash = hashContent(content)

    // Convert subagent to JSONB format
    const subagentDefinition = result.subagent
      ? {
          name: result.subagent.name,
          description: result.subagent.description,
          triggerPhrases: result.subagent.triggerPhrases,
          tools: result.subagent.tools,
          model: result.subagent.model,
          content: result.subagent.content,
        }
      : null

    // Call the upsert RPC function. Strip NUL code points from every string in
    // the payload first — PostgreSQL `jsonb` rejects U+0000 and aborts the RPC
    // (SMI-4935). stripNullChars walks the whole arg object recursively.
    const { error } = await supabase.rpc(
      'upsert_skill_transformation',
      stripNullChars({
        p_skill_id: skillId,
        p_main_content: result.mainSkillContent,
        p_sub_skills: result.subSkills,
        p_subagent_definition: subagentDefinition,
        p_claude_md_snippet: result.claudeMdSnippet ?? null,
        p_stats: result.stats,
        p_source_hash: sourceHash,
      })
    )

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Fetch, transform, and (unless dry-run) save a single skill.
 */
export async function processSkill(
  skill: SkillRecord,
  service: TransformationService,
  supabase: SupabaseClient,
  rateLimiter: GitHubRateLimiter,
  options: CliOptions,
  config: EnvConfig
): Promise<{ status: 'transformed' | 'skipped' | 'failed'; error?: string }> {
  if (!skill.repo_url) {
    return { status: 'skipped', error: 'No repo URL' }
  }

  // Fetch SKILL.md content (pass verbose for subdirectory logging)
  const { content, error: fetchError } = await fetchSkillContent(
    skill.repo_url,
    rateLimiter,
    config.githubToken,
    options.verbose
  )

  if (!content) {
    return { status: 'skipped', error: fetchError ?? 'No content' }
  }

  // Transform the skill
  try {
    const result = service.transformWithoutCache(skill.name, skill.description ?? '', content)

    if (options.verbose) {
      console.log(`    Transformed: ${result.transformed}`)
      console.log(`    Token reduction: ${result.stats.tokenReductionPercent}%`)
      console.log(`    Sub-skills: ${result.stats.subSkillCount}`)
      console.log(`    Subagent: ${result.stats.subagentGenerated}`)
    }

    // Save to database (unless dry-run)
    if (!options.dryRun) {
      const saveResult = await saveTransformation(supabase, skill.id, content, result)
      if (!saveResult.success) {
        return { status: 'failed', error: `Save failed: ${saveResult.error}` }
      }
    }

    return { status: 'transformed' }
  } catch (error) {
    return {
      status: 'failed',
      error: `Transform failed: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}
