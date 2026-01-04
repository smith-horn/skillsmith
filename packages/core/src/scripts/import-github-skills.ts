/**
 * GitHub API Import Script for Large-Scale Skill Collection (SMI-860)
 *
 * Searches GitHub for Claude-related skills using multiple query strategies:
 * - topic:claude-skill
 * - topic:mcp-server
 * - filename:SKILL.md
 * - topic:anthropic-skills
 *
 * Features:
 * - Exponential backoff retry for rate limit handling
 * - Resume support via checkpoint file
 * - Progress logging
 * - Output to JSON with metadata
 *
 * Usage:
 *   GITHUB_TOKEN=xxx npx tsx packages/core/src/scripts/import-github-skills.ts
 *
 * Options:
 *   --resume     Resume from last checkpoint
 *   --output     Custom output path (default: data/imported-skills.json)
 */

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

// ============================================================================
// Configuration
// ============================================================================

interface Config {
  /** GitHub personal access token */
  GITHUB_TOKEN: string | undefined
  /** GitHub API base URL */
  GITHUB_API_URL: string
  /** Results per page for GitHub API */
  PER_PAGE: number
  /** Maximum results from GitHub search API per query */
  MAX_RESULTS_PER_QUERY: number
  /** Rate limit delay between API calls (ms) */
  RATE_LIMIT_DELAY: number
  /** Delay between different query types (ms) */
  QUERY_DELAY: number
  /** Retry configuration */
  RETRY: {
    MAX_ATTEMPTS: number
    BASE_DELAY_MS: number
    BACKOFF_MULTIPLIER: number
  }
  /** Output file path */
  OUTPUT_PATH: string
  /** Checkpoint file path */
  CHECKPOINT_PATH: string
}

const CONFIG: Config = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_API_URL: 'https://api.github.com',
  PER_PAGE: 100,
  MAX_RESULTS_PER_QUERY: 1000,
  RATE_LIMIT_DELAY: 150,
  QUERY_DELAY: 500,
  RETRY: {
    MAX_ATTEMPTS: 5,
    BASE_DELAY_MS: 1000,
    BACKOFF_MULTIPLIER: 2,
  },
  OUTPUT_PATH: process.env.OUTPUT_PATH || './data/imported-skills.json',
  CHECKPOINT_PATH: process.env.CHECKPOINT_PATH || './data/import-checkpoint.json',
}

// ============================================================================
// Type Definitions
// ============================================================================

/** GitHub repository owner structure */
interface GitHubOwner {
  login: string
  type: string
}

/** GitHub repository from search API */
interface GitHubRepository {
  id: number
  owner: GitHubOwner
  name: string
  full_name: string
  description: string | null
  html_url: string
  clone_url: string
  stargazers_count: number
  forks_count: number
  topics?: string[]
  language: string | null
  license: {
    key: string
    name: string
    spdx_id: string
  } | null
  created_at: string
  updated_at: string
  pushed_at: string
  default_branch: string
}

/** GitHub search API response */
interface GitHubSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: GitHubRepository[]
}

/** Imported skill metadata */
interface ImportedSkill {
  id: string
  name: string
  description: string
  author: string
  repo_url: string
  clone_url: string
  stars: number
  forks: number
  topics: string[]
  language: string | null
  license: string | null
  created_at: string
  updated_at: string
  source: string
  query_type: string
  imported_at: string
}

/** Import statistics */
interface ImportStats {
  total_found: number
  total_imported: number
  duplicates_removed: number
  queries_completed: string[]
  errors: string[]
  started_at: string
  completed_at?: string
  duration_ms?: number
}

/** Checkpoint state for resume */
interface Checkpoint {
  last_query: string
  last_page: number
  skills: ImportedSkill[]
  stats: ImportStats
  timestamp: string
}

/** Search query definition */
interface SearchQuery {
  name: string
  query: string
  description: string
}

// ============================================================================
// Search Queries
// ============================================================================

const SEARCH_QUERIES: SearchQuery[] = [
  {
    name: 'claude-skill',
    query: 'topic:claude-skill',
    description: 'Repositories tagged with claude-skill topic',
  },
  {
    name: 'mcp-server',
    query: 'topic:mcp-server',
    description: 'MCP server implementations',
  },
  {
    name: 'skill-md',
    query: 'filename:SKILL.md',
    description: 'Repositories containing SKILL.md files',
  },
  {
    name: 'anthropic-skills',
    query: 'topic:anthropic-skills',
    description: 'Repositories tagged with anthropic-skills topic',
  },
]

