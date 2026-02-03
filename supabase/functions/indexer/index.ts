/**
 * POST /v1/indexer - GitHub skill indexer
 * @module indexer
 *
 * SMI-1247: GitHub indexer Edge Function
 *
 * Indexes skill repositories from GitHub and updates the database.
 * Designed to run on a schedule via pg_cron or GitHub Actions.
 *
 * Request Body (optional):
 * - topics: Array of GitHub topics to search (default: claude-code related)
 * - maxPages: Max pages per topic (default: 5, max: 10, 7+ may timeout)
 * - maxRepos: Max repos to process per invocation (default: 50, prevents WORKER_LIMIT)
 * - dryRun: If true, don't write to database (default: false)
 * - strictValidation: Require valid YAML frontmatter in SKILL.md (default: true)
 * - minContentLength: Minimum SKILL.md content length (default: 100)
 *
 * SKILL.md Validation:
 * - Content must exist and not be empty
 * - Content must be >= minContentLength characters
 * - Must contain a markdown heading (# Title)
 * - If strictValidation is true, must have YAML frontmatter with:
 *   - name: string (required)
 *   - description: string >= 20 chars (required)
 *
 * Authentication:
 * - Supports GITHUB_TOKEN (PAT) or GitHub App authentication
 * - GitHub App requires: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
 *
 * Returns:
 * - Summary of indexed repositories
 */

import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'

import { createSupabaseAdminClient, getRequestId, logInvocation } from '../_shared/supabase.ts'

import {
  HIGH_TRUST_AUTHORS,
  shouldExcludeSkill,
  type HighTrustAuthor,
} from './high-trust-authors.ts'

import { buildGitHubHeaders } from '../_shared/github-auth.ts'
import { MAX_SKILL_CONTENT_SIZE } from '../_shared/constants.ts'
import {
  validateGitHubParams,
  isValidGitHubIdentifier,
  isValidGitHubTopic,
  isValidBranchName,
  sanitizeForLog,
  ValidationError,
} from '../_shared/validation.ts'

/**
 * SMI-2283: Read response body with byte-counted limit to prevent memory exhaustion.
 * Streams the body and aborts if the accumulated size exceeds the limit.
 * @throws Error if response body exceeds maxBytes
 */
