#!/usr/bin/env npx tsx
/**
 * Trigger Supabase Edge Function Indexer
 *
 * Triggers the Skillsmith indexer Edge Function to discover and index skills
 * from GitHub repositories based on topic search.
 *
 * Usage:
 *   varlock run -- npx tsx scripts/trigger-indexer.ts [options]
 *
 * Options:
 *   --dry-run              Preview what would be indexed without writing to database
 *   --topics <list>        Comma-separated topics to search (default: claude-code-skill,claude-code)
 *   --max-pages <n>        Max pages per topic (default: 5)
 *   --strict               Enable strict SKILL.md validation (default)
 *   --no-strict            Disable strict SKILL.md validation
 *   --min-length <n>       Minimum SKILL.md content length (default: 100)
 *   --help                 Show this help message
 *
 * Environment Variables:
 *   SUPABASE_PROJECT_REF   Supabase project reference (required)
 *   SUPABASE_ANON_KEY      Supabase anonymous key (required)
 *
 * Exit Codes:
 *   0 - Indexer completed successfully
 *   1 - Indexer completed with errors or failed
 *   2 - Configuration/environment error
 */

import * as fs from 'fs'
import * as path from 'path'

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_TOPICS = ['claude-code-skill', 'claude-code']
const DEFAULT_MAX_PAGES = 5
const DEFAULT_MIN_LENGTH = 100
const DEFAULT_TIMEOUT_MS = 120000 // 2 minutes for indexer

// =============================================================================
// Types
// =============================================================================

interface CliOptions {
  dryRun: boolean
  topics: string[]
  maxPages: number
  strict: boolean
  minLength: number
  help: boolean
}

interface IndexerRequest {
  dryRun?: boolean
  topics?: string[]
  maxPages?: number
  strictValidation?: boolean
  minContentLength?: number
}

interface IndexedSkill {
  id: string
  name: string
  author: string
  repo_url?: string
  trust_tier?: string
  quality_score?: number
}

interface IndexerResponse {
  success: boolean
  dryRun: boolean
  summary: {
    found: number
    indexed: number
    updated: number
    failed: number
  }
  skills?: IndexedSkill[]
  errors?: string[]
  message?: string
}

// =============================================================================
// Environment Loading
// =============================================================================

function loadEnv(): void {
  const envPath = path.join(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (match) {
        const [, key, value] = match
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value.trim()
        }
      }
    }
  }
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

function printHelp(): void {
  console.log(`
Trigger Supabase Edge Function Indexer

Usage:
  varlock run -- npx tsx scripts/trigger-indexer.ts [options]

Options:
  --dry-run              Preview what would be indexed without writing to database
  --topics <list>        Comma-separated topics to search (default: claude-code-skill,claude-code)
  --max-pages <n>        Max pages per topic (default: 5)
  --strict               Enable strict SKILL.md validation (default)
  --no-strict            Disable strict SKILL.md validation
  --min-length <n>       Minimum SKILL.md content length (default: 100)
  --help                 Show this help message

Environment Variables:
  SUPABASE_PROJECT_REF   Supabase project reference (required)
  SUPABASE_ANON_KEY      Supabase anonymous key (required)

Examples:
  # Dry-run to preview what would be indexed
  varlock run -- npx tsx scripts/trigger-indexer.ts --dry-run

  # Run with strict validation (default)
  varlock run -- npx tsx scripts/trigger-indexer.ts --strict

  # Custom topics with more pages
  varlock run -- npx tsx scripts/trigger-indexer.ts --topics claude-code-skill --max-pages 10

  # Lenient validation for experimental skills
  varlock run -- npx tsx scripts/trigger-indexer.ts --no-strict --min-length 50
`)
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)

  // Check for help first
  if (args.includes('--help') || args.includes('-h')) {
    return {
      dryRun: false,
      topics: DEFAULT_TOPICS,
      maxPages: DEFAULT_MAX_PAGES,
      strict: true,
      minLength: DEFAULT_MIN_LENGTH,
      help: true,
    }
  }

  const options: CliOptions = {
    dryRun: args.includes('--dry-run'),
    topics: DEFAULT_TOPICS,
    maxPages: DEFAULT_MAX_PAGES,
    strict: true,
    minLength: DEFAULT_MIN_LENGTH,
    help: false,
  }

  // Parse --topics
  const topicsIdx = args.indexOf('--topics')
  if (topicsIdx !== -1 && args[topicsIdx + 1]) {
    options.topics = args[topicsIdx + 1]
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }

  // Parse --max-pages
  const maxPagesIdx = args.indexOf('--max-pages')
  if (maxPagesIdx !== -1 && args[maxPagesIdx + 1]) {
    const parsed = parseInt(args[maxPagesIdx + 1], 10)
    if (!isNaN(parsed) && parsed > 0) {
      options.maxPages = parsed
    }
  }

  // Parse --strict / --no-strict
  if (args.includes('--no-strict')) {
    options.strict = false
  } else if (args.includes('--strict')) {
    options.strict = true
  }

  // Parse --min-length
  const minLengthIdx = args.indexOf('--min-length')
  if (minLengthIdx !== -1 && args[minLengthIdx + 1]) {
    const parsed = parseInt(args[minLengthIdx + 1], 10)
    if (!isNaN(parsed) && parsed >= 0) {
      options.minLength = parsed
    }
  }

  return options
}

