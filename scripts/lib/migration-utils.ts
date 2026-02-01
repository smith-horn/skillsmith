/**
 * Shared utilities for migration scripts
 * SMI-1199: Extract shared utilities from migration scripts (DRY)
 *
 * Provides common functionality for:
 * - Environment validation
 * - Database discovery
 * - Path resolution
 * - Supabase client creation
 * - Checkpointing (SMI-1207)
 * - Rate limiting (SMI-1209)
 *
 * Wave C+D Additions:
 * - SMI-1201: Streaming support
 * - SMI-1207: Checkpoint management
 * - SMI-1209: Rate limit handling with exponential backoff
 * - SMI-1211: Validation sampling utilities
 */

import Database, { Database as DatabaseType } from 'better-sqlite3'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

// SMI-1205: Debug mode for verbose logging
export const DEBUG = process.env.DEBUG === 'true'

/**
 * SQLite skill record structure
 * SMI-1204: Proper type safety for database records
 */
export interface SQLiteSkill {
  id: string
  name: string
  description: string | null
  author: string | null
  repo_url: string | null
  quality_score: number | null
  trust_tier: string | null
  tags: string | null
  source: string | null
  stars: number | null
  created_at: string | null
  updated_at?: string | null
}

/**
 * Supabase skill record structure
 */
export interface SupabaseSkill {
  id: string
  name: string
  description: string | null
  author: string | null
  repo_url: string | null
  quality_score: number | null
  trust_tier: string
  tags: string[]
  source: string | null
  stars: number | null
  created_at: string
  updated_at: string
}

/**
 * Environment configuration
 * SMI-1197: Properly validated environment variables
 */
export interface EnvConfig {
  supabaseUrl: string
  supabaseServiceKey: string
}

/**
 * SMI-1208: Migration metrics for performance tracking
 */
export interface MigrationMetrics {
  startTime: number
  endTime?: number
  totalSkills: number
  processedSkills: number
  successCount: number
  errorCount: number
  batchTimes: number[]
  errors: string[]
  retryCount: number
}

/**
 * SMI-1207: Checkpoint for resumable migrations
 * SMI-1215: Added lastProcessedId for cursor-based pagination
 */
export interface MigrationCheckpoint {
  lastProcessedOffset: number
  lastProcessedId?: string // SMI-1215: Cursor for efficient pagination
  processedCount: number
  successCount: number
  errorCount: number
  errors: string[]
  timestamp: string
  dbPath: string
}

const CHECKPOINT_FILE = '.migration-checkpoint.json'

/**
 * SMI-1207: Load checkpoint from file
 */
export function loadCheckpoint(): MigrationCheckpoint | null {
  try {
    const checkpointPath = path.join(process.cwd(), CHECKPOINT_FILE)
    if (fs.existsSync(checkpointPath)) {
      const data = fs.readFileSync(checkpointPath, 'utf-8')
      const parsed = JSON.parse(data)
      if (
        !parsed.dbPath ||
        typeof parsed.successCount !== 'number' ||
        typeof parsed.errorCount !== 'number'
      ) {
        console.warn('Invalid checkpoint format, starting fresh')
        return null
      }
      const checkpoint = parsed as MigrationCheckpoint
      console.log(`\n📍 Found checkpoint: ${checkpoint.processedCount} skills processed`)
      console.log(`   Last offset: ${checkpoint.lastProcessedOffset}`)
      console.log(`   Timestamp: ${checkpoint.timestamp}`)
      return checkpoint
    }
  } catch (err) {
    if (DEBUG) {
      console.debug('No valid checkpoint found:', err)
    }
  }
  return null
}

/**
 * SMI-1207: Save checkpoint to file
 */
export function saveCheckpoint(checkpoint: MigrationCheckpoint): void {
  const checkpointPath = path.join(process.cwd(), CHECKPOINT_FILE)
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2))
  if (DEBUG) {
    console.debug(`Checkpoint saved: offset=${checkpoint.lastProcessedOffset}`)
  }
}

/**
 * SMI-1207: Clear checkpoint file
 */
export function clearCheckpoint(): void {
  const checkpointPath = path.join(process.cwd(), CHECKPOINT_FILE)
  if (fs.existsSync(checkpointPath)) {
    fs.unlinkSync(checkpointPath)
    console.log('Checkpoint cleared.')
  }
}

/**
 * Create empty metrics object
 */