async function readResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Response body is not readable')
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        reader.cancel()
        throw new Error(`Response body exceeds maximum size of ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const decoder = new TextDecoder()
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
}

// Re-export categorization logic for external use
export { CATEGORY_IDS, categorizeSkill } from './categorization.ts'
import { CATEGORY_IDS, categorizeSkill } from './categorization.ts'

/**
 * GitHub repository metadata
 */
interface GitHubRepository {
  owner: string
  name: string
  fullName: string
  description: string | null
  url: string
  stars: number
  forks: number
  topics: string[]
  updatedAt: string
  defaultBranch: string
  installable: boolean
}

/**
 * GitHub API response
 */
interface GitHubSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: Array<{
    id: number
    full_name: string
    name: string
    owner: { login: string }
    description: string | null
    html_url: string
    stargazers_count: number
    forks_count: number
    topics: string[]
    updated_at: string
    default_branch: string
  }>
}

/**
 * Indexer request body
 */
interface IndexerRequest {
  topics?: string[]
  maxPages?: number
  dryRun?: boolean
  /** Require valid YAML frontmatter (default: true) */
  strictValidation?: boolean
  /** Minimum SKILL.md content length (default: 100) */
  minContentLength?: number
  /** Maximum repos to process per invocation (default: 50, for batching) */
  maxRepos?: number
}

/**
 * SKILL.md validation result
 */
interface SkillMdValidation {
  valid: boolean
  errors: string[]
  metadata?: {
    name?: string
    description?: string
    author?: string
    triggers?: string[]
  }
}

/**
 * Indexer result
 */
interface IndexerResult {
  found: number
  indexed: number
  updated: number
  failed: number
  errors: string[]
  dryRun: boolean
}

const DEFAULT_TOPICS = ['claude-code-skill', 'claude-code', 'anthropic-claude', 'claude-skill']

const GITHUB_API_DELAY = 150 // ms between requests

/** Default minimum content length for SKILL.md */
const DEFAULT_MIN_CONTENT_LENGTH = 100

/**
 * Parse YAML frontmatter from markdown content
 * Returns null if no frontmatter is present
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatterMatch) {
    return null
  }

  const yamlContent = frontmatterMatch[1]
  const result: Record<string, unknown> = {}

  // Simple YAML parser for common fields
  const lines = yamlContent.split(/\r?\n/)
  let currentKey: string | null = null

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      continue
    }

    // Check for array items (triggers, tags, etc.)
    if (line.match(/^\s+-\s+/) && currentKey) {
      const value = line
        .replace(/^\s+-\s+/, '')
        .trim()
        .replace(/^["']|["']$/g, '')
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = []
      }
      ;(result[currentKey] as string[]).push(value)
      continue
    }

    // Check for key: value pairs
    const kvMatch = line.match(/^(\w+):\s*(.*)$/)
    if (kvMatch) {
      const [, key, rawValue] = kvMatch
      currentKey = key

      // Handle empty value (likely a list follows)
      if (!rawValue.trim()) {
        result[key] = []
        continue
      }

      // Handle inline arrays [value1, value2]
      const inlineArrayMatch = rawValue.match(/^\[(.*)\]$/)
      if (inlineArrayMatch) {
        result[key] = inlineArrayMatch[1]
          .split(',')
          .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        currentKey = null
        continue
      }

      // Handle quoted or unquoted string values
      const value = rawValue.trim().replace(/^["']|["']$/g, '')
      result[key] = value
      currentKey = null
    }
  }

  return result
}

/**
 * Validate SKILL.md content and extract metadata
 */
async function validateSkillMd(
  owner: string,
  repo: string,
  branch: string,
  skillPath?: string,
  options: { strictValidation?: boolean; minContentLength?: number } = {}
): Promise<SkillMdValidation> {
  const strictValidation = options.strictValidation ?? true
  const minContentLength = options.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH

  const errors: string[] = []
  let metadata: SkillMdValidation['metadata'] = undefined

  try {
    // SMI-2271: Validate parameters before URL construction
    validateGitHubParams(owner, repo, skillPath)

    // SMI-2280: Validate branch name before URL interpolation
    if (!isValidBranchName(branch)) {
      return {
        valid: false,
        errors: [`Invalid branch name: ${sanitizeForLog(branch)}`],
      }
    }

    // Build the URL - skillPath is relative to branch
    const path = skillPath ? `${branch}/${skillPath}/SKILL.md` : `${branch}/SKILL.md`
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${path}`

    const response = await fetch(url, {
      headers: await buildGitHubHeaders(),
    })

    if (!response.ok) {
      return {
        valid: false,
        errors: [`SKILL.md not found (HTTP ${response.status})`],
      }
    }

    // SMI-2273: Pre-check Content-Length header to reject oversized files early
    const contentLength = response.headers.get('content-length')
    const parsedContentLength = contentLength ? parseInt(contentLength, 10) : NaN
    if (!isNaN(parsedContentLength) && parsedContentLength > MAX_SKILL_CONTENT_SIZE) {
      return {
        valid: false,
        errors: [
          `SKILL.md too large (${parsedContentLength} bytes, max ${MAX_SKILL_CONTENT_SIZE})`,
        ],
      }
    }

    // SMI-2283: Stream body with byte-counted limit instead of buffering entirely via response.text()
    const content = await readResponseWithLimit(response, MAX_SKILL_CONTENT_SIZE)

    // Quality gate 1: Content exists (not empty)
    if (!content || content.trim().length === 0) {
      errors.push('SKILL.md is empty')
      return { valid: false, errors }
    }

    // Quality gate 2: Minimum length
    if (content.length < minContentLength) {
      errors.push(`SKILL.md too short (${content.length} chars, minimum ${minContentLength})`)
    }

    // Quality gate 3: Has markdown heading
    const hasHeading = /^#\s+.+/m.test(content)
    if (!hasHeading) {
      errors.push('SKILL.md must contain a markdown heading (# Title)')
    }

    // Quality gate 4: Frontmatter validation (if present or strict mode)
    const frontmatter = parseFrontmatter(content)

    if (frontmatter) {
      metadata = {}

      // Extract and validate name
      if (typeof frontmatter.name === 'string' && frontmatter.name.trim()) {
        metadata.name = frontmatter.name.trim()
      } else if (strictValidation) {
        errors.push('Frontmatter missing required "name" field')
      }

      // Extract and validate description
      if (typeof frontmatter.description === 'string') {
        const desc = frontmatter.description.trim()
        if (desc.length >= 20) {
          metadata.description = desc
        } else if (strictValidation) {
          errors.push(`Frontmatter "description" too short (${desc.length} chars, minimum 20)`)
        }
      } else if (strictValidation) {
        errors.push('Frontmatter missing required "description" field')
      }

      // Extract optional author
      if (typeof frontmatter.author === 'string' && frontmatter.author.trim()) {
        metadata.author = frontmatter.author.trim()
      }

      // Extract triggers (may be under 'triggers' or 'trigger_phrases')
      const triggersField = frontmatter.triggers || frontmatter.trigger_phrases
      if (Array.isArray(triggersField)) {
        metadata.triggers = triggersField.filter((t): t is string => typeof t === 'string')
      }
    } else if (strictValidation) {
      errors.push('SKILL.md missing YAML frontmatter')
    }

    return {
      valid: errors.length === 0,
      errors,
      metadata,
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        valid: false,
        errors: [`Validation failed: ${error.message}`],
      }
    }
    return {
      valid: false,
      errors: [`Failed to fetch SKILL.md: ${error instanceof Error ? error.message : 'Unknown'}`],
    }
  }
}

