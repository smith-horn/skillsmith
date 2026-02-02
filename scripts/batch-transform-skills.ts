#!/usr/bin/env npx tsx
/**
 * Batch Skill Transformation CLI
 * SMI-1840: Pre-transform skills using TransformationService
 * SMI-2200: Checkpoint-based resumability
 * SMI-2203: Dynamic rate limiting
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
 *   varlock run -- npx tsx scripts/batch-transform-skills.ts --resume
 *   docker exec skillsmith-dev-1 varlock run -- npx tsx scripts/batch-transform-skills.ts
 *
 * Options:
 *   --limit <n>              Maximum skills to process (default: all)
 *   --offset <n>             Skip first n skills (default: 0)
 *   --dry-run, -d            Preview transformations without saving
 *   --verbose, -v            Show detailed output
 *   --resume, -r             Continue from last checkpoint
 *   --reset                  Clear checkpoint and start over (prompts for confirmation)
 *   --checkpoint-interval, -C  Save checkpoint every N skills (default: 50)
 *   --force, -f              Skip confirmation prompts (for CI/scripted use)
 *   --no-rate-limit          Bypass dynamic rate limiting (fixed 50ms delay)
 *   --help, -h               Show this help message
 *
 * Environment Variables:
 *   SUPABASE_URL                 Supabase project URL (required)
 *   SUPABASE_SERVICE_ROLE_KEY    Supabase service role key (required)
 *   GITHUB_TOKEN                 GitHub token for fetching SKILL.md (optional, higher rate limits)
 *   GITHUB_API_BASE_DELAY        Base delay between GitHub requests in ms (default: 150)
 */

import { parseArgs } from 'node:util'
import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { TransformationService, type TransformationResult, parseRepoUrl } from '@skillsmith/core'
import { type MigrationCheckpoint, GitHubRateLimiter } from './lib/migration-utils'
import {
  GITHUB_API_BASE_DELAY,
  DEFAULT_CHECKPOINT_INTERVAL,
  BATCH_TRANSFORM_CHECKPOINT_FILE,
} from './lib/constants'

// =============================================================================
// Types
// =============================================================================

/**
 * SMI-2204: Progress mode types
 * Exported for use in tests
 */
export type ProgressMode = 'dots' | 'bar' | 'json'

/**
 * Validate that a string is a valid progress mode
 * Exported for use in tests
 */
export function validateProgressMode(mode: string): boolean {
  return ['dots', 'bar', 'json'].includes(mode)
}

interface CliOptions {
  limit: number
  offset: number
  dryRun: boolean
  verbose: boolean
  help: boolean
  resume: boolean
  reset: boolean
  checkpointInterval: number
  force: boolean
  noRateLimit: boolean
  // SMI-2201: Filter flags
  retryFailed: boolean
  retrySkipped: boolean
  onlyMissing: boolean
  since: string | undefined
  trustTier: string | undefined
  monorepoSkills: boolean
  // SMI-2204: Progress and output options
  progress: ProgressMode
  json: boolean
}

/**
 * SMI-2201: Filter configuration for targeted backfills
 */
interface SkillFilters {
  retryFailed: boolean
  retrySkipped: boolean
  onlyMissing: boolean
  since: string | undefined
  trustTier: string | undefined
  monorepoSkills: boolean
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
  failedSkillIds: string[]
  skippedSkillIds: string[]
}

/**
 * SMI-2200: Extended checkpoint for batch-transform
 */
interface BatchTransformCheckpoint extends MigrationCheckpoint {
  failedSkillIds: string[]
  skippedSkillIds: string[]
  runId: string
}

/**
 * SMI-2204: Result of processing a single skill
 */
interface ProcessResult {
  status: 'transformed' | 'skipped' | 'failed'
  error?: string
}

/**
 * SMI-2204: JSON output schema for --json flag
 */
interface JsonOutput {
  processed: number
  transformed: number
  skipped: number
  failed: number
  duration_ms: number
  checkpoint: { offset: number; timestamp: string } | null
  failed_skills: string[]
  skipped_skills: Array<{ id: string; reason: string }>
}

// =============================================================================
// SMI-2204: Progress Reporter Interface and Implementations
// =============================================================================

/**
 * Interface for progress reporting during batch transformation
 */
interface ProgressReporter {
  /** Initialize progress tracking */
  start(total: number | null, options: CliOptions): void
  /** Report start of a batch */
  batchStart(batchNum: number, startIdx: number, endIdx: number): void
  /** Report progress for a single skill */
  update(skill: SkillRecord, result: ProcessResult, stats: TransformStats): void
  /** Report checkpoint saved */
  checkpoint(offset: number): void
  /** Report end of batch */
  batchEnd(): void
  /** Finalize and return optional JSON output */
  finish(stats: TransformStats, duration: number, runId: string): JsonOutput | null
}

