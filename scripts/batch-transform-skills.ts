#!/usr/bin/env npx tsx
/**
 * Batch Skill Transformation CLI
 * SMI-1840: Pre-transform skills using TransformationService
 *
 * Processes skills through the transformation pipeline:
 * 1. Fetches skills from Supabase in batches
 * 2. Fetches SKILL.md content from GitHub
 * 3. Runs TransformationService on each skill
 * 4. Saves results to skill_transformations table
 *
 * Usage:
 *   varlock run -- npx tsx scripts/batch-transform-skills.ts --dry-run --limit 10
 *   varlock run -- npx tsx scripts/batch-transform-skills.ts --verbose
 *   docker exec skillsmith-dev-1 varlock run -- npx tsx scripts/batch-transform-skills.ts
 *
 * Options:
 *   --limit <n>    Maximum skills to process (default: all)
 *   --offset <n>   Skip first n skills (default: 0)
 *   --dry-run      Preview transformations without saving
 *   --verbose      Show detailed output
 *   --help         Show this help message
 *
 * Environment Variables:
 *   SUPABASE_URL                 Supabase project URL (required)
 *   SUPABASE_SERVICE_ROLE_KEY    Supabase service role key (required)
 *   GITHUB_TOKEN                 GitHub token for fetching SKILL.md (optional, higher rate limits)
 */

import { parseArgs } from 'node:util'
import { createHash } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { TransformationService, type TransformationResult, parseRepoUrl } from '@skillsmith/core'

// =============================================================================
// Types
// =============================================================================

interface CliOptions {
  limit: number
  offset: number
  dryRun: boolean
  verbose: boolean
  help: boolean
}

interface SkillRecord {
  id: string
  name: string
  description: string | null
  author: string | null
  repo_url: string | null
  trust_tier: string
}

interface TransformStats {
  processed: number
  transformed: number
  skipped: number
  failed: number
  errors: string[]
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string', short: 'l' },
      offset: { type: 'string', short: 'o' },
      'dry-run': { type: 'boolean', short: 'd' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })

  return {
    limit: values.limit ? parseInt(values.limit, 10) : Infinity,
    offset: values.offset ? parseInt(values.offset, 10) : 0,
    dryRun: values['dry-run'] ?? false,
    verbose: values.verbose ?? false,
    help: values.help ?? false,
  }
}

function printHelp(): void {
  console.log(`
Batch Skill Transformation CLI
SMI-1840: Pre-transform skills using TransformationService

Usage:
  varlock run -- npx tsx scripts/batch-transform-skills.ts [options]

Options:
  --limit, -l <n>    Maximum skills to process (default: all)
  --offset, -o <n>   Skip first n skills (default: 0)
  --dry-run, -d      Preview transformations without saving
  --verbose, -v      Show detailed output
  --help, -h         Show this help message

Environment Variables:
  SUPABASE_URL                 Supabase project URL (required)
  SUPABASE_SERVICE_ROLE_KEY    Supabase service role key (required)
  GITHUB_TOKEN                 GitHub token for higher rate limits (optional)

Examples:
  # Dry-run first 10 skills
  varlock run -- npx tsx scripts/batch-transform-skills.ts --dry-run --limit 10

  # Transform all skills with verbose output
  varlock run -- npx tsx scripts/batch-transform-skills.ts --verbose

  # Resume from offset 500
  varlock run -- npx tsx scripts/batch-transform-skills.ts --offset 500 --limit 100
`)
}

// =============================================================================
// Environment Validation
// =============================================================================

interface EnvConfig {
  supabaseUrl: string
  supabaseServiceKey: string
  githubToken?: string
}

