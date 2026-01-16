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
import {
  parseArgs,
  validateEnv,
  normalizeResponse,
  buildRequest,
  buildIndexerUrl,
  DEFAULT_TIMEOUT_MS,
  type CliOptions,
  type EnvConfig,
  type IndexerResponse,
} from './lib/trigger-indexer-utils.js'

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

// =============================================================================
// Environment Validation with Exit
// =============================================================================

function validateEnvOrExit(): EnvConfig {
  const result = validateEnv(process.env as Record<string, string | undefined>)

  if (!result.valid) {
    console.error('\nError: Missing required environment variables:')
    result.missingVars.forEach((v) => console.error(`  - ${v}`))
    console.error('\nMake sure to run with Varlock:')
    console.error('  varlock run -- npx tsx scripts/trigger-indexer.ts')
    console.error('\nOr set the variables in your shell:')
    console.error('  export SUPABASE_PROJECT_REF=your_project_ref')
    console.error('  export SUPABASE_ANON_KEY=your_anon_key')
    process.exit(2)
  }

  return result.config!
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
  const url = buildIndexerUrl(config.projectRef)
  const requestBody = buildRequest(options)

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

  const options = parseArgs(process.argv.slice(2))

  // Show help and exit
  if (options.help) {
    printHelp()
    process.exit(0)
  }

  // Validate environment
  const config = validateEnvOrExit()

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