// ============================================================================
// Utility Functions
// ============================================================================

/** Sleep for a given number of milliseconds */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Log with timestamp */
function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const timestamp = new Date().toISOString()
  const prefix = { info: '[INFO]', warn: '[WARN]', error: '[ERROR]' }[level]
  console.log(`${timestamp} ${prefix} ${message}`)
}

/** Progress bar helper */
function progressBar(current: number, total: number, width = 30): string {
  const percent = Math.round((current / total) * 100)
  const filled = Math.round((current / total) * width)
  const empty = width - filled
  return `[${'='.repeat(filled)}${' '.repeat(empty)}] ${percent}% (${current}/${total})`
}

/** Type guard for GitHub search response */
function isGitHubSearchResponse(data: unknown): data is GitHubSearchResponse {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  return (
    typeof obj.total_count === 'number' &&
    typeof obj.incomplete_results === 'boolean' &&
    Array.isArray(obj.items)
  )
}

// ============================================================================
// Fetch with Retry (Exponential Backoff)
// ============================================================================

/**
 * Fetches a URL with exponential backoff retry logic.
 * Handles rate limiting (429) and server errors (5xx).
 *
 * @param url - The URL to fetch
 * @param options - Fetch options including headers
 * @returns The fetch Response
 * @throws Error after max retries exceeded
 */
async function fetchWithRetry(url: string, options: RequestInit = {}): Promise<Response> {
  const { MAX_ATTEMPTS, BASE_DELAY_MS, BACKOFF_MULTIPLIER } = CONFIG.RETRY
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, options)

      // Check for rate limit headers
      const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining')
      const rateLimitReset = response.headers.get('X-RateLimit-Reset')

      if (rateLimitRemaining === '0' && rateLimitReset) {
        const resetTime = parseInt(rateLimitReset, 10) * 1000
        const waitTime = Math.max(0, resetTime - Date.now()) + 1000
        log(`Rate limit exhausted. Waiting ${Math.round(waitTime / 1000)}s until reset...`, 'warn')
        await sleep(waitTime)
        continue
      }

      // Don't retry on 4xx client errors (except 429 rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response
      }

      // Retry on 429 (rate limit) or 5xx server errors
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          const retryAfter = response.headers.get('Retry-After')
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1)
          log(`Retry ${attempt}/${MAX_ATTEMPTS} after ${delay}ms (HTTP ${response.status})`, 'warn')
          await sleep(delay)
          continue
        }
      }

      return response
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1)
        log(`Retry ${attempt}/${MAX_ATTEMPTS} after ${delay}ms (${lastError.message})`, 'warn')
        await sleep(delay)
      }
    }
  }

  throw lastError || new Error('Max retries exceeded')
}

// ============================================================================
// GitHub API Functions
// ============================================================================