export function createMetrics(totalSkills: number): MigrationMetrics {
  return {
    startTime: Date.now(),
    totalSkills,
    processedSkills: 0,
    successCount: 0,
    errorCount: 0,
    batchTimes: [],
    errors: [],
    retryCount: 0,
  }
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 0 || !isFinite(ms)) return '...'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m ${secs}s`
}

/**
 * Print migration metrics report
 * SMI-1208: Comprehensive timing and performance metrics
 */
export function printMetricsReport(metrics: MigrationMetrics, endTime = Date.now()): void {
  const duration = endTime - metrics.startTime
  const avgBatchTime =
    metrics.batchTimes.length > 0
      ? metrics.batchTimes.reduce((a, b) => a + b, 0) / metrics.batchTimes.length
      : 0
  const throughput = duration > 0 ? metrics.processedSkills / (duration / 1000) : 0

  console.log('\n' + '='.repeat(60))
  console.log('Performance Metrics')
  console.log('='.repeat(60))
  console.log(`Total time:       ${formatDuration(duration)}`)
  console.log(`Skills processed: ${metrics.processedSkills}`)
  console.log(`Throughput:       ${throughput.toFixed(1)} skills/sec`)
  console.log(`Avg batch time:   ${avgBatchTime.toFixed(0)}ms`)
  console.log(`Retries:          ${metrics.retryCount}`)
  if (throughput > 0) {
    console.log(`Est. 100k time:   ${formatDuration((100000 / throughput) * 1000)}`)
  }
}

// Default paths to skills database - check multiple locations
const DB_PATHS = [
  process.env.SKILLSMITH_DB_PATH,
  path.join(process.cwd(), 'data/phase-5-full-import/skills.db'),
  path.join(os.homedir(), '.skillsmith/skills.db'),
].filter(Boolean) as string[]

/**
 * SMI-1210: Improved tilde expansion for path resolution
 */
export function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2))
  }
  if (p.startsWith('~') && p.length > 1 && p[1] !== '/') {
    if (DEBUG) {
      console.debug(`  Warning: ~user paths not supported, use absolute path: ${p}`)
    }
  }
  return path.resolve(p)
}

/**
 * Find and validate SQLite database
 * SMI-1205: Added debug logging for database discovery
 */
export function findDatabase(dbPaths: string[] = DB_PATHS): string {
  if (DEBUG) {
    console.debug('Searching for database in paths:')
  }

  for (const dbPath of dbPaths) {
    try {
      const resolved = expandPath(dbPath)
      if (DEBUG) {
        console.debug(`  Trying: ${resolved}`)
      }

      const db = new Database(resolved, { readonly: true })
      const count = db.prepare('SELECT COUNT(*) as count FROM skills').get() as { count: number }
      db.close()

      console.log(`Found database at ${resolved} with ${count.count} skills`)
      return resolved
    } catch (err) {
      if (DEBUG) {
        const msg = err instanceof Error ? err.message : String(err)
        console.debug(`  Skipped ${dbPath}: ${msg}`)
      }
    }
  }

  throw new Error('No valid skills database found. Set SKILLSMITH_DB_PATH environment variable.')
}

/**
 * SMI-1197: Validate environment variables with proper error messages
 */
export function validateEnv(): EnvConfig {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    console.error('Run: source .env')
    process.exit(1)
  }

  return { supabaseUrl, supabaseServiceKey }
}

/**
 * Create configured Supabase client
 */
export function createSupabaseClient(config: EnvConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
  })
}

/**
 * SMI-1206: Validate and sanitize tags array content
 */
export function parseTags(tags: string | null): string[] {
  if (!tags) return []

  const MAX_TAG_LENGTH = 100
  const MAX_TAGS = 50

  try {
    const parsed = JSON.parse(tags)
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim().slice(0, MAX_TAG_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_TAGS)
  } catch {
    return tags
      .split(',')
      .map((t) => t.trim().slice(0, MAX_TAG_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_TAGS)
  }
}

/**
 * Transform SQLite skill to Supabase format
 */
export function transformSkill(skill: SQLiteSkill): SupabaseSkill {
  const now = new Date().toISOString()
  const repoUrl = skill.repo_url && skill.repo_url.trim() !== '' ? skill.repo_url : null

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    author: skill.author,
    repo_url: repoUrl,
    quality_score: skill.quality_score,
    trust_tier: skill.trust_tier || 'unknown',
    tags: parseTags(skill.tags),
    source: skill.source,
    stars: skill.stars,
    created_at: skill.created_at || now,
    updated_at: skill.updated_at || skill.created_at || now,
  }
}

/**
 * SMI-1209: Sleep utility for backoff
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * SMI-1209: Check if error is a rate limit error
 */
export function isRateLimitError(error: { message?: string; code?: string }): boolean {
  const msg = error.message?.toLowerCase() || ''
  return (
    error.code === '429' ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota exceeded')
  )
}

/**
 * SMI-1209: Process batch with exponential backoff retry
 */
export async function processBatchWithRetry(
  supabase: SupabaseClient,
  batch: SupabaseSkill[],
  maxRetries: number = 3,
  metrics: MigrationMetrics
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { error } = await supabase.from('skills').upsert(batch, {
        onConflict: 'id',
        ignoreDuplicates: false,
      })

      if (!error) {
        return { success: true }
      }

      if (isRateLimitError(error) && attempt < maxRetries) {
        const baseDelay = Math.pow(2, attempt) * 1000
        const delay = Math.floor(baseDelay * (0.5 + Math.random() * 0.5))
        console.log(
          `\n⏳ Rate limited, retrying in ${delay}ms (retry ${attempt + 1} of ${maxRetries})...`
        )
        metrics.retryCount++
        await sleep(delay)
        continue
      }

      return { success: false, error: error.message }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      if (attempt < maxRetries) {
        const baseDelay = Math.pow(2, attempt) * 1000
        const delay = Math.floor(baseDelay * (0.5 + Math.random() * 0.5))
        console.log(
          `\n⚠️ Error: ${msg}, retrying in ${delay}ms (retry ${attempt + 1} of ${maxRetries})...`
        )
        metrics.retryCount++
        await sleep(delay)
        continue
      }

      return { success: false, error: msg }
    }
  }

  return { success: false, error: 'Max retries exceeded' }
}

/**
 * SMI-1202: Simple concurrency limiter
 */
export class ConcurrencyLimiter {
  private running = 0
  private queue: (() => void)[] = []

  constructor(private maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }

    this.running++
    try {
      return await fn()
    } finally {
      this.running--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

/**
 * SMI-1211: Get random sample of skill IDs from SQLite
 */
export function getRandomSampleIds(sqlite: DatabaseType, sampleSize: number): string[] {
  const result = sqlite
    .prepare('SELECT id FROM skills ORDER BY RANDOM() LIMIT ?')
    .all(sampleSize) as { id: string }[]
  return result.map((r) => r.id)
}

/**
 * SMI-1211: Compare two skills for equality
 */
export function compareSkills(
  sqlite: SQLiteSkill,
  supabase: Record<string, unknown>
): { match: boolean; mismatches: string[] } {
  const mismatches: string[] = []

  if (sqlite.name !== supabase.name) mismatches.push('name')
  if (sqlite.author !== supabase.author) mismatches.push('author')
  if (sqlite.trust_tier !== supabase.trust_tier) mismatches.push('trust_tier')

  const sqliteScore = sqlite.quality_score || 0
  const supabaseScore = (supabase.quality_score as number) || 0
  if (Math.abs(sqliteScore - supabaseScore) >= 0.001) {
    mismatches.push('quality_score')
  }

  return { match: mismatches.length === 0, mismatches }
}

// =============================================================================
// SMI-2203: GitHub Rate Limiter
// =============================================================================

import { GITHUB_API_BASE_DELAY } from './constants'

/**
 * SMI-2203: Dynamic rate limiter for GitHub API
 * Adapts delay based on X-RateLimit-Remaining header
 */
export class GitHubRateLimiter {
  private remaining = 5000
  private resetTime = 0
  private baseDelay: number

  constructor(baseDelay: number = GITHUB_API_BASE_DELAY) {
    this.baseDelay = baseDelay
  }

  /**
   * Calculate delay based on remaining quota
   * - remaining < 100: delay = baseDelay * 10 (min 1500ms) - critical
   * - remaining < 500: delay = baseDelay * 3 - warning
   * - otherwise: delay = baseDelay - normal
   */
  private calculateDelay(): number {
    if (this.remaining < 100) {
      return Math.max(this.baseDelay * 10, 1500)
    }
    if (this.remaining < 500) {
      return this.baseDelay * 3
    }
    return this.baseDelay
  }

  /**
   * Update rate limit info from response headers
   */
  updateFromHeaders(headers: Headers): void {
    const remaining = headers.get('X-RateLimit-Remaining')
    const reset = headers.get('X-RateLimit-Reset')

    if (remaining !== null) {
      this.remaining = parseInt(remaining, 10)
    }
    if (reset !== null) {
      this.resetTime = parseInt(reset, 10) * 1000
    }

    if (DEBUG && this.remaining < 500) {
      console.debug(`Rate limit: ${this.remaining} remaining, resets at ${new Date(this.resetTime).toISOString()}`)
    }
  }

  /**
   * Get current remaining quota
   */
  getRemaining(): number {
    return this.remaining
  }

  /**
   * Get reset time (Unix timestamp in ms)
   */
  getResetTime(): number {
    return this.resetTime
  }

  /**
   * Execute a function with rate limiting
   * Applies delay before execution and updates from response headers
   */
  async withRateLimit(fn: () => Promise<Response>): Promise<Response> {
    const delay = this.calculateDelay()
    await sleep(delay)

    const response = await fn()
    this.updateFromHeaders(response.headers)

    return response
  }

  /**
   * Just apply the delay without making a request
   * Useful when you need to handle the response separately
   */
  async applyDelay(): Promise<number> {
    const delay = this.calculateDelay()
    await sleep(delay)
    return delay
  }
}
