/**
 * Trigger Indexer Utility Functions
 *
 * Pure functions extracted from trigger-indexer.ts for testability.
 * These functions are used by the main script and can be tested in isolation.
 */

// =============================================================================
// Configuration Constants
// =============================================================================

export const DEFAULT_TOPICS = ['claude-code-skill', 'claude-code']
export const DEFAULT_MAX_PAGES = 5
export const DEFAULT_MIN_LENGTH = 100
export const DEFAULT_TIMEOUT_MS = 120000 // 2 minutes

// =============================================================================
// Types
// =============================================================================

export interface CliOptions {
  dryRun: boolean
  topics: string[]
  maxPages: number
  strict: boolean
  minLength: number
  help: boolean
}

export interface IndexerRequest {
  dryRun?: boolean
  topics?: string[]
  maxPages?: number
  strictValidation?: boolean
  minContentLength?: number
}

export interface IndexedSkill {
  id: string
  name: string
  author: string
  repo_url?: string
  trust_tier?: string
  quality_score?: number
}

export interface IndexerResponse {
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

export interface EnvConfig {
  projectRef: string
  anonKey: string
}

export interface EnvValidationResult {
  valid: boolean
  config?: EnvConfig
  missingVars: string[]
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

/**
 * Parse command-line arguments into CliOptions
 * @param args - Array of command-line arguments (typically process.argv.slice(2))
 * @returns Parsed CLI options
 */
export function parseArgs(args: string[]): CliOptions {
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

/**
 * Validate environment variables without side effects
 * @param env - Environment variables object (typically process.env)
 * @returns Validation result with config if valid, or missing vars if invalid
 */
export function validateEnv(env: Record<string, string | undefined>): EnvValidationResult {
  const projectRef = env.SUPABASE_PROJECT_REF
  const anonKey = env.SUPABASE_ANON_KEY

  const missingVars: string[] = []
  if (!projectRef) missingVars.push('SUPABASE_PROJECT_REF')
  if (!anonKey) missingVars.push('SUPABASE_ANON_KEY')

  if (missingVars.length > 0) {
    return { valid: false, missingVars }
  }

  return {
    valid: true,
    config: { projectRef: projectRef!, anonKey: anonKey! },
    missingVars: [],
  }
}

// =============================================================================
// Response Normalization
// =============================================================================

/**
 * Normalize various response formats to the expected IndexerResponse structure
 * @param data - Raw response data from the Edge Function
 * @param dryRun - Whether this was a dry-run request
 * @returns Normalized IndexerResponse
 */
export function normalizeResponse(data: unknown, dryRun: boolean): IndexerResponse {
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
      ? innerData.errors.map((e: unknown) => String(e)).filter((e) => e.trim().length > 0)
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

/**
 * Format the summary section of the output
 * @param response - The IndexerResponse to format
 * @returns Formatted summary string
 */
export function formatSummary(response: IndexerResponse): string {
  const lines: string[] = []
  lines.push('Summary:')
  lines.push('-'.repeat(50))
  lines.push(`  Found:    ${response.summary.found}`)
  lines.push(`  Indexed:  ${response.summary.indexed}`)
  lines.push(`  Updated:  ${response.summary.updated}`)
  lines.push(`  Failed:   ${response.summary.failed}`)
  return lines.join('\n')
}

/**
 * Format the errors section of the output
 * @param errors - Array of error messages
 * @returns Formatted errors string, or empty string if no errors
 */
export function formatErrors(errors: string[] | undefined): string {
  if (!errors || errors.length === 0) {
    return ''
  }
  const lines: string[] = []
  lines.push('\nErrors:')
  lines.push('-'.repeat(50))
  errors.forEach((error, idx) => {
    lines.push(`  ${idx + 1}. ${error}`)
  })
  return lines.join('\n')
}

/**
 * Format the complete response output
 * @param response - The IndexerResponse to format
 * @returns Complete formatted output string
 */
export function formatResponse(response: IndexerResponse): string {
  const lines: string[] = []

  lines.push('='.repeat(60))
  lines.push(response.dryRun ? 'DRY RUN RESULTS' : 'INDEXER RESULTS')
  lines.push('='.repeat(60))

  lines.push('')
  lines.push(formatSummary(response))

  if (response.skills && response.skills.length > 0) {
    lines.push('\nIndexed Skills:')
    lines.push('-'.repeat(50))
    response.skills.forEach((skill, idx) => {
      const tier = skill.trust_tier || 'unknown'
      const score = skill.quality_score !== undefined ? skill.quality_score.toFixed(1) : 'N/A'
      lines.push(`  ${idx + 1}. ${skill.id}`)
      lines.push(`     Author: ${skill.author}`)
      lines.push(`     Trust:  ${tier} | Score: ${score}`)
      if (skill.repo_url) {
        lines.push(`     Repo:   ${skill.repo_url}`)
      }
      lines.push('')
    })
  }

  const errorsOutput = formatErrors(response.errors)
  if (errorsOutput) {
    lines.push(errorsOutput)
  }

  if (response.message) {
    lines.push(`\nMessage: ${response.message}`)
  }

  lines.push('')
  lines.push('='.repeat(60))
  const status = response.success ? 'SUCCESS' : 'COMPLETED WITH ERRORS'
  lines.push(`Status: ${status}`)
  lines.push('='.repeat(60))

  return lines.join('\n')
}

// =============================================================================
// Request Building
// =============================================================================

/**
 * Build the indexer request body from CLI options
 * @param options - Parsed CLI options
 * @returns IndexerRequest object
 */
export function buildRequest(options: CliOptions): IndexerRequest {
  return {
    dryRun: options.dryRun,
    topics: options.topics,
    maxPages: options.maxPages,
    strictValidation: options.strict,
    minContentLength: options.minLength,
  }
}

/**
 * Build the indexer URL from the project reference
 * @param projectRef - Supabase project reference
 * @returns Full Edge Function URL
 */
export function buildIndexerUrl(projectRef: string): string {
  return `https://${projectRef}.supabase.co/functions/v1/indexer`
}