// Cache for validated SKILL.md results to avoid re-fetching
const validationCache = new Map<string, SkillMdValidation>()

/**
 * Check if repository has a valid SKILL.md file
 * Uses the new validation system and caches results
 */
async function checkSkillMdExists(
  owner: string,
  repo: string,
  branch: string,
  skillPath?: string,
  options: { strictValidation?: boolean; minContentLength?: number } = {}
): Promise<boolean> {
  // Build cache key
  const cacheKey = `${owner}/${repo}/${branch}${skillPath ? `/${skillPath}` : ''}`

  // Check cache first
  const cached = validationCache.get(cacheKey)
  if (cached !== undefined) {
    return cached.valid
  }

  // The branch parameter may include the path for backward compatibility
  // e.g., "main/skills/my-skill" - need to parse this
  let actualBranch = branch
  let actualSkillPath = skillPath

  // Check if branch contains a path (has / after the branch name)
  // This handles the old calling convention where path was appended to branch
  if (branch.includes('/') && !skillPath) {
    const parts = branch.split('/')
    actualBranch = parts[0]
    actualSkillPath = parts.slice(1).join('/')
  }

  const validation = await validateSkillMd(owner, repo, actualBranch, actualSkillPath, options)

  // Cache the result
  validationCache.set(cacheKey, validation)

  // Log validation errors for debugging
  if (!validation.valid && validation.errors.length > 0) {
    console.log(`SKILL.md validation failed for ${cacheKey}: ${validation.errors.join(', ')}`)
  }

  return validation.valid
}

/**
 * Get cached validation result for a skill
 */
