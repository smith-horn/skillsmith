/**
 * SMI-628: GitHubIndexer - Discover and index skills from GitHub repositories
 *
 * Provides:
 * - Repository skill discovery via GitHub API
 * - Rate-aware fetching with exponential backoff
 * - Incremental updates based on last_indexed_at
 * - Batch processing for efficient indexing
 */

import { randomUUID } from 'crypto'
import { SkillParser, type ParsedSkillMetadata } from './SkillParser.js'
import type { SkillCreateInput, TrustTier } from '../types/skill.js'

/**
 * Configuration options for GitHubIndexer
 */
export interface GitHubIndexerOptions {
  /**
   * GitHub personal access token for API authentication
   * If not provided, uses unauthenticated requests (60 req/hour limit)
   */
  token?: string

  /**
   * Minimum delay between API requests in milliseconds
   * Default: 150ms to stay well under rate limits
   */
  rateLimit?: number

  /**
   * Number of files to process per batch
   * Default: 10
   */
  batchSize?: number

  /**
   * Maximum retry attempts for failed requests
   * Default: 3
   */
  maxRetries?: number

  /**
   * Base delay for exponential backoff in milliseconds
   * Default: 1000ms
   */
  backoffBase?: number

  /**
   * Maximum backoff delay in milliseconds
   * Default: 30000ms (30 seconds)
   */
  maxBackoff?: number

  /**
   * Custom skill file patterns to search for
   * Default: ['SKILL.md', 'skill.md', '.skill.md']
   */
  skillFilePatterns?: string[]
}

/**
 * Metadata for a discovered skill
 */
export interface SkillMetadata extends ParsedSkillMetadata {
  /**
   * Full GitHub repository URL
   */
  repoUrl: string

  /**
   * Path to the SKILL.md file within the repository
   */
  filePath: string

  /**
   * SHA of the file for change detection
   */
  sha: string

  /**
   * Repository owner
   */
  owner: string

  /**
   * Repository name
   */
  repo: string

  /**
   * Discovery timestamp
   */
  discoveredAt: string
}

/**
 * Result of indexing a single repository
 */
export interface IndexResult {
  /**
   * Repository identifier (owner/repo)
   */
  repository: string

  /**
   * Number of skills discovered
   */
  skillsFound: number

  /**
   * Number of skills successfully indexed
   */
  skillsIndexed: number

  /**
   * Skills that were discovered
   */
  skills: SkillMetadata[]

  /**
   * Any errors that occurred
   */
  errors: string[]

  /**
   * Indexing duration in milliseconds
   */
  durationMs: number

  /**
   * Number of API requests made
   */
  apiRequests: number
}

/**
 * GitHub API response for file search
 */
interface GitHubSearchItem {
  name: string
  path: string
  sha: string
  url: string
  html_url: string
  repository: {
    full_name: string
    owner: {
      login: string
    }
    name: string
    html_url: string
  }
}

/**
 * GitHub API response for file content
 */
interface GitHubContentResponse {
  name: string
  path: string
  sha: string
  content: string
  encoding: string
  html_url: string
}

/**
 * Rate limit information from GitHub API headers
 */
interface RateLimitInfo {
  limit: number
  remaining: number
  reset: number
  used: number
}

/**
 * GitHubIndexer - Discovers and indexes skills from GitHub repositories
 */
export class GitHubIndexer {
  private options: Required<GitHubIndexerOptions>
  private parser: SkillParser
  private rateLimitInfo: RateLimitInfo | null = null
  private lastRequestTime = 0
  private requestCount = 0

  constructor(options: GitHubIndexerOptions = {}) {
    this.options = {
      token: options.token ?? process.env.GITHUB_TOKEN ?? '',
      rateLimit: options.rateLimit ?? 150,
      batchSize: options.batchSize ?? 10,
      maxRetries: options.maxRetries ?? 3,
      backoffBase: options.backoffBase ?? 1000,
      maxBackoff: options.maxBackoff ?? 30000,
      skillFilePatterns: options.skillFilePatterns ?? ['SKILL.md', 'skill.md', '.skill.md'],
    }

    this.parser = new SkillParser()
  }

  /**
   * Discover skills in a repository by searching for SKILL.md files
   */
  async discoverSkills(owner: string, repo: string): Promise<SkillMetadata[]> {
    const skills: SkillMetadata[] = []

    // Search for skill files in the repository
    for (const pattern of this.options.skillFilePatterns) {
      try {
        const files = await this.searchFiles(owner, repo, pattern)

        for (const file of files) {
          try {
            const content = await this.fetchFileContent(owner, repo, file.path)
            const parsed = this.parser.parse(content)

            if (parsed) {
              skills.push({
                ...parsed,
                repoUrl: `https://github.com/${owner}/${repo}`,
                filePath: file.path,
                sha: file.sha,
                owner,
                repo,
                discoveredAt: new Date().toISOString(),
              })
            }
          } catch (error) {
            // Log but continue with other files
            console.error(`Failed to parse skill file ${file.path}:`, error)
          }
        }
      } catch (error) {
        // Log but continue with other patterns
        console.error(`Failed to search for ${pattern} in ${owner}/${repo}:`, error)
      }
    }

    return skills
  }