/** Get GitHub API headers */
function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Skillsmith-Import/1.0',
  }
  if (CONFIG.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${CONFIG.GITHUB_TOKEN}`
  }
  return headers
}

/** Check and display GitHub rate limit status */
async function checkRateLimit(): Promise<void> {
  try {
    const response = await fetch(`${CONFIG.GITHUB_API_URL}/rate_limit`, {
      headers: getGitHubHeaders(),
    })

    if (!response.ok) {
      log(`Could not check rate limit: ${response.status}`, 'warn')
      return
    }

    const data = (await response.json()) as {
      resources?: { search?: { remaining: number; limit: number; reset: number } }
      rate?: { remaining: number; limit: number; reset: number }
    }
    const search = data.resources?.search
    const core = data.rate

    log(`GitHub Rate Limits:`)
    log(
      `  Core API: ${core?.remaining}/${core?.limit} (resets: ${new Date((core?.reset ?? 0) * 1000).toISOString()})`
    )
    log(
      `  Search API: ${search?.remaining}/${search?.limit} (resets: ${new Date((search?.reset ?? 0) * 1000).toISOString()})`
    )
  } catch (error) {
    log(`Error checking rate limit: ${error}`, 'warn')
  }
}

/**
 * Fetches repositories from GitHub search API for a given query.
 * Handles pagination automatically up to GitHub's 1000 result limit.
 *
 * @param searchQuery - The search query configuration
 * @param startPage - Starting page for resume support
 * @param onProgress - Progress callback
 * @returns Array of imported skill metadata
 */
async function fetchGitHubSearch(
  searchQuery: SearchQuery,
  startPage = 1,
  onProgress?: (current: number, total: number) => void
): Promise<ImportedSkill[]> {
  const skills: ImportedSkill[] = []
  let page = startPage
  let totalCount = 0
  const importedAt = new Date().toISOString()

  log(`Searching: ${searchQuery.description}`)
  log(`Query: ${searchQuery.query}`)

  while (true) {
    const url =
      `${CONFIG.GITHUB_API_URL}/search/repositories` +
      `?q=${encodeURIComponent(searchQuery.query)}` +
      `&per_page=${CONFIG.PER_PAGE}` +
      `&page=${page}` +
      `&sort=updated` +
      `&order=desc`

    try {
      const response = await fetchWithRetry(url, { headers: getGitHubHeaders() })

      if (response.status === 403) {
        const resetHeader = response.headers.get('X-RateLimit-Reset')
        const resetTime = resetHeader ? new Date(parseInt(resetHeader) * 1000) : 'unknown'
        log(`Rate limited. Reset at: ${resetTime}`, 'error')
        break
      }

      if (response.status === 422) {
        // Validation failed - often means query is too broad
        log(`Query validation failed (HTTP 422) - query may be too broad`, 'warn')
        break
      }

      if (!response.ok) {
        log(`Error: ${response.status} ${response.statusText}`, 'error')
        break
      }

      const rawData: unknown = await response.json()

      if (!isGitHubSearchResponse(rawData)) {
        log(`Invalid response format on page ${page}`, 'error')
        break
      }

      const data = rawData

      if (page === 1) {
        totalCount = Math.min(data.total_count, CONFIG.MAX_RESULTS_PER_QUERY)
        log(`Found ${data.total_count} repositories (fetching up to ${totalCount})`)
      }

      if (data.items.length === 0) {
        break
      }

      for (const repo of data.items) {
        skills.push({
          id: `github/${repo.owner.login}/${repo.name}`,
          name: repo.name,
          description: repo.description || '',
          author: repo.owner.login,
          repo_url: repo.html_url,
          clone_url: repo.clone_url,
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          topics: repo.topics || [],
          language: repo.language,
          license: repo.license?.spdx_id || null,
          created_at: repo.created_at,
          updated_at: repo.updated_at,
          source: 'github',
          query_type: searchQuery.name,
          imported_at: importedAt,
        })
      }

      const progress = progressBar(Math.min(page * CONFIG.PER_PAGE, totalCount), totalCount)
      log(`Page ${page}: ${data.items.length} repos ${progress}`)

      onProgress?.(skills.length, totalCount)

      // Check if we've reached the limit or end of results
      if (
        page * CONFIG.PER_PAGE >= CONFIG.MAX_RESULTS_PER_QUERY ||
        data.items.length < CONFIG.PER_PAGE
      ) {
        break
      }

      page++
      await sleep(CONFIG.RATE_LIMIT_DELAY)
    } catch (error) {
      log(`Fetch error on page ${page}: ${error}`, 'error')
      break
    }
  }

  log(`Completed: ${skills.length} repositories from ${searchQuery.name}`)
  return skills
}

// ============================================================================
// Deduplication
// ============================================================================

/**
 * Deduplicates skills by repository URL, keeping the most recently updated version.
 *
 * @param skills - Array of skills that may contain duplicates
 * @returns Object containing unique skills and duplicate count
 */
function deduplicateSkills(skills: ImportedSkill[]): {
  unique: ImportedSkill[]
  duplicateCount: number
} {
  const seen = new Map<string, ImportedSkill>()

  for (const skill of skills) {
    // Normalize key by repo URL
    const key = createHash('md5').update(skill.repo_url.toLowerCase()).digest('hex')

    const existing = seen.get(key)
    if (existing) {
      // Keep the more recently updated version
      if (new Date(skill.updated_at) > new Date(existing.updated_at)) {
        seen.set(key, skill)
      }
    } else {
      seen.set(key, skill)
    }
  }

  const unique = Array.from(seen.values())
  return {
    unique,
    duplicateCount: skills.length - unique.length,
  }
}

// ============================================================================
// Checkpoint Management
// ============================================================================

/**
 * Saves checkpoint for resume support.
 *
 * @param checkpoint - Checkpoint data to save
 */
function saveCheckpoint(checkpoint: Checkpoint): void {
  const dir = path.dirname(CONFIG.CHECKPOINT_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(CONFIG.CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2))
  log(`Checkpoint saved: ${checkpoint.skills.length} skills, last query: ${checkpoint.last_query}`)
}

/**
 * Loads checkpoint if exists.
 *
 * @returns Checkpoint data or null if not found
 */
function loadCheckpoint(): Checkpoint | null {
  if (!fs.existsSync(CONFIG.CHECKPOINT_PATH)) {
    return null
  }

  try {
    const data = fs.readFileSync(CONFIG.CHECKPOINT_PATH, 'utf-8')
    const checkpoint = JSON.parse(data) as Checkpoint
    log(`Loaded checkpoint from ${checkpoint.timestamp}`)
    log(`  Skills: ${checkpoint.skills.length}`)
    log(`  Last query: ${checkpoint.last_query}`)
    return checkpoint
  } catch (error) {
    log(`Error loading checkpoint: ${error}`, 'warn')
    return null
  }
}

/**
 * Clears checkpoint file.
 */
function clearCheckpoint(): void {
  if (fs.existsSync(CONFIG.CHECKPOINT_PATH)) {
    fs.unlinkSync(CONFIG.CHECKPOINT_PATH)
    log('Checkpoint cleared')
  }
}

// ============================================================================
// Output
// ============================================================================

/**
 * Saves imported skills to JSON file with metadata.
 *
 * @param skills - Array of skills to save
 * @param stats - Import statistics
 */
function saveOutput(skills: ImportedSkill[], stats: ImportStats): void {
  const dir = path.dirname(CONFIG.OUTPUT_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const output = {
    metadata: {
      version: '1.0.0',
      generated_at: new Date().toISOString(),
      source: 'github',
      queries: SEARCH_QUERIES.map((q) => q.name),
    },
    stats,
    skills,
  }

  fs.writeFileSync(CONFIG.OUTPUT_PATH, JSON.stringify(output, null, 2))
  log(`Output saved to: ${CONFIG.OUTPUT_PATH}`)
  log(`  Total skills: ${skills.length}`)
  log(`  File size: ${(fs.statSync(CONFIG.OUTPUT_PATH).size / 1024).toFixed(2)} KB`)
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Main import function.
 * Orchestrates the import process with support for resume.
 */
async function main(): Promise<void> {
  const startTime = Date.now()
  const shouldResume = process.argv.includes('--resume')

  console.log('======================================================================')
  console.log('       GitHub Skills Import (SMI-860)')
  console.log('======================================================================')
  console.log()

  // Check for token
  if (CONFIG.GITHUB_TOKEN) {
    log('GITHUB_TOKEN detected')
    await checkRateLimit()
  } else {
    log('No GITHUB_TOKEN - limited to 60 requests/hour', 'warn')
    log('Set GITHUB_TOKEN environment variable for higher limits', 'warn')
  }
  console.log()

  // Initialize or load checkpoint
  let allSkills: ImportedSkill[] = []
  let stats: ImportStats = {
    total_found: 0,
    total_imported: 0,
    duplicates_removed: 0,
    queries_completed: [],
    errors: [],
    started_at: new Date().toISOString(),
  }
  let startQueryIndex = 0
  let startPage = 1

  if (shouldResume) {
    const checkpoint = loadCheckpoint()
    if (checkpoint) {
      allSkills = checkpoint.skills
      stats = checkpoint.stats

      // Find the query to resume from
      const lastQueryIndex = SEARCH_QUERIES.findIndex((q) => q.name === checkpoint.last_query)
      if (lastQueryIndex >= 0) {
        startQueryIndex = lastQueryIndex
        startPage = checkpoint.last_page + 1
        log(`Resuming from query: ${checkpoint.last_query}, page: ${startPage}`)
      }
    } else {
      log('No checkpoint found, starting fresh')
    }
  }
  console.log()

  // Graceful shutdown handler
  let isShuttingDown = false
  process.on('SIGINT', () => {
    if (isShuttingDown) {
      log('Force quitting...', 'warn')
      process.exit(1)
    }

    isShuttingDown = true
    log('\nGraceful shutdown initiated (Ctrl+C again to force)...')

    // Save checkpoint
    const checkpoint: Checkpoint = {
      last_query:
        stats.queries_completed[stats.queries_completed.length - 1] || SEARCH_QUERIES[0].name,
      last_page: 1,
      skills: allSkills,
      stats,
      timestamp: new Date().toISOString(),
    }
    saveCheckpoint(checkpoint)

    log('Checkpoint saved. Run with --resume to continue.')
    process.exit(0)
  })

  // Execute search queries
  log('Starting import...')
  console.log()

  for (let i = startQueryIndex; i < SEARCH_QUERIES.length; i++) {
    const query = SEARCH_QUERIES[i]
    const page = i === startQueryIndex ? startPage : 1

    console.log('----------------------------------------------------------------------')
    log(`Query ${i + 1}/${SEARCH_QUERIES.length}: ${query.name}`)
    console.log('----------------------------------------------------------------------')

    try {
      const skills = await fetchGitHubSearch(query, page)
      allSkills.push(...skills)
      stats.total_found += skills.length
      stats.queries_completed.push(query.name)

      // Save checkpoint after each query
      const checkpoint: Checkpoint = {
        last_query: query.name,
        last_page: Math.ceil(skills.length / CONFIG.PER_PAGE),
        skills: allSkills,
        stats,
        timestamp: new Date().toISOString(),
      }
      saveCheckpoint(checkpoint)
    } catch (error) {
      const errorMsg = `Query ${query.name} failed: ${error}`
      log(errorMsg, 'error')
      stats.errors.push(errorMsg)
    }

    // Delay between queries
    if (i < SEARCH_QUERIES.length - 1) {
      log(`Waiting ${CONFIG.QUERY_DELAY}ms before next query...`)
      await sleep(CONFIG.QUERY_DELAY)
    }

    console.log()
  }

  // Deduplicate results
  console.log('======================================================================')
  log('Deduplicating results...')
  const { unique, duplicateCount } = deduplicateSkills(allSkills)
  stats.duplicates_removed = duplicateCount
  stats.total_imported = unique.length
  log(`Removed ${duplicateCount} duplicates`)
  log(`Final count: ${unique.length} unique skills`)
  console.log()

  // Complete stats
  stats.completed_at = new Date().toISOString()
  stats.duration_ms = Date.now() - startTime

  // Save output
  log('Saving output...')
  saveOutput(unique, stats)

  // Clear checkpoint on successful completion
  clearCheckpoint()

  // Print summary
  console.log()
  console.log('======================================================================')
  console.log('                         IMPORT SUMMARY')
  console.log('======================================================================')
  console.log(`  Total Found:        ${stats.total_found}`)
  console.log(`  Duplicates Removed: ${stats.duplicates_removed}`)
  console.log(`  Total Imported:     ${stats.total_imported}`)
  console.log(`  Duration:           ${(stats.duration_ms! / 1000).toFixed(2)}s`)
  console.log(`  Queries Completed:  ${stats.queries_completed.join(', ')}`)
  console.log(`  Output File:        ${CONFIG.OUTPUT_PATH}`)

  if (stats.errors.length > 0) {
    console.log()
    console.log('Errors encountered:')
    for (const error of stats.errors) {
      console.log(`  - ${error}`)
    }
  }

  console.log('======================================================================')

  // Validate expected output
  if (unique.length >= 500) {
    log(`SUCCESS: Imported ${unique.length} skills (target: 500+)`)
  } else {
    log(`WARNING: Only ${unique.length} skills imported (target: 500+)`, 'warn')
    log('Consider running without rate limits using a GITHUB_TOKEN', 'warn')
  }
}

// Run the import
main().catch((error) => {
  log(`Fatal error: ${error}`, 'error')
  process.exit(1)
})