/**
 * Dots progress reporter (default for CI)
 * Outputs: . for success, s for skip, F for failure
 */
class DotsProgressReporter implements ProgressReporter {
  private verbose = false

  start(_total: number | null, options: CliOptions): void {
    this.verbose = options.verbose
    if (!options.json) {
      console.log('\nProcessing skills...\n')
    }
  }

  batchStart(batchNum: number, startIdx: number, endIdx: number): void {
    if (!this.verbose) {
      console.log(`Batch ${batchNum}: Skills ${startIdx}-${endIdx}`)
    }
  }

  update(skill: SkillRecord, result: ProcessResult, stats: TransformStats): void {
    if (this.verbose) {
      console.log(`\n  [${stats.processed}] ${skill.id}`)
      console.log(`    Name: ${skill.name}`)
      console.log(`    Author: ${skill.author ?? 'unknown'}`)
      if (result.status === 'skipped') {
        console.log(`    Skipped: ${result.error}`)
      } else if (result.status === 'failed') {
        console.log(`    FAILED: ${result.error}`)
      }
    } else {
      switch (result.status) {
        case 'transformed':
          process.stdout.write('.')
          break
        case 'skipped':
          process.stdout.write('s')
          break
        case 'failed':
          process.stdout.write('F')
          break
      }
    }
  }

  checkpoint(offset: number): void {
    if (this.verbose) {
      console.log(`    📍 Checkpoint saved at offset ${offset}`)
    }
  }