  /**
   * Index a single repository and return results
   */
  async indexRepository(owner: string, repo: string): Promise<IndexResult> {
    const startTime = Date.now()
    const initialRequestCount = this.requestCount
    const errors: string[] = []

    let skills: SkillMetadata[] = []

    try {
      skills = await this.discoverSkills(owner, repo)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }

    return {
      repository: `${owner}/${repo}`,
      skillsFound: skills.length,
      skillsIndexed: skills.length, // All discovered skills are "indexed" in this context
      skills,
      errors,
      durationMs: Date.now() - startTime,
      apiRequests: this.requestCount - initialRequestCount,
    }
  }

  /**
   * Index multiple repositories
   */
  async indexAll(repositories: string[]): Promise<IndexResult[]> {
    const results: IndexResult[] = []

    for (const repoSpec of repositories) {
      const [owner, repo] = repoSpec.split('/')
      if (!owner || !repo) {
        results.push({
          repository: repoSpec,
          skillsFound: 0,
          skillsIndexed: 0,
          skills: [],
          errors: [`Invalid repository format: ${repoSpec}. Expected 'owner/repo'`],
          durationMs: 0,
          apiRequests: 0,
        })
        continue
      }

      const result = await this.indexRepository(owner, repo)
      results.push(result)
    }

    return results
  }

  /**
   * Search for skills across GitHub using code search
   * Note: Requires authentication for code search API
   */
  async searchGitHub(query: string, maxResults = 100): Promise<SkillMetadata[]> {
    const skills: SkillMetadata[] = []
    const perPage = Math.min(maxResults, 100)
    let page = 1

    while (skills.length < maxResults) {
      const searchQuery = `${query} filename:SKILL.md`
      const response = await this.request<{
        total_count: number
        items: GitHubSearchItem[]
      }>(
        `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${perPage}&page=${page}`
      )

      if (!response.items || response.items.length === 0) {
        break
      }

      for (const item of response.items) {
        if (skills.length >= maxResults) break

        try {
          const content = await this.fetchFileContent(
            item.repository.owner.login,
            item.repository.name,
            item.path
          )

          const parsed = this.parser.parse(content)
          if (parsed) {
            skills.push({
              ...parsed,
              repoUrl: item.repository.html_url,
              filePath: item.path,
              sha: item.sha,
              owner: item.repository.owner.login,
              repo: item.repository.name,
              discoveredAt: new Date().toISOString(),
            })
          }
        } catch {
          // Skip files that can't be parsed
        }
      }

      if (response.items.length < perPage) {
        break
      }

      page++
    }

    return skills
  }

  /**
   * Convert discovered skills to database-ready format
   */
  toSkillCreateInputs(skills: SkillMetadata[]): SkillCreateInput[] {
    return skills.map((skill) => ({
      id: randomUUID(),
      name: skill.name,
      description: skill.description,
      author: skill.author ?? skill.owner,
      repoUrl: skill.repoUrl,
      qualityScore: this.calculateQualityScore(skill),
      trustTier: this.parser.inferTrustTier(skill),
      tags: skill.tags,
    }))
  }

  /**
   * Get current rate limit information
   */
  getRateLimitInfo(): RateLimitInfo | null {
    return this.rateLimitInfo
  }

  /**
   * Get total request count
   */
  getRequestCount(): number {
    return this.requestCount
  }

  /**
   * Reset request counter
   */
  resetRequestCount(): void {
    this.requestCount = 0
  }

  // Private methods