function validateEnv(): EnvConfig {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const githubToken = process.env.GITHUB_TOKEN

  const missing: string[] = []
  if (!supabaseUrl) missing.push('SUPABASE_URL')
  if (!supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY')

  if (missing.length > 0) {
    console.error('\nError: Missing required environment variables:')
    missing.forEach((v) => console.error(`  - ${v}`))
    console.error('\nMake sure to run with Varlock:')
    console.error('  varlock run -- npx tsx scripts/batch-transform-skills.ts')
    process.exit(2)
  }

  return {
    supabaseUrl: supabaseUrl!,
    supabaseServiceKey: supabaseServiceKey!,
    githubToken,
  }
}

// =============================================================================
// GitHub Content Fetching
// =============================================================================

const GITHUB_API_DELAY = 150 // ms between requests

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch SKILL.md content from a GitHub repository
 * SMI-2172: Updated to use parseRepoUrl from @skillsmith/core to correctly
 * handle /tree/branch/path URLs from high-trust monorepo skills
 */
async function fetchSkillContent(
  repoUrl: string,
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

      await delay(GITHUB_API_DELAY)
      const response = await fetch(url, { headers })

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

// =============================================================================
// Database Operations
// =============================================================================

/**
 * Fetch skills from Supabase with pagination
 */
async function* fetchSkillsBatch(
  supabase: SupabaseClient,
  batchSize: number,
  offset: number,
  limit: number
): AsyncGenerator<SkillRecord[], void, unknown> {
  let currentOffset = offset
  let remaining = limit

  while (remaining > 0) {
    const fetchSize = Math.min(batchSize, remaining)

    const { data, error } = await supabase
      .from('skills')
      .select('id, name, description, author, repo_url, trust_tier')
      .not('repo_url', 'is', null)
      .order('id')
      .range(currentOffset, currentOffset + fetchSize - 1)

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`)
    }

    if (!data || data.length === 0) {
      break
    }

    yield data as SkillRecord[]

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
          triggers: result.subagent.triggers,
          model: result.subagent.model,
          content: result.subagent.content,
        }
      : null

    // Call the upsert RPC function
    const { error } = await supabase.rpc('upsert_skill_transformation', {
      p_skill_id: skillId,
      p_main_content: result.mainSkillContent,
      p_sub_skills: result.subSkills,
      p_subagent_definition: subagentDefinition,
      p_claude_md_snippet: result.claudeMdSnippet ?? null,
      p_stats: result.stats,
      p_source_hash: sourceHash,
    })

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

// =============================================================================
// Main Processing
// =============================================================================

async function processSkill(
  skill: SkillRecord,
  service: TransformationService,
  supabase: SupabaseClient,
  options: CliOptions,
  config: EnvConfig
): Promise<{ status: 'transformed' | 'skipped' | 'failed'; error?: string }> {
  if (!skill.repo_url) {
    return { status: 'skipped', error: 'No repo URL' }
  }

  // Fetch SKILL.md content (pass verbose for subdirectory logging)
  const { content, error: fetchError } = await fetchSkillContent(
    skill.repo_url,
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

async function main(): Promise<void> {
  const options = parseCliArgs()

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  const config = validateEnv()

  console.log('\n' + '='.repeat(60))
  console.log('Skillsmith Batch Transformation')
  console.log('='.repeat(60))
  console.log('')
  console.log('Configuration:')
  console.log('-'.repeat(50))
  console.log(`  Limit:    ${options.limit === Infinity ? 'all' : options.limit}`)
  console.log(`  Offset:   ${options.offset}`)
  console.log(`  Dry Run:  ${options.dryRun}`)
  console.log(`  Verbose:  ${options.verbose}`)
  console.log(`  GitHub:   ${config.githubToken ? 'authenticated' : 'anonymous'}`)
  console.log('-'.repeat(50))

  // Create Supabase client
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
  })

  // Create transformation service (no database caching)
  const service = new TransformationService(undefined, {
    enableCache: false,
    version: '1.0.0',
  })

  // Statistics
  const stats: TransformStats = {
    processed: 0,
    transformed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }

  const batchSize = 100
  let batchNumber = 0

  console.log('\nProcessing skills...\n')

  // Process skills in batches
  for await (const batch of fetchSkillsBatch(supabase, batchSize, options.offset, options.limit)) {
    batchNumber++
    const batchStart = (batchNumber - 1) * batchSize + options.offset + 1
    const batchEnd = batchStart + batch.length - 1

    console.log(`Batch ${batchNumber}: Skills ${batchStart}-${batchEnd}`)

    for (const skill of batch) {
      stats.processed++

      if (options.verbose) {
        console.log(`\n  [${stats.processed}] ${skill.id}`)
        console.log(`    Name: ${skill.name}`)
        console.log(`    Author: ${skill.author ?? 'unknown'}`)
      }

      const result = await processSkill(skill, service, supabase, options, config)

      switch (result.status) {
        case 'transformed':
          stats.transformed++
          if (!options.verbose) {
            process.stdout.write('.')
          }
          break
        case 'skipped':
          stats.skipped++
          if (options.verbose) {
            console.log(`    Skipped: ${result.error}`)
          } else {
            process.stdout.write('s')
          }
          break
        case 'failed':
          stats.failed++
          stats.errors.push(`${skill.id}: ${result.error}`)
          if (options.verbose) {
            console.log(`    FAILED: ${result.error}`)
          } else {
            process.stdout.write('F')
          }
          break
      }
    }

    if (!options.verbose) {
      console.log('') // Newline after progress dots
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60))
  console.log(options.dryRun ? 'DRY RUN SUMMARY' : 'TRANSFORMATION SUMMARY')
  console.log('='.repeat(60))
  console.log('')
  console.log('Results:')
  console.log('-'.repeat(50))
  console.log(`  Processed:   ${stats.processed}`)
  console.log(`  Transformed: ${stats.transformed}`)
  console.log(`  Skipped:     ${stats.skipped}`)
  console.log(`  Failed:      ${stats.failed}`)
  console.log('-'.repeat(50))

  if (stats.errors.length > 0) {
    console.log('')
    console.log('Errors:')
    stats.errors.slice(0, 10).forEach((err, idx) => {
      console.log(`  ${idx + 1}. ${err}`)
    })
    if (stats.errors.length > 10) {
      console.log(`  ... and ${stats.errors.length - 10} more`)
    }
  }

  console.log('')
  const statusColor = stats.failed === 0 ? '\x1b[32m' : '\x1b[33m'
  const status = stats.failed === 0 ? 'SUCCESS' : 'COMPLETED WITH ERRORS'
  console.log(`Status: ${statusColor}${status}\x1b[0m`)
  console.log('='.repeat(60))

  // Exit with error code if there were failures
  process.exit(stats.failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('\nFatal error:', error)
  process.exit(1)
})