  batchEnd(): void {
    if (!this.verbose) {
      console.log('') // Newline after progress dots
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  finish(stats: TransformStats, duration: number, runId: string): null {
    return null
  }
}

/**
 * Progress bar reporter (default for TTY)
 * Shows: [=====>     ] 47% (235/500) | 2.3/s | ETA: 3m 22s
 */
class BarProgressReporter implements ProgressReporter {
  private total: number | null = null
  private startTime = 0
  private verbose = false
  private lastRender = 0
  private renderInterval = 100 // ms between renders

  start(total: number | null, options: CliOptions): void {
    this.total = total
    this.startTime = Date.now()
    this.verbose = options.verbose
    if (!options.json) {
      console.log('\nProcessing skills...\n')
    }
  }

  batchStart(batchNum: number, startIdx: number, endIdx: number): void {
    if (this.verbose) {
      console.log(`Batch ${batchNum}: Skills ${startIdx}-${endIdx}`)
    }
  }

  update(skill: SkillRecord, result: ProcessResult, stats: TransformStats): void {
    if (this.verbose) {
      console.log(`\n  [${stats.processed}] ${skill.id}`)
      console.log(`    Name: ${skill.name}`)
      console.log(`    Author: ${skill.author ?? 'unknown'}`)
      if (result.status === 'skipped') {
        console.log(`    Skipped: ${result.error}`)
      } else if (result.status === 'failed') {
        console.log(`    FAILED: ${result.error}`)
      }
      return
    }

    // Throttle renders to avoid flickering
    const now = Date.now()
    if (now - this.lastRender < this.renderInterval) {
      return
    }
    this.lastRender = now

    this.renderProgressBar(stats, skill.name)
  }

  private renderProgressBar(stats: TransformStats, currentSkill: string): void {
    const elapsed = (Date.now() - this.startTime) / 1000
    const rate = stats.processed / elapsed
    const percent = this.total ? Math.round((stats.processed / this.total) * 100) : 0
    const eta = this.total && rate > 0 ? Math.round((this.total - stats.processed) / rate) : 0

    // Build progress bar
    const barWidth = 30
    const filled = this.total ? Math.round((stats.processed / this.total) * barWidth) : 0
    const bar =
      '='.repeat(filled) +
      (filled < barWidth ? '>' : '') +
      ' '.repeat(Math.max(0, barWidth - filled - 1))

    // Format ETA
    const etaStr = eta > 0 ? `${Math.floor(eta / 60)}m ${eta % 60}s` : '--'

    // Build status line
    const countStr = this.total ? `(${stats.processed}/${this.total})` : `(${stats.processed})`
    const statusLine = `Transforming [${bar}] ${percent}% ${countStr} | ${rate.toFixed(1)}/s | ETA: ${etaStr}`

    // Clear line and write
    process.stdout.write('\r' + ' '.repeat(80) + '\r')
    process.stdout.write(statusLine)

    // Show current skill on next line if space
    if (currentSkill.length > 40) {
      currentSkill = currentSkill.slice(0, 37) + '...'
    }
    process.stdout.write(`\n  Processing: ${currentSkill}`)
    process.stdout.write('\x1b[1A') // Move cursor up
  }

  checkpoint(offset: number): void {
    if (this.verbose) {
      console.log(`\n📍 Checkpoint saved at offset ${offset}`)
    }
  }

  batchEnd(): void {
    // Clear progress bar line
    if (!this.verbose) {
      process.stdout.write('\r' + ' '.repeat(80) + '\r')
      process.stdout.write('\r' + ' '.repeat(80) + '\r\n')
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  finish(stats: TransformStats, duration: number, runId: string): null {
    // Clear any remaining progress bar
    process.stdout.write('\r' + ' '.repeat(80) + '\r')
    return null
  }
}

/**
 * JSON progress reporter (for scripting)
 * Outputs NDJSON lines per skill
 */
class JsonProgressReporter implements ProgressReporter {
  private skippedReasons: Map<string, string> = new Map()

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  start(total: number | null, options: CliOptions): void {
    // No header output for clean NDJSON
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  batchStart(batchNum: number, startIdx: number, endIdx: number): void {
    // No batch markers in JSON mode
  }

  update(skill: SkillRecord, result: ProcessResult, stats: TransformStats): void {
    // Track skipped reasons for final output
    if (result.status === 'skipped' && result.error) {
      this.skippedReasons.set(skill.id, result.error)
    }

    // Output NDJSON line for each skill
    const line = {
      type: 'progress',
      skill_id: skill.id,
      skill_name: skill.name,
      status: result.status,
      error: result.error ?? null,
      stats: {
        processed: stats.processed,
        transformed: stats.transformed,
        skipped: stats.skipped,
        failed: stats.failed,
      },
    }
    console.log(JSON.stringify(line))
  }

  checkpoint(offset: number): void {
    const line = {
      type: 'checkpoint',
      offset,
      timestamp: new Date().toISOString(),
    }
    console.log(JSON.stringify(line))
  }

  batchEnd(): void {
    // No batch end markers
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  finish(stats: TransformStats, duration: number, runId: string): JsonOutput {
    return {
      processed: stats.processed,
      transformed: stats.transformed,
      skipped: stats.skipped,
      failed: stats.failed,
      duration_ms: duration,
      checkpoint: null, // Filled by caller if exists
      failed_skills: stats.failedSkillIds,
      skipped_skills: stats.skippedSkillIds.map((id) => ({
        id,
        reason: this.skippedReasons.get(id) ?? 'Unknown',
      })),
    }
  }
}

/**
 * Create appropriate progress reporter based on options
 */
function createProgressReporter(options: CliOptions): ProgressReporter {
  switch (options.progress) {
    case 'json':
      return new JsonProgressReporter()
    case 'bar':
      // Fall back to dots if not in TTY
      return isTTY() ? new BarProgressReporter() : new DotsProgressReporter()
    case 'dots':
    default:
      return new DotsProgressReporter()
  }
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

/**
 * Detect if running in TTY (interactive terminal) vs CI/pipe
 * Exported for use in tests
 */
export function isTTY(): boolean {
  return process.stdout.isTTY === true
}

/**
 * Get default progress mode based on environment
 * Exported for use in tests
 */
export function getDefaultProgressMode(): ProgressMode {
  // In TTY, use bar; in CI/pipe, use dots
  return isTTY() ? 'bar' : 'dots'
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string', short: 'l' },
      offset: { type: 'string', short: 'o' },
      'dry-run': { type: 'boolean', short: 'd' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      resume: { type: 'boolean', short: 'r' },
      reset: { type: 'boolean' },
      'checkpoint-interval': { type: 'string', short: 'C' },
      force: { type: 'boolean', short: 'f' },
      'no-rate-limit': { type: 'boolean' },
      // SMI-2201: Filter flags
      'retry-failed': { type: 'boolean' },
      'retry-skipped': { type: 'boolean' },
      'only-missing': { type: 'boolean' },
      since: { type: 'string' },
      'trust-tier': { type: 'string' },
      'monorepo-skills': { type: 'boolean' },
      // SMI-2204: Progress and output options
      progress: { type: 'string', short: 'p' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  })

  // Validate progress mode using exported function
  const progressMode = values.progress as ProgressMode | undefined
  if (progressMode && !validateProgressMode(progressMode)) {
    console.error(`Error: Invalid progress mode '${progressMode}'. Valid modes: dots, bar, json`)
    process.exit(1)
  }

  return {
    limit: values.limit ? parseInt(values.limit, 10) : Infinity,
    offset: values.offset ? parseInt(values.offset, 10) : 0,
    dryRun: values['dry-run'] ?? false,
    verbose: values.verbose ?? false,
    help: values.help ?? false,
    resume: values.resume ?? false,
    reset: values.reset ?? false,
    checkpointInterval: values['checkpoint-interval']
      ? parseInt(values['checkpoint-interval'], 10)
      : DEFAULT_CHECKPOINT_INTERVAL,
    force: values.force ?? false,
    noRateLimit: values['no-rate-limit'] ?? false,
    // SMI-2201: Filter flags
    retryFailed: values['retry-failed'] ?? false,
    retrySkipped: values['retry-skipped'] ?? false,
    onlyMissing: values['only-missing'] ?? false,
    since: values.since,
    trustTier: values['trust-tier'],
    monorepoSkills: values['monorepo-skills'] ?? false,
    // SMI-2204: Progress and output options
    progress: progressMode ?? getDefaultProgressMode(),
    json: values.json ?? false,
  }
}

function printHelp(): void {
  console.log(`
Batch Skill Transformation CLI
SMI-1840: Pre-transform skills using TransformationService
SMI-2200: Checkpoint-based resumability
SMI-2201: Targeted backfill modes
SMI-2203: Dynamic rate limiting
SMI-2204: Progress modes and UX improvements

Usage:
  varlock run -- npx tsx scripts/batch-transform-skills.ts [options]

Options:
  --limit, -l <n>              Maximum skills to process (default: all)
  --offset, -o <n>             Skip first n skills (default: 0)
  --dry-run, -d                Preview transformations without saving
  --verbose, -v                Show detailed output
  --resume, -r                 Continue from last checkpoint
  --reset                      Clear checkpoint and start over (prompts for confirmation)
  --checkpoint-interval, -C <n> Save checkpoint every N skills (default: ${DEFAULT_CHECKPOINT_INTERVAL})
  --force, -f                  Skip confirmation prompts (for CI/scripted use)
  --no-rate-limit              Bypass dynamic rate limiting (fixed 50ms delay)
  --help, -h                   Show this help message

Filter Flags (SMI-2201):
  --retry-failed               Only process skills where previous transform failed
  --retry-skipped              Only process skills that were skipped (SKILL.md not found)
  --only-missing               Only process skills without existing transformation
  --since <YYYY-MM-DD>         Only process skills indexed after date (ISO-8601)
  --trust-tier <tier>          Filter by trust tier (verified, community, experimental, unknown)
  --monorepo-skills            Only process monorepo subdirectory skills (tree URLs)

Progress and Output (SMI-2204):
  --progress, -p <mode>        Progress display mode (default: bar in TTY, dots in CI)
                               - dots: Simple progress dots (. = ok, s = skip, F = fail)
                               - bar: Progress bar with ETA (requires TTY)
                               - json: NDJSON output per skill (for scripting)
  --json                       Output final results as JSON (machine-readable)

Environment Variables:
  SUPABASE_URL                 Supabase project URL (required)
  SUPABASE_SERVICE_ROLE_KEY    Supabase service role key (required)
  GITHUB_TOKEN                 GitHub token for higher rate limits (optional)
  GITHUB_API_BASE_DELAY        Base delay between GitHub requests in ms (default: 150)

Examples:
  # Dry-run first 10 skills
  varlock run -- npx tsx scripts/batch-transform-skills.ts --dry-run --limit 10

  # Transform all skills with verbose output
  varlock run -- npx tsx scripts/batch-transform-skills.ts --verbose

  # Resume from last checkpoint
  varlock run -- npx tsx scripts/batch-transform-skills.ts --resume

  # Reset checkpoint and start fresh
  varlock run -- npx tsx scripts/batch-transform-skills.ts --reset --force

  # Retry only failed skills
  varlock run -- npx tsx scripts/batch-transform-skills.ts --retry-failed --verbose

  # Process only missing transformations for verified tier
  varlock run -- npx tsx scripts/batch-transform-skills.ts --only-missing --trust-tier verified

  # Process skills indexed since January 25, 2026
  varlock run -- npx tsx scripts/batch-transform-skills.ts --since 2026-01-25

  # Dry-run with filter preview
  varlock run -- npx tsx scripts/batch-transform-skills.ts --dry-run --only-missing --monorepo-skills

  # Use progress bar mode
  varlock run -- npx tsx scripts/batch-transform-skills.ts --progress bar

  # Output JSON for scripting
  varlock run -- npx tsx scripts/batch-transform-skills.ts --json --progress json
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
// Checkpoint Management (SMI-2200)
// =============================================================================

const CHECKPOINT_PATH = path.join(process.cwd(), BATCH_TRANSFORM_CHECKPOINT_FILE)

function loadBatchTransformCheckpoint(): BatchTransformCheckpoint | null {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      const data = fs.readFileSync(CHECKPOINT_PATH, 'utf-8')
      const parsed = JSON.parse(data) as BatchTransformCheckpoint
      if (typeof parsed.processedCount === 'number' && parsed.runId) {
        console.log(`\n📍 Found checkpoint: ${parsed.processedCount} skills processed`)
        console.log(`   Run ID: ${parsed.runId}`)
        console.log(`   Last offset: ${parsed.lastProcessedOffset}`)
        console.log(`   Timestamp: ${parsed.timestamp}`)
        return parsed
      }
    }
  } catch (error) {
    // Log error details for debugging (SMI-2204: Fix silent catch)
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.warn(`Invalid checkpoint format, starting fresh: ${errorMsg}`)
  }
  return null
}

function saveBatchTransformCheckpoint(checkpoint: BatchTransformCheckpoint): void {
  // Create backup before saving
  if (fs.existsSync(CHECKPOINT_PATH)) {
    fs.copyFileSync(CHECKPOINT_PATH, CHECKPOINT_PATH + '.bak')
  }
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2))
}

function clearBatchTransformCheckpoint(): void {
  if (fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH)
    console.log('✓ Checkpoint cleared.')
  }
  // Also remove backup
  if (fs.existsSync(CHECKPOINT_PATH + '.bak')) {
    fs.unlinkSync(CHECKPOINT_PATH + '.bak')
  }
}

async function promptConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes')
    })
  })
}

// =============================================================================
// SMI-2201: Filter Validation and Preview
// =============================================================================

const VALID_TRUST_TIERS = ['verified', 'community', 'experimental', 'unknown'] as const

/**
 * Validate ISO-8601 date format (YYYY-MM-DD)
 */
function isValidIsoDate(dateStr: string): boolean {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!isoDateRegex.test(dateStr)) return false

  const date = new Date(dateStr)
  return !isNaN(date.getTime())
}

/**
 * Validate filter options and return errors if any
 */
function validateFilters(options: CliOptions): string[] {
  const errors: string[] = []

  // Validate --since format
  if (options.since && !isValidIsoDate(options.since)) {
    errors.push(`Invalid date format '${options.since}'. Use ISO-8601: --since 2026-01-25`)
  }

  // Validate --trust-tier value
  if (
    options.trustTier &&
    !VALID_TRUST_TIERS.includes(options.trustTier as (typeof VALID_TRUST_TIERS)[number])
  ) {
    errors.push(
      `Invalid trust tier '${options.trustTier}'. Valid values: ${VALID_TRUST_TIERS.join(', ')}`
    )
  }

  // Warn about incompatible combinations
  if (options.retryFailed && options.retrySkipped) {
    errors.push('--retry-failed and --retry-skipped are mutually exclusive')
  }

  if ((options.retryFailed || options.retrySkipped) && options.onlyMissing) {
    errors.push('--retry-failed/--retry-skipped and --only-missing are mutually exclusive')
  }

  return errors
}

/**
 * Check if any filters are active
 */
function hasActiveFilters(options: CliOptions): boolean {
  return (
    options.retryFailed ||
    options.retrySkipped ||
    options.onlyMissing ||
    !!options.since ||
    !!options.trustTier ||
    options.monorepoSkills
  )
}

/**
 * Get filter counts for preview (dry-run)
 */
async function getFilterPreview(
  supabase: SupabaseClient,
  options: CliOptions
): Promise<{ total: number; breakdown: Record<string, number> }> {
  const breakdown: Record<string, number> = {}

  // Get total skills with repo_url
  const { count: totalCount } = await supabase
    .from('skills')
    .select('id', { count: 'exact', head: true })
    .not('repo_url', 'is', null)

  breakdown['Total skills (with repo_url)'] = totalCount ?? 0

  // Filter: --trust-tier
  if (options.trustTier) {
    const { count } = await supabase
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .not('repo_url', 'is', null)
      .eq('trust_tier', options.trustTier)
    breakdown[`Trust tier = ${options.trustTier}`] = count ?? 0
  }

  // Filter: --since
  if (options.since) {
    const { count } = await supabase
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .not('repo_url', 'is', null)
      .gte('created_at', options.since)
    breakdown[`Indexed since ${options.since}`] = count ?? 0
  }

  // Filter: --monorepo-skills (URLs containing /tree/)
  if (options.monorepoSkills) {
    const { count } = await supabase
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .not('repo_url', 'is', null)
      .like('repo_url', '%/tree/%')
    breakdown['Monorepo skills (/tree/ URLs)'] = count ?? 0
  }

  // Filter: --only-missing
  if (options.onlyMissing) {
    const { count } = await supabase
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .not('repo_url', 'is', null)
      .is('skill_transformations.skill_id', null)
    breakdown['Missing transformations'] = count ?? 0
  }

  // Filter: --retry-failed (from checkpoint)
  if (options.retryFailed) {
    const checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint?.failedSkillIds?.length) {
      breakdown['Failed in previous run'] = checkpoint.failedSkillIds.length
    } else {
      breakdown['Failed in previous run'] = 0
    }
  }

  // Filter: --retry-skipped (from checkpoint)
  if (options.retrySkipped) {
    const checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint?.skippedSkillIds?.length) {
      breakdown['Skipped in previous run'] = checkpoint.skippedSkillIds.length
    } else {
      breakdown['Skipped in previous run'] = 0
    }
  }

  // Calculate combined count (simplified - actual query does intersection)
  let combinedCount = totalCount ?? 0
  if (options.trustTier)
    combinedCount = Math.min(combinedCount, breakdown[`Trust tier = ${options.trustTier}`])
  if (options.since)
    combinedCount = Math.min(combinedCount, breakdown[`Indexed since ${options.since}`])
  if (options.monorepoSkills)
    combinedCount = Math.min(combinedCount, breakdown['Monorepo skills (/tree/ URLs)'])
  if (options.onlyMissing)
    combinedCount = Math.min(combinedCount, breakdown['Missing transformations'])
  if (options.retryFailed) combinedCount = breakdown['Failed in previous run']
  if (options.retrySkipped) combinedCount = breakdown['Skipped in previous run']

  return { total: combinedCount, breakdown }
}

/**
 * Print filter preview for dry-run mode
 */
function printFilterPreview(breakdown: Record<string, number>, total: number): void {
  console.log('\nFilters applied:')
  console.log('-'.repeat(50))
  for (const [filter, count] of Object.entries(breakdown)) {
    console.log(`  ${filter}: ${count} skills`)
  }
  console.log('-'.repeat(50))
  console.log(`  Combined: ${total} skills to process`)
  console.log('')
}

// =============================================================================
// Audit Logging (SMI-2200)
// =============================================================================

interface AuditLogEntry {
  event_type: string
  result?: 'success' | 'partial' | 'failed'
  metadata: Record<string, unknown>
}

async function writeAuditLog(supabase: SupabaseClient, entry: AuditLogEntry): Promise<void> {
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

// =============================================================================
// GitHub Content Fetching
// =============================================================================

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

// =============================================================================
// Database Operations
// =============================================================================

/**
 * Fetch skills from Supabase with pagination and filters (SMI-2201)
 */
async function* fetchSkillsBatch(
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

async function main(): Promise<void> {
  const options = parseCliArgs()

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  // Validate flag combinations
  if (options.resume && options.offset > 0) {
    console.error('Error: --resume and --offset are mutually exclusive')
    process.exit(1)
  }

  // SMI-2201: Validate filter options
  const filterErrors = validateFilters(options)
  if (filterErrors.length > 0) {
    console.error('\nError: Invalid filter options:')
    filterErrors.forEach((e) => console.error(`  - ${e}`))
    process.exit(1)
  }

  const config = validateEnv()

  // Handle --reset
  if (options.reset) {
    const checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint) {
      if (!options.force) {
        const confirmed = await promptConfirmation(
          `This will clear checkpoint with ${checkpoint.processedCount} processed records. Continue?`
        )
        if (!confirmed) {
          console.log('Aborted.')
          process.exit(0)
        }
      }
    }
    clearBatchTransformCheckpoint()
    if (!options.resume) {
      // If just --reset without other operations, exit
      process.exit(0)
    }
  }

  // Handle --resume
  let checkpoint: BatchTransformCheckpoint | null = null
  let startOffset = options.offset
  const runId = randomUUID()

  if (options.resume) {
    checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint) {
      startOffset = checkpoint.lastProcessedOffset
      console.log(`\n🔄 Resuming from offset ${startOffset}`)
    } else {
      console.log('\n📍 No checkpoint found, starting fresh')
    }
  }

  // Create rate limiter
  const rateLimiter = options.noRateLimit
    ? new GitHubRateLimiter(50) // Fixed 50ms for testing
    : new GitHubRateLimiter(GITHUB_API_BASE_DELAY)

  console.log('\n' + '='.repeat(60))
  console.log('Skillsmith Batch Transformation')
  console.log('='.repeat(60))
  console.log('')
  console.log('Configuration:')
  console.log('-'.repeat(50))
  console.log(`  Run ID:     ${runId.slice(0, 8)}...`)
  console.log(`  Limit:      ${options.limit === Infinity ? 'all' : options.limit}`)
  console.log(`  Offset:     ${startOffset}`)
  console.log(`  Dry Run:    ${options.dryRun}`)
  console.log(`  Verbose:    ${options.verbose}`)
  console.log(`  GitHub:     ${config.githubToken ? 'authenticated' : 'anonymous'}`)
  console.log(
    `  Rate Limit: ${options.noRateLimit ? 'disabled (50ms)' : `dynamic (base: ${GITHUB_API_BASE_DELAY}ms)`}`
  )
  console.log(`  Checkpoint: every ${options.checkpointInterval} skills`)

  // SMI-2201: Show active filters
  if (hasActiveFilters(options)) {
    console.log('')
    console.log('Active Filters:')
    if (options.retryFailed) console.log('  --retry-failed')
    if (options.retrySkipped) console.log('  --retry-skipped')
    if (options.onlyMissing) console.log('  --only-missing')
    if (options.since) console.log(`  --since ${options.since}`)
    if (options.trustTier) console.log(`  --trust-tier ${options.trustTier}`)
    if (options.monorepoSkills) console.log('  --monorepo-skills')
  }
  console.log('-'.repeat(50))

  // Create Supabase client
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
  })

  // SMI-2201: Show filter preview in dry-run mode
  if (options.dryRun && hasActiveFilters(options)) {
    const { total, breakdown } = await getFilterPreview(supabase, options)
    printFilterPreview(breakdown, total)

    if (total === 0) {
      console.log('No skills match the specified filters. Nothing to process.')
      process.exit(0)
    }
  }

  // Create transformation service (no database caching)
  const service = new TransformationService(undefined, {
    enableCache: false,
    version: '1.0.0',
  })

  // Statistics
  const stats: TransformStats = {
    processed: checkpoint?.processedCount ?? 0,
    transformed: checkpoint?.successCount ?? 0,
    skipped: 0,
    failed: checkpoint?.errorCount ?? 0,
    errors: checkpoint?.errors ?? [],
    failedSkillIds: checkpoint?.failedSkillIds ?? [],
    skippedSkillIds: checkpoint?.skippedSkillIds ?? [],
  }

  const startTime = Date.now()

  // Write audit log: start
  if (!options.dryRun) {
    await writeAuditLog(supabase, {
      event_type: 'batch-transform:start',
      metadata: {
        run_id: runId,
        options: {
          limit: options.limit === Infinity ? 'all' : options.limit,
          offset: startOffset,
          dry_run: options.dryRun,
          checkpoint_interval: options.checkpointInterval,
          resumed_from: checkpoint?.runId,
        },
      },
    })
  }

  const batchSize = 100
  let batchNumber = 0
  let skillsSinceCheckpoint = 0

  // SMI-2204: Create progress reporter
  const progressReporter = createProgressReporter(options)
  progressReporter.start(options.limit === Infinity ? null : options.limit, options)

  // SMI-2201: Build filter configuration
  const filters: SkillFilters = {
    retryFailed: options.retryFailed,
    retrySkipped: options.retrySkipped,
    onlyMissing: options.onlyMissing,
    since: options.since,
    trustTier: options.trustTier,
    monorepoSkills: options.monorepoSkills,
  }

  try {
    // Process skills in batches
    for await (const batch of fetchSkillsBatch(
      supabase,
      batchSize,
      startOffset,
      options.limit,
      filters
    )) {
      batchNumber++
      const batchStartIdx = (batchNumber - 1) * batchSize + startOffset + 1
      const batchEndIdx = batchStartIdx + batch.length - 1

      progressReporter.batchStart(batchNumber, batchStartIdx, batchEndIdx)

      for (const skill of batch) {
        stats.processed++
        skillsSinceCheckpoint++

        const result = await processSkill(skill, service, supabase, rateLimiter, options, config)

        // Update stats based on result
        switch (result.status) {
          case 'transformed':
            stats.transformed++
            break
          case 'skipped':
            stats.skipped++
            stats.skippedSkillIds.push(skill.id)
            break
          case 'failed':
            stats.failed++
            stats.failedSkillIds.push(skill.id)
            stats.errors.push(`${skill.id}: ${result.error}`)
            break
        }

        // Report progress via reporter
        progressReporter.update(skill, result, stats)

        // Save checkpoint at intervals
        if (skillsSinceCheckpoint >= options.checkpointInterval && !options.dryRun) {
          const checkpointData: BatchTransformCheckpoint = {
            lastProcessedOffset: startOffset + stats.processed,
            lastProcessedId: skill.id,
            processedCount: stats.processed,
            successCount: stats.transformed,
            errorCount: stats.failed,
            errors: stats.errors.slice(-100), // Keep last 100 errors
            timestamp: new Date().toISOString(),
            dbPath: 'supabase',
            failedSkillIds: stats.failedSkillIds.slice(-500),
            skippedSkillIds: stats.skippedSkillIds.slice(-500),
            runId,
          }
          saveBatchTransformCheckpoint(checkpointData)

          // Write audit log: progress
          await writeAuditLog(supabase, {
            event_type: 'batch-transform:progress',
            metadata: {
              run_id: runId,
              stats: {
                processed: stats.processed,
                transformed: stats.transformed,
                skipped: stats.skipped,
                failed: stats.failed,
              },
              checkpoint_offset: startOffset + stats.processed,
            },
          })

          skillsSinceCheckpoint = 0
          progressReporter.checkpoint(startOffset + stats.processed)
        }
      }

      progressReporter.batchEnd()
    }
  } catch (error) {
    // Save checkpoint on error
    if (!options.dryRun) {
      const checkpointData: BatchTransformCheckpoint = {
        lastProcessedOffset: startOffset + stats.processed,
        processedCount: stats.processed,
        successCount: stats.transformed,
        errorCount: stats.failed,
        errors: stats.errors.slice(-100),
        timestamp: new Date().toISOString(),
        dbPath: 'supabase',
        failedSkillIds: stats.failedSkillIds.slice(-500),
        skippedSkillIds: stats.skippedSkillIds.slice(-500),
        runId,
      }
      saveBatchTransformCheckpoint(checkpointData)
      console.log(`\n📍 Checkpoint saved after error at offset ${startOffset + stats.processed}`)
    }
    throw error
  }

  const duration = Date.now() - startTime

  // Write audit log: complete
  if (!options.dryRun) {
    await writeAuditLog(supabase, {
      event_type: 'batch-transform:complete',
      result: stats.failed === 0 ? 'success' : 'partial',
      metadata: {
        run_id: runId,
        stats: {
          processed: stats.processed,
          transformed: stats.transformed,
          skipped: stats.skipped,
          failed: stats.failed,
        },
        duration_ms: duration,
        failed_skill_ids: stats.failedSkillIds,
      },
    })

    // Clear checkpoint on successful completion
    if (stats.failed === 0) {
      clearBatchTransformCheckpoint()
    }
  }

  // SMI-2204: Finish progress reporter and get JSON output if applicable
  const jsonOutput = progressReporter.finish(stats, duration, runId)

  // SMI-2204: Output JSON if --json flag is set
  if (options.json) {
    const output: JsonOutput = jsonOutput ?? {
      processed: stats.processed,
      transformed: stats.transformed,
      skipped: stats.skipped,
      failed: stats.failed,
      duration_ms: duration,
      checkpoint: null,
      failed_skills: stats.failedSkillIds,
      skipped_skills: stats.skippedSkillIds.map((id) => ({ id, reason: 'Unknown' })),
    }

    // Add checkpoint info if exists
    const checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint) {
      output.checkpoint = {
        offset: checkpoint.lastProcessedOffset,
        timestamp: checkpoint.timestamp,
      }
    }

    // Output final JSON
    console.log(JSON.stringify({ type: 'summary', ...output }, null, 2))
    process.exit(stats.failed > 0 ? 1 : 0)
  }

  // Print human-readable summary (non-JSON mode)
  console.log('\n' + '='.repeat(60))
  console.log(options.dryRun ? 'DRY RUN SUMMARY' : 'TRANSFORMATION SUMMARY')
  console.log('='.repeat(60))
  console.log('')
  console.log('Results:')
  console.log('-'.repeat(50))
  console.log(`  Run ID:      ${runId.slice(0, 8)}...`)
  console.log(`  Duration:    ${(duration / 1000).toFixed(1)}s`)
  console.log(`  Processed:   ${stats.processed}`)
  console.log(`  Transformed: ${stats.transformed}`)
  console.log(`  Skipped:     ${stats.skipped}`)
  console.log(`  Failed:      ${stats.failed}`)
  console.log(`  Rate Limit:  ${rateLimiter.getRemaining()} remaining`)
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

// Only run main() when executed directly, not when imported as a module
// This allows the exports to be used in tests without triggering execution
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main().catch((error) => {
    console.error('\nFatal error:', error)
    process.exit(1)
  })
}