  /**
   * Search for files in a repository
   */
  private async searchFiles(
    owner: string,
    repo: string,
    filename: string
  ): Promise<Array<{ path: string; sha: string }>> {
    // Use the repository tree API to find files
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`

    try {
      const response = await this.request<{
        tree: Array<{
          path: string
          sha: string
          type: string
        }>
      }>(treeUrl)

      return response.tree
        .filter((item) => item.type === 'blob' && item.path.endsWith(filename))
        .map((item) => ({
          path: item.path,
          sha: item.sha,
        }))
    } catch (error) {
      // Fallback: try to get the file directly from common locations
      const commonPaths = [
        filename,
        `.claude/${filename}`,
        `.claude/skills/${filename}`,
        `skills/${filename}`,
      ]

      const results: Array<{ path: string; sha: string }> = []

      for (const path of commonPaths) {
        try {
          const content = await this.request<GitHubContentResponse>(
            `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
          )
          results.push({ path: content.path, sha: content.sha })
        } catch {
          // File doesn't exist at this path
        }
      }

      return results
    }
  }

  /**
   * Fetch file content from a repository
   */
  private async fetchFileContent(owner: string, repo: string, path: string): Promise<string> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
    const response = await this.request<GitHubContentResponse>(url)

    if (response.encoding === 'base64') {
      return Buffer.from(response.content, 'base64').toString('utf-8')
    }

    return response.content
  }

  /**
   * Make a rate-limited API request with retry logic
   */
  private async request<T>(url: string): Promise<T> {
    await this.waitForRateLimit()

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: this.getHeaders(),
        })

        // Update rate limit info from headers
        this.updateRateLimitInfo(response.headers)
        this.requestCount++

        if (response.status === 403 || response.status === 429) {
          // Rate limited - wait and retry
          const retryAfter = this.getRetryDelay(response.headers, attempt)
          await this.delay(retryAfter)
          continue
        }

        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
        }

        return (await response.json()) as T
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        if (attempt < this.options.maxRetries) {
          const backoff = this.calculateBackoff(attempt)
          await this.delay(backoff)
        }
      }
    }

    throw lastError ?? new Error('Request failed after retries')
  }

  /**
   * Wait for rate limit if necessary
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime

    if (timeSinceLastRequest < this.options.rateLimit) {
      await this.delay(this.options.rateLimit - timeSinceLastRequest)
    }

    // Check if we're near the rate limit
    if (this.rateLimitInfo && this.rateLimitInfo.remaining < 10) {
      const resetTime = this.rateLimitInfo.reset * 1000
      const waitTime = resetTime - Date.now()

      if (waitTime > 0) {
        console.log(
          `Rate limit nearly exhausted. Waiting ${Math.ceil(waitTime / 1000)}s for reset...`
        )
        await this.delay(waitTime)
      }
    }

    this.lastRequestTime = Date.now()
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoff(attempt: number): number {
    const delay = this.options.backoffBase * Math.pow(2, attempt)
    return Math.min(delay, this.options.maxBackoff)
  }

  /**
   * Get retry delay from response headers or calculate
   */
  private getRetryDelay(headers: Headers, attempt: number): number {
    const retryAfter = headers.get('retry-after')

    if (retryAfter) {
      // Could be seconds or a date
      const seconds = parseInt(retryAfter, 10)
      if (!isNaN(seconds)) {
        return seconds * 1000
      }
    }

    // Fall back to exponential backoff
    return this.calculateBackoff(attempt)
  }

  /**
   * Update rate limit info from response headers
   */
  private updateRateLimitInfo(headers: Headers): void {
    const limit = headers.get('x-ratelimit-limit')
    const remaining = headers.get('x-ratelimit-remaining')
    const reset = headers.get('x-ratelimit-reset')
    const used = headers.get('x-ratelimit-used')

    if (limit && remaining && reset) {
      this.rateLimitInfo = {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
        used: used ? parseInt(used, 10) : 0,
      }
    }
  }

  /**
   * Get request headers
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'skillsmith-indexer/1.0',
    }

    if (this.options.token) {
      headers['Authorization'] = `Bearer ${this.options.token}`
    }

    return headers
  }

  /**
   * Calculate quality score for a skill
   */
  private calculateQualityScore(skill: SkillMetadata): number {
    let score = 0
    const maxScore = 100

    // Has description (20 points)
    if (skill.description && skill.description.length > 0) {
      score += 10
      if (skill.description.length > 100) {
        score += 10
      }
    }

    // Has tags (15 points)
    if (skill.tags.length > 0) {
      score += 5
      if (skill.tags.length >= 3) {
        score += 5
      }
      if (skill.tags.length >= 5) {
        score += 5
      }
    }

    // Has version (10 points)
    if (skill.version) {
      score += 10
    }

    // Has author (10 points)
    if (skill.author) {
      score += 10
    }

    // Has license (10 points)
    if (skill.license) {
      score += 10
    }

    // Has dependencies documented (10 points)
    if (skill.dependencies.length > 0) {
      score += 10
    }

    // Has category (10 points)
    if (skill.category) {
      score += 10
    }

    // Has substantial documentation (15 points)
    if (skill.rawContent.length > 500) {
      score += 10
      if (skill.rawContent.length > 1000) {
        score += 5
      }
    }

    return Math.min(score, maxScore) / 100 // Normalize to 0-1
  }

  /**
   * Helper to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export default GitHubIndexer