function getCachedValidation(
  owner: string,
  repo: string,
  branch: string,
  skillPath?: string
): SkillMdValidation | undefined {
  const cacheKey = `${owner}/${repo}/${branch}${skillPath ? `/${skillPath}` : ''}`
  return validationCache.get(cacheKey)
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Search GitHub repositories by topic
 */
async function searchRepositories(
  topic: string,
  page: number,
  perPage = 30
): Promise<{ repos: GitHubRepository[]; total: number; error?: string }> {
  try {
    // SMI-2271: Validate topic before URL construction
    if (!isValidGitHubTopic(topic)) {
      return { repos: [], total: 0, error: `Invalid topic: ${sanitizeForLog(topic)}` }
    }

    const query = encodeURIComponent(`topic:${topic}`)
    const url = `https://api.github.com/search/repositories?q=${query}&per_page=${perPage}&page=${page}&sort=stars&order=desc`

    const response = await fetch(url, {
      headers: await buildGitHubHeaders(),
    })

    if (!response.ok) {
      if (response.status === 403) {
        const remaining = response.headers.get('X-RateLimit-Remaining')
        const reset = response.headers.get('X-RateLimit-Reset')
        return {
          repos: [],
          total: 0,
          error: `GitHub rate limit exceeded. Remaining: ${remaining}, Reset: ${reset}`,
        }
      }
      return {
        repos: [],
        total: 0,
        error: `GitHub API error: ${response.status}`,
      }
    }

    const data = (await response.json()) as GitHubSearchResponse

    // SMI-2271: Filter out repos with invalid identifiers before processing
    const repos: GitHubRepository[] = data.items
      .filter((item) => {
        try {
          validateGitHubParams(item.owner.login, item.name)
          return true
        } catch {
          console.log(`Skipping repo with invalid identifiers: ${sanitizeForLog(item.full_name)}`)
          return false
        }
      })
      .map((item) => ({
        owner: item.owner.login,
        name: item.name,
        fullName: item.full_name,
        description: item.description,
        url: item.html_url,
        stars: item.stargazers_count,
        forks: item.forks_count,
        topics: item.topics || [],
        updatedAt: item.updated_at,
        defaultBranch: item.default_branch,
        installable: false, // Will be checked separately
      }))

    return { repos, total: data.total_count }
  } catch (error) {
    return {
      repos: [],
      total: 0,
      error: `Network error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * Convert repository to skill data
 * Uses cached SKILL.md validation metadata if available
 */
function repositoryToSkill(
  repo: GitHubRepository,
  highTrustAuthor?: HighTrustAuthor,
  validationMetadata?: SkillMdValidation['metadata']
): Record<string, unknown> {
  let qualityScore: number
  let trustTier: 'verified' | 'community' | 'experimental' | 'unknown'

  if (highTrustAuthor) {
    // High-trust authors get verified tier and configured quality score
    qualityScore = highTrustAuthor.baseQualityScore
    trustTier = 'verified'
    console.log(
      `[QualityScore] HIGH-TRUST: ${repo.fullName} author=${highTrustAuthor.owner} → score=${qualityScore}`
    )
  } else {
    // Feature flag: SKILLSMITH_LOG_QUALITY_SCORE controls formula
    // Robust comparison: trim whitespace and lowercase
    const flagRaw = Deno.env.get('SKILLSMITH_LOG_QUALITY_SCORE')
    const useLogScale = flagRaw?.trim().toLowerCase() === 'true'
    console.log(`[QualityScore] Flag raw="${flagRaw}" parsed=${useLogScale}`)

    let starScore: number
    let forkScore: number

    if (useLogScale) {
      // Logarithmic scale for better distribution across wide star/fork ranges
      console.log(`[QualityScore] Using LOGARITHMIC formula for ${repo.fullName}`)
      starScore = Math.min(Math.log10(repo.stars + 1) * 15, 50)
      forkScore = Math.min(Math.log10(repo.forks + 1) * 10, 25)
    } else {
      // Linear scale (default) - saturates at 500 stars / 125 forks
      console.log(`[QualityScore] Using LINEAR formula for ${repo.fullName}`)
      starScore = Math.min(repo.stars / 10, 50)
      forkScore = Math.min(repo.forks / 5, 25)
    }
    qualityScore = (starScore + forkScore + 25) / 100 // Normalize to 0-1
    console.log(
      `[QualityScore] COMMUNITY: ${repo.fullName} stars=${repo.stars} forks=${repo.forks} → score=${qualityScore.toFixed(4)}`
    )

    // Determine trust tier
    trustTier = 'unknown'
    if (repo.topics.includes('claude-code-official')) {
      trustTier = 'verified'
    } else if (repo.stars >= 50) {
      trustTier = 'community'
    } else if (repo.stars >= 5) {
      trustTier = 'experimental'
    }
  }

  // Prefer frontmatter metadata over repository metadata
  const name = validationMetadata?.name || repo.name
  const description = validationMetadata?.description || repo.description

  // Merge tags from repository topics and frontmatter triggers
  let tags = [...repo.topics]
  if (validationMetadata?.triggers && validationMetadata.triggers.length > 0) {
    // Add triggers as tags, avoiding duplicates
    const triggerTags = validationMetadata.triggers.map((t) => t.toLowerCase().replace(/\s+/g, '-'))
    tags = [...new Set([...tags, ...triggerTags])]
  }

  return {
    name,
    description,
    author: validationMetadata?.author || repo.owner,
    repo_url: repo.url,
    quality_score: qualityScore,
    trust_tier: trustTier,
    tags,
    stars: repo.stars,
    installable: repo.installable,
    indexed_at: new Date().toISOString(),
  }
}

/**
 * Fetch skills from a high-trust author's repository
 * Scans subdirectories for SKILL.md files
 */
async function indexHighTrustRepository(
  author: HighTrustAuthor,
  validationOptions: { strictValidation?: boolean; minContentLength?: number } = {}
): Promise<{ skills: GitHubRepository[]; errors: string[] }> {
  const skills: GitHubRepository[] = []
  const errors: string[] = []

  try {
    // SMI-2271: Validate high-trust author parameters before URL construction
    try {
      validateGitHubParams(author.owner, author.repo)
    } catch (e) {
      errors.push(`Invalid high-trust author config: ${e instanceof Error ? e.message : 'Unknown'}`)
      return { skills, errors }
    }

    // Get repository info
    const repoUrl = `https://api.github.com/repos/${author.owner}/${author.repo}`
    const repoResponse = await fetch(repoUrl, {
      headers: await buildGitHubHeaders(),
    })

    if (!repoResponse.ok) {
      errors.push(`Failed to fetch ${author.owner}/${author.repo}: ${repoResponse.status}`)
      return { skills, errors }
    }

    const repoData = (await repoResponse.json()) as {
      default_branch: string
      stargazers_count: number
      forks_count: number
      description: string | null
      topics: string[]
    }


    // SMI-2280: Validate branch name before URL interpolation
    if (!isValidBranchName(repoData.default_branch)) {
      errors.push(
        `Invalid branch name for ${author.owner}/${author.repo}: ${sanitizeForLog(repoData.default_branch)}`
      )
      return { skills, errors }
    }
    // Get repository contents - check both root and skills/ subdirectory
    // Most high-trust repos have skills in a 'skills/' subdirectory
    const pathsToCheck = ['', 'skills']

    for (const basePath of pathsToCheck) {
      const contentsUrl = basePath
        ? `https://api.github.com/repos/${author.owner}/${author.repo}/contents/${basePath}`
        : `https://api.github.com/repos/${author.owner}/${author.repo}/contents`

      const contentsResponse = await fetch(contentsUrl, {
        headers: await buildGitHubHeaders(),
      })

      if (!contentsResponse.ok) {
        // skills/ subdirectory might not exist, that's OK
        if (basePath && contentsResponse.status === 404) {
          continue
        }
        errors.push(
          `Failed to fetch contents for ${author.owner}/${author.repo}/${basePath}: ${contentsResponse.status}`
        )
        continue
      }

      const contents = (await contentsResponse.json()) as Array<{
        name: string
        type: string
        path: string
      }>

      // Check each directory for SKILL.md
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

        // Check if this skill should be excluded
        if (shouldExcludeSkill(author, item.name)) {
          console.log(`Skipping excluded skill: ${author.owner}/${author.repo}/${item.name}`)
          continue
        }

        // Build the path to check for SKILL.md
        const skillPath = basePath ? `${basePath}/${item.name}` : item.name

        // Check if SKILL.md exists and is valid in this directory
        const hasSkill = await checkSkillMdExists(
          author.owner,
          author.repo,
          repoData.default_branch,
          skillPath,
          validationOptions
        )

        if (hasSkill) {
          // Get cached validation metadata for enhanced skill info
          const validation = getCachedValidation(
            author.owner,
            author.repo,
            repoData.default_branch,
            skillPath
          )
          const metadata = validation?.metadata

          skills.push({
            owner: author.owner,
            name: metadata?.name || item.name,
            fullName: `${author.owner}/${metadata?.name || item.name}`,
            description: metadata?.description || `${item.name} skill from ${author.owner}`,
            url: `https://github.com/${author.owner}/${author.repo}/tree/${repoData.default_branch}/${skillPath}`,
            stars: repoData.stargazers_count,
            forks: repoData.forks_count,
            topics: repoData.topics || [],
            updatedAt: new Date().toISOString(),
            defaultBranch: repoData.default_branch,
            installable: true,
          })
        }

        await delay(50) // Rate limiting
      }
    }

    // Also check for root-level SKILL.md (single-skill repos)
    const hasRootSkill = await checkSkillMdExists(
      author.owner,
      author.repo,
      repoData.default_branch,
      undefined,
      validationOptions
    )

    if (hasRootSkill && !shouldExcludeSkill(author, author.repo)) {
      // Get cached validation metadata for enhanced skill info
      const rootValidation = getCachedValidation(author.owner, author.repo, repoData.default_branch)
      const rootMetadata = rootValidation?.metadata

      skills.push({
        owner: author.owner,
        name: rootMetadata?.name || author.repo,
        fullName: `${author.owner}/${rootMetadata?.name || author.repo}`,
        description: rootMetadata?.description || repoData.description || `${author.repo} skill`,
        url: `https://github.com/${author.owner}/${author.repo}`,
        stars: repoData.stargazers_count,
        forks: repoData.forks_count,
        topics: repoData.topics || [],
        updatedAt: new Date().toISOString(),
        defaultBranch: repoData.default_branch,
        installable: true,
      })
    }
  } catch (error) {
    errors.push(
      `Error indexing ${author.owner}/${author.repo}: ${error instanceof Error ? error.message : 'Unknown'}`
    )
  }

  return { skills, errors }
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest()
  }

  // Only allow POST requests (or GET for manual trigger)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return errorResponse('Method not allowed', 405)
  }

  const requestId = getRequestId(req.headers)
  const origin = req.headers.get('origin')
  logInvocation('indexer', requestId)

  try {
    // Parse request body (optional)
    let body: IndexerRequest = {}
    if (req.method === 'POST') {
      try {
        body = await req.json()
      } catch {
        // Empty body is OK
      }
    }

    const topics = body.topics || DEFAULT_TOPICS
    // Default to 5 pages - optimal for Edge Function timeout (150s)
    // 7+ pages causes timeout, see SMI-1413 for test results
    const maxPages = Math.min(body.maxPages || 5, 10)
    const dryRun = body.dryRun ?? false
    const strictValidation = body.strictValidation ?? true
    const minContentLength = body.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH
    // Batch size limit to prevent WORKER_LIMIT errors (default: 50)
    const maxRepos = body.maxRepos ?? 50

    // Validation options to pass through
    const validationOptions = { strictValidation, minContentLength }

    // Clear validation cache at start of each run
    validationCache.clear()

    const result: IndexerResult = {
      found: 0,
      indexed: 0,
      updated: 0,
      failed: 0,
      errors: [],
      dryRun,
    }

    const seenUrls = new Set<string>()
    const repositories: GitHubRepository[] = []
    const highTrustSkillMap = new Map<string, HighTrustAuthor>() // Track which skills came from high-trust authors

    // Phase 1: Index high-trust authors first (verified tier)
    console.log(`Indexing ${HIGH_TRUST_AUTHORS.length} high-trust authors...`)
    for (const author of HIGH_TRUST_AUTHORS) {
      const { skills, errors: authorErrors } = await indexHighTrustRepository(
        author,
        validationOptions
      )

      for (const skill of skills) {
        if (!seenUrls.has(skill.url)) {
          seenUrls.add(skill.url)
          repositories.push(skill)
          highTrustSkillMap.set(skill.url, author)
        }
      }

      result.errors.push(...authorErrors)
      await delay(GITHUB_API_DELAY)
    }

    console.log(`Found ${highTrustSkillMap.size} skills from high-trust authors`)

    // Phase 2: Fetch repositories from GitHub topic search
    let reachedLimit = false
    for (const topic of topics) {
      if (reachedLimit) break

      for (let page = 1; page <= maxPages; page++) {
        if (repositories.length >= maxRepos) {
          console.log(`Reached maxRepos limit (${maxRepos}), stopping collection`)
          reachedLimit = true
          break
        }

        const { repos, total, error } = await searchRepositories(topic, page)

        if (error) {
          result.errors.push(`[${topic}] ${error}`)
          result.failed++
          break // Stop this topic on error
        }

        result.found = Math.max(result.found, total)

        for (const repo of repos) {
          if (repositories.length >= maxRepos) {
            reachedLimit = true
            break
          }
          if (!seenUrls.has(repo.url)) {
            seenUrls.add(repo.url)
            // Check if SKILL.md exists and is valid (determines installability)
            repo.installable = await checkSkillMdExists(
              repo.owner,
              repo.name,
              repo.defaultBranch,
              undefined,
              validationOptions
            )
            repositories.push(repo)
            await delay(50) // Small delay between SKILL.md checks
          }
        }

        // Break if we've fetched all results
        if (repos.length < 30) {
          break
        }

        await delay(GITHUB_API_DELAY)
      }
    }

    // Write to database if not dry run
    if (!dryRun && repositories.length > 0) {
      const supabase = createSupabaseAdminClient()

      // Track score distribution for summary logging
      const scoreDistribution = {
        highTrust: 0,
        community: 0,
        scores: [] as number[],
      }

      // Get existing skills to track inserts vs updates
      const repoUrls = repositories.map((r) => r.url)
      const { data: existingSkills } = await supabase
        .from('skills')
        .select('repo_url')
        .in('repo_url', repoUrls)
      const existingUrls = new Set(existingSkills?.map((s) => s.repo_url) || [])

      for (const repo of repositories) {
        try {
          // Check if this skill came from a high-trust author
          const highTrustAuthor = highTrustSkillMap.get(repo.url)

          // Get cached validation metadata for this skill
          const validation = getCachedValidation(repo.owner, repo.name, repo.defaultBranch)
          const skillData = repositoryToSkill(repo, highTrustAuthor, validation?.metadata)

          // Track score distribution
          if (highTrustAuthor) {
            scoreDistribution.highTrust++
          } else {
            scoreDistribution.community++
            scoreDistribution.scores.push(skillData.quality_score as number)
          }

          // Upsert skill by repo_url
          const { error } = await supabase.from('skills').upsert(skillData, {
            onConflict: 'repo_url',
            ignoreDuplicates: false,
          })

          if (error) {
            result.errors.push(`Failed to upsert ${repo.fullName}: ${error.message}`)
            result.failed++
          } else {
            // Track insert vs update
            if (existingUrls.has(repo.url)) {
              result.updated++
            } else {
              result.indexed++
            }
          }
        } catch (error) {
          result.errors.push(
            `Error processing ${repo.fullName}: ${error instanceof Error ? error.message : 'Unknown'}`
          )
          result.failed++
        }
      }

      // Log score distribution summary
      console.log(`[QualityScore] === SUMMARY ===`)
      console.log(
        `[QualityScore] High-trust skills (bypassed formula): ${scoreDistribution.highTrust}`
      )
      console.log(`[QualityScore] Community skills (used formula): ${scoreDistribution.community}`)
      if (scoreDistribution.scores.length > 0) {
        const minScore = Math.min(...scoreDistribution.scores)
        const maxScore = Math.max(...scoreDistribution.scores)
        const avgScore =
          scoreDistribution.scores.reduce((a, b) => a + b, 0) / scoreDistribution.scores.length
        console.log(
          `[QualityScore] Community score range: ${minScore.toFixed(4)} - ${maxScore.toFixed(4)} (avg: ${avgScore.toFixed(4)})`
        )
      }
      console.log(`[QualityScore] Inserts: ${result.indexed}, Updates: ${result.updated}`)

      // SMI-1659: Categorize newly indexed skills
      console.log(`[Categorization] Starting categorization for indexed skills...`)
      let categorizedCount = 0
      let categoryAssignments = 0

      // Get all skill IDs and their tags that were just processed
      const repoUrlsProcessed = repositories.map((r) => r.url)
      const { data: skillsToCheck } = await supabase
        .from('skills')
        .select('id, tags, description')
        .in('repo_url', repoUrlsProcessed)

      if (skillsToCheck && skillsToCheck.length > 0) {
        // Get skills that already have categories assigned
        const skillIds = skillsToCheck.map((s) => s.id)
        const { data: existingCategories } = await supabase
          .from('skill_categories')
          .select('skill_id')
          .in('skill_id', skillIds)

        const skillsWithCategories = new Set(existingCategories?.map((c) => c.skill_id) || [])

        // Categorize skills that don't have categories yet
        for (const skill of skillsToCheck) {
          if (skillsWithCategories.has(skill.id)) {
            continue // Skip skills that already have categories
          }

          const tags = Array.isArray(skill.tags) ? skill.tags : []
          const categories = categorizeSkill(tags as string[], skill.description)

          if (categories.length > 0) {
            // Insert category assignments
            const categoryRows = categories.map((categoryId) => ({
              skill_id: skill.id,
              category_id: categoryId,
            }))

            const { error: catError } = await supabase
              .from('skill_categories')
              .upsert(categoryRows, { onConflict: 'skill_id,category_id', ignoreDuplicates: true })

            if (catError) {
              console.log(
                `[Categorization] Error assigning categories for skill ${skill.id}: ${catError.message}`
              )
            } else {
              categorizedCount++
              categoryAssignments += categories.length
            }
          }
        }

        // Update category skill_count for all categories
        const { error: updateError } = await supabase.rpc('update_category_counts')
        if (updateError) {
          // Fallback: Update counts manually if RPC doesn't exist
          console.log(`[Categorization] RPC update_category_counts not found, updating manually...`)
          for (const categoryId of Object.values(CATEGORY_IDS)) {
            const { count } = await supabase
              .from('skill_categories')
              .select('*', { count: 'exact', head: true })
              .eq('category_id', categoryId)

            await supabase
              .from('categories')
              .update({ skill_count: count || 0 })
              .eq('id', categoryId)
          }
        }

        console.log(
          `[Categorization] Categorized ${categorizedCount} skills with ${categoryAssignments} total category assignments`
        )
      }

      // Log to audit_logs
      await supabase.from('audit_logs').insert({
        event_type: 'indexer:run',
        actor: 'system',
        action: 'index',
        result: result.failed === 0 ? 'success' : 'partial',
        metadata: {
          request_id: requestId,
          topics,
          found: result.found,
          indexed: result.indexed,
          updated: result.updated,
          failed: result.failed,
          dry_run: dryRun,
          score_distribution: {
            high_trust: scoreDistribution.highTrust,
            community: scoreDistribution.community,
          },
          categorization: {
            skills_categorized: categorizedCount,
            category_assignments: categoryAssignments,
          },
        },
      })
    } else if (dryRun) {
      result.indexed = repositories.length
    }

    const response = jsonResponse({
      data: {
        ...result,
        repositories_found: repositories.length,
      },
      meta: {
        topics,
        max_pages: maxPages,
        request_id: requestId,
        timestamp: new Date().toISOString(),
      },
    })

    // Add CORS headers
    const headers = new Headers(response.headers)
    Object.entries(buildCorsHeaders(origin)).forEach(([key, value]) => {
      headers.set(key, value)
    })
    headers.set('X-Request-ID', requestId)

    return new Response(response.body, {
      status: response.status,
      headers,
    })
  } catch (error) {
    console.error('Indexer error:', error)
    return errorResponse('Internal server error', 500, {
      request_id: requestId,
    })
  }
})