// =============================================================================
// Environment Validation
// =============================================================================

interface EnvConfig {
  projectRef: string
  anonKey: string
}

function validateEnv(): EnvConfig {
  const projectRef = process.env.SUPABASE_PROJECT_REF
  const anonKey = process.env.SUPABASE_ANON_KEY

  const missing: string[] = []
  if (!projectRef) missing.push('SUPABASE_PROJECT_REF')
  if (!anonKey) missing.push('SUPABASE_ANON_KEY')

  if (missing.length > 0) {
    console.error('\nError: Missing required environment variables:')
    missing.forEach((v) => console.error(`  - ${v}`))
    console.error('\nMake sure to run with Varlock:')
    console.error('  varlock run -- npx tsx scripts/trigger-indexer.ts')
    console.error('\nOr set the variables in your shell:')
    console.error('  export SUPABASE_PROJECT_REF=your_project_ref')
    console.error('  export SUPABASE_ANON_KEY=your_anon_key')
    process.exit(2)
  }

  return { projectRef: projectRef!, anonKey: anonKey! }
}

// =============================================================================
// HTTP Helpers
// =============================================================================

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

// =============================================================================
// Indexer Trigger
// =============================================================================

async function triggerIndexer(config: EnvConfig, options: CliOptions): Promise<IndexerResponse> {
  const url = `https://${config.projectRef}.supabase.co/functions/v1/indexer`

  const requestBody: IndexerRequest = {
    dryRun: options.dryRun,
    topics: options.topics,
    maxPages: options.maxPages,
    strictValidation: options.strict,
    minContentLength: options.minLength,
  }

  console.log('\nRequest Parameters:')
  console.log('-'.repeat(50))
  console.log(`  URL:              ${url}`)
  console.log(`  Dry Run:          ${options.dryRun}`)
  console.log(`  Topics:           ${options.topics.join(', ')}`)
  console.log(`  Max Pages:        ${options.maxPages}`)
  console.log(`  Strict Mode:      ${options.strict}`)
  console.log(`  Min Length:       ${options.minLength}`)
  console.log('-'.repeat(50))
  console.log('\nTriggering indexer...')

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.anonKey}`,
        apikey: config.anonKey,
      },
      body: JSON.stringify(requestBody),
    },
    DEFAULT_TIMEOUT_MS
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }

  const data = await response.json()

  // Normalize response to expected format
  return normalizeResponse(data, options.dryRun)
}

/**
 * Normalize various response formats to the expected IndexerResponse structure
 */
function normalizeResponse(data: unknown, dryRun: boolean): IndexerResponse {
  // Handle null or undefined
  if (!data || typeof data !== 'object') {
    return {
      success: false,
      dryRun,
      summary: { found: 0, indexed: 0, updated: 0, failed: 0 },
      errors: ['Invalid response from indexer: empty or non-object response'],
    }
  }

  const raw = data as Record<string, unknown>

  // Handle { data: {...}, meta: {...} } wrapper from Edge Function
  if ('data' in raw && typeof raw.data === 'object' && raw.data !== null) {
    const innerData = raw.data as Record<string, unknown>
    // The data object contains: found, indexed, updated, failed, errors, dryRun, repositories_found
    const summary = {
      found: typeof innerData.found === 'number' ? innerData.found : 0,
      indexed: typeof innerData.indexed === 'number' ? innerData.indexed : 0,
      updated: typeof innerData.updated === 'number' ? innerData.updated : 0,
      failed: typeof innerData.failed === 'number' ? innerData.failed : 0,
    }

    const errors = Array.isArray(innerData.errors)
      ? innerData.errors.map((e: unknown) => String(e)).filter((e) => e.length > 0)
      : undefined

    return {
      success: summary.failed === 0 && (!errors || errors.length === 0),
      dryRun: typeof innerData.dryRun === 'boolean' ? innerData.dryRun : dryRun,
      summary,
      errors: errors && errors.length > 0 ? errors : undefined,
    }
  }

  // Check if response has expected structure (legacy format)
  const hasExpectedFields = 'summary' in raw || 'success' in raw || 'skills' in raw

  if (!hasExpectedFields) {
    // Return raw response as error details
    return {
      success: false,
      dryRun,
      summary: { found: 0, indexed: 0, updated: 0, failed: 0 },
      errors: [`Unexpected response format: ${JSON.stringify(data).substring(0, 200)}`],
    }
  }

  // Extract summary with defaults (legacy format)
  const rawSummary = (raw.summary || {}) as Record<string, unknown>
  const summary = {
    found: typeof rawSummary.found === 'number' ? rawSummary.found : 0,
    indexed: typeof rawSummary.indexed === 'number' ? rawSummary.indexed : 0,
    updated: typeof rawSummary.updated === 'number' ? rawSummary.updated : 0,
    failed: typeof rawSummary.failed === 'number' ? rawSummary.failed : 0,
  }

  // Extract skills array
  let skills: IndexedSkill[] | undefined
  if (Array.isArray(raw.skills)) {
    skills = raw.skills.map((s: unknown) => {
      const skill = s as Record<string, unknown>
      return {
        id: String(skill.id || 'unknown'),
        name: String(skill.name || skill.id || 'unknown'),
        author: String(skill.author || 'unknown'),
        repo_url: skill.repo_url ? String(skill.repo_url) : undefined,
        trust_tier: skill.trust_tier ? String(skill.trust_tier) : undefined,
        quality_score: typeof skill.quality_score === 'number' ? skill.quality_score : undefined,
      }
    })
  }

  // Extract errors array
  let errors: string[] | undefined
  if (Array.isArray(raw.errors)) {
    errors = raw.errors.map((e: unknown) => String(e))
  }

  return {
    success: raw.success !== false, // Default to true unless explicitly false
    dryRun: typeof raw.dryRun === 'boolean' ? raw.dryRun : dryRun,
    summary,
    skills,
    errors,
    message: typeof raw.message === 'string' ? raw.message : undefined,
  }
}

// =============================================================================
// Output Formatting
// =============================================================================

function printResponse(response: IndexerResponse): void {
  console.log('\n' + '='.repeat(60))
  console.log(response.dryRun ? 'DRY RUN RESULTS' : 'INDEXER RESULTS')
  console.log('='.repeat(60))

  console.log('\nSummary:')
  console.log('-'.repeat(50))
  console.log(`  Found:    ${response.summary.found}`)
  console.log(`  Indexed:  ${response.summary.indexed}`)
  console.log(`  Updated:  ${response.summary.updated}`)
  console.log(`  Failed:   ${response.summary.failed}`)

  if (response.skills && response.skills.length > 0) {
    console.log('\nIndexed Skills:')
    console.log('-'.repeat(50))
    response.skills.forEach((skill, idx) => {
      const tier = skill.trust_tier || 'unknown'
      const score = skill.quality_score !== undefined ? skill.quality_score.toFixed(1) : 'N/A'
      console.log(`  ${idx + 1}. ${skill.id}`)
      console.log(`     Author: ${skill.author}`)
      console.log(`     Trust:  ${tier} | Score: ${score}`)
      if (skill.repo_url) {
        console.log(`     Repo:   ${skill.repo_url}`)
      }
      console.log('')
    })
  }

  if (response.errors && response.errors.length > 0) {
    console.log('\nErrors:')
    console.log('-'.repeat(50))
    response.errors.forEach((error, idx) => {
      console.log(`  ${idx + 1}. ${error}`)
    })
  }

  if (response.message) {
    console.log(`\nMessage: ${response.message}`)
  }

  console.log('\n' + '='.repeat(60))
  const status = response.success ? 'SUCCESS' : 'COMPLETED WITH ERRORS'
  const statusColor = response.success ? '\x1b[32m' : '\x1b[33m'
  console.log(`Status: ${statusColor}${status}\x1b[0m`)
  console.log('='.repeat(60))
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  // Load environment variables from .env (Varlock will override with real values)
  loadEnv()

  const options = parseArgs()

  // Show help and exit
  if (options.help) {
    printHelp()
    process.exit(0)
  }

  // Validate environment
  const config = validateEnv()

  console.log('\n' + '='.repeat(60))
  console.log('Skillsmith Indexer Trigger')
  console.log('='.repeat(60))

  try {
    const response = await triggerIndexer(config, options)
    printResponse(response)

    // Exit with appropriate code
    const exitCode = response.success && response.summary.failed === 0 ? 0 : 1
    process.exit(exitCode)
  } catch (error) {
    console.error('\nError triggering indexer:')

    if (error instanceof Error) {
      if (error.message.includes('abort')) {
        console.error(`  Request timed out after ${DEFAULT_TIMEOUT_MS / 1000} seconds`)
        console.error('  The indexer may still be running. Check Supabase logs.')
      } else {
        console.error(`  ${error.message}`)
      }
    } else {
      console.error(`  ${String(error)}`)
    }

    console.error('\nTroubleshooting:')
    console.error('  - Verify SUPABASE_PROJECT_REF is correct')
    console.error('  - Check that the indexer Edge Function is deployed')
    console.error('  - Review Edge Function logs in Supabase dashboard')

    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error)
  process.exit(1)
})
