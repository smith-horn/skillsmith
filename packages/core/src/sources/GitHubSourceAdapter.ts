/**
 * GitHub Source Adapter (SMI-590)
 *
 * Implements the ISourceAdapter interface for GitHub repositories.
 * Provides search, repository metadata, and skill content fetching.
 */

import { BaseSourceAdapter } from './BaseSourceAdapter.js'
import { validateUrl } from '../validation/index.js'
import {
  decodeBase64Content,
  isRateLimitStatus,
  SKILL_FILE_PATHS as SHARED_SKILL_FILE_PATHS,
} from './shared.js'
import { ApiError } from '../errors/SkillsmithError.js'
import type {
  SourceConfig,
  SourceLocation,
  SourceRepository,
  SourceSearchOptions,
  SourceSearchResult,
  SkillContent,
  SourceHealth,
} from './types.js'

/**
 * GitHub API response for repository search
 */
interface GitHubSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: GitHubApiRepository[]
}

/**
 * GitHub API repository object
 */
interface GitHubApiRepository {
  id: number
  full_name: string
  name: string
  owner: {
    login: string
  }
  description: string | null
  html_url: string
  stargazers_count: number
  forks_count: number
  topics: string[]
  updated_at: string
  created_at: string
  default_branch: string
  license: {
    spdx_id: string
    name: string
  } | null
}

/**
 * GitHub API rate limit response
 */
interface GitHubRateLimitResponse {
  resources: {
    core: {
      limit: number
      remaining: number
      reset: number
    }
    search: {
      limit: number
      remaining: number
      reset: number
    }
  }
}

/**
 * GitHub API file content response
 */
interface GitHubFileResponse {
  name: string
  path: string
  sha: string
  content: string
  encoding: string
}

/**
 * Default topics to search for skill repositories
 */
const DEFAULT_TOPICS = ['claude-code-skill', 'claude-code', 'anthropic-claude', 'claude-skill']

/**
 * Default skill file paths to check (use shared paths, SMI-879)
 */
const SKILL_FILE_PATHS = SHARED_SKILL_FILE_PATHS

/**
 * GitHub Source Adapter
 *
 * Connects to GitHub API to search for and fetch skill repositories.
 *
 * @example
 * ```typescript
 * const adapter = new GitHubSourceAdapter({
 *   id: 'github',
 *   name: 'GitHub',
 *   type: 'github',
 *   baseUrl: 'https://api.github.com',
 *   enabled: true,
 *   auth: {
 *     type: 'token',
 *     credentials: process.env.GITHUB_TOKEN
 *   }
 * })
 *
 * await adapter.initialize()
 * const result = await adapter.search({ topics: ['claude-skill'] })
 * ```
 */
export class GitHubSourceAdapter extends BaseSourceAdapter {
  private readonly apiBaseUrl: string

  constructor(config: SourceConfig) {
    super(config)
    this.apiBaseUrl = config.baseUrl || 'https://api.github.com'
    validateUrl(this.apiBaseUrl)
  }

  /**
   * Check GitHub API health via rate limit endpoint
   */
  protected async doHealthCheck(): Promise<Partial<SourceHealth>> {
    const response = await this.fetchWithRateLimit(`${this.apiBaseUrl}/rate_limit`)

    if (!response.ok) {
      return {
        healthy: false,
        error: `GitHub API returned ${response.status}`,
      }
    }

    const data = (await response.json()) as GitHubRateLimitResponse
    const searchLimit = data.resources.search

    return {
      healthy: true,
      rateLimitRemaining: searchLimit.remaining,
      rateLimitReset: new Date(searchLimit.reset * 1000).toISOString(),
    }
  }

  /**
   * Search GitHub for skill repositories
   */
  async search(options: SourceSearchOptions = {}): Promise<SourceSearchResult> {
    await this.waitForRateLimit()

    const topics = options.topics ?? DEFAULT_TOPICS
    const limit = options.limit ?? 100
    const perPage = Math.min(limit, 100)

    // Build search query
    const topicQueries = topics.map((t) => `topic:${t}`).join(' ')
    const query = options.query ? `${options.query} ${topicQueries}` : topicQueries

    const searchQuery = encodeURIComponent(query)
    const url = `${this.apiBaseUrl}/search/repositories?q=${searchQuery}&per_page=${perPage}&sort=updated&order=desc`

    const response = await this.fetchWithRateLimit(url)

    if (!response.ok) {
      if (isRateLimitStatus(response.status)) {
        throw new ApiError('GitHub API rate limit exceeded', {
          statusCode: response.status,
          url,
        })
      }
      throw new ApiError(`GitHub API error: ${response.status}`, {
        statusCode: response.status,
        url,
      })
    }

    const data = (await response.json()) as GitHubSearchResponse
    const repositories: SourceRepository[] = data.items.map((item) => this.mapApiRepository(item))

    return {
      repositories,
      totalCount: data.total_count,
      hasMore: data.total_count > perPage,
      nextCursor: perPage < data.total_count ? String(perPage) : undefined,
    }
  }

  /**
   * Get repository metadata by location
   */
  async getRepository(location: SourceLocation): Promise<SourceRepository> {
    await this.waitForRateLimit()

    const url = `${this.apiBaseUrl}/repos/${location.owner}/${location.repo}`
    const response = await this.fetchWithRateLimit(url)

    if (!response.ok) {
      if (response.status === 404) {
        throw new ApiError(`Repository not found: ${location.owner}/${location.repo}`, {
          statusCode: 404,
          url,
        })
      }
      throw new ApiError(`GitHub API error: ${response.status}`, {
        statusCode: response.status,
        url,
      })
    }

    const data = (await response.json()) as GitHubApiRepository
    return this.mapApiRepository(data)
  }

  /**
   * Fetch skill content from repository
   */
  async fetchSkillContent(location: SourceLocation): Promise<SkillContent> {
    await this.waitForRateLimit()

    const branch = this.getDefaultBranch(location)
    const paths = location.path ? [location.path] : SKILL_FILE_PATHS

    // Try each possible skill file path
    for (const path of paths) {
      try {
        const url = `${this.apiBaseUrl}/repos/${location.owner}/${location.repo}/contents/${path}?ref=${branch}`
        const response = await this.fetchWithRateLimit(url)

        if (response.ok) {
          const data = (await response.json()) as GitHubFileResponse
          // SMI-879: Use shared decodeBase64Content utility
          const rawContent = decodeBase64Content(data.content, data.encoding)

          return {
            rawContent,
            sha: data.sha,
            location,
            filePath: data.path,
            encoding: 'utf-8',
          }
        }
      } catch {
        // Try next path
        continue
      }
    }

    throw new Error(
      `No skill file found in ${location.owner}/${location.repo}. Searched: ${paths.join(', ')}`
    )
  }

  /**
   * Check if skill file exists
   */
  async skillExists(location: SourceLocation): Promise<boolean> {
    const paths = location.path ? [location.path] : SKILL_FILE_PATHS
    const branch = this.getDefaultBranch(location)

    for (const path of paths) {
      try {
        await this.waitForRateLimit()
        const url = `${this.apiBaseUrl}/repos/${location.owner}/${location.repo}/contents/${path}?ref=${branch}`
        const response = await this.fetchWithRateLimit(url)

        if (response.ok) {
          return true
        }
      } catch {
        continue
      }
    }

    return false
  }

  /**
   * Get skill file SHA for change detection
   */
  async getSkillSha(location: SourceLocation): Promise<string | null> {
    const paths = location.path ? [location.path] : SKILL_FILE_PATHS
    const branch = this.getDefaultBranch(location)

    for (const path of paths) {
      try {
        await this.waitForRateLimit()
        const url = `${this.apiBaseUrl}/repos/${location.owner}/${location.repo}/contents/${path}?ref=${branch}`
        const response = await this.fetchWithRateLimit(url)

        if (response.ok) {
          const data = (await response.json()) as GitHubFileResponse
          return data.sha
        }
      } catch {
        continue
      }
    }

    return null
  }

  /**
   * Paginated search with cursor
   */
  async searchWithCursor(options: SourceSearchOptions, page: number): Promise<SourceSearchResult> {
    await this.waitForRateLimit()

    const topics = options.topics ?? DEFAULT_TOPICS
    const perPage = Math.min(options.limit ?? 30, 100)

    // Build search query
    const topicQueries = topics.map((t) => `topic:${t}`).join(' ')
    const query = options.query ? `${options.query} ${topicQueries}` : topicQueries

    const searchQuery = encodeURIComponent(query)
    const url = `${this.apiBaseUrl}/search/repositories?q=${searchQuery}&per_page=${perPage}&page=${page}&sort=updated&order=desc`

    const response = await this.fetchWithRateLimit(url)

    if (!response.ok) {
      if (isRateLimitStatus(response.status)) {
        throw new ApiError('GitHub API rate limit exceeded', {
          statusCode: response.status,
          url,
        })
      }
      throw new ApiError(`GitHub API error: ${response.status}`, {
        statusCode: response.status,
        url,
      })
    }

    const data = (await response.json()) as GitHubSearchResponse
    const repositories: SourceRepository[] = data.items.map((item) => this.mapApiRepository(item))

    const totalPages = Math.ceil(data.total_count / perPage)
    const hasMore = page < totalPages

    return {
      repositories,
      totalCount: data.total_count,
      hasMore,
      nextCursor: hasMore ? String(page + 1) : undefined,
    }
  }

  /**
   * Map GitHub API repository to SourceRepository
   */
  private mapApiRepository(item: GitHubApiRepository): SourceRepository {
    return {
      id: String(item.id),
      name: item.name,
      url: item.html_url,
      description: item.description,
      owner: item.owner.login,
      defaultBranch: item.default_branch,
      stars: item.stargazers_count,
      forks: item.forks_count,
      topics: item.topics || [],
      updatedAt: item.updated_at,
      createdAt: item.created_at,
      license: item.license?.spdx_id ?? null,
      metadata: {
        fullName: item.full_name,
      },
    }
  }

  // SMI-879: decodeContent removed - using shared decodeBase64Content utility
}

/**
 * Configuration for createGitHubAdapter factory
 */
export interface GitHubAdapterConfig {
  /** Unique identifier for this source instance */
  id: string
  /** Human-readable name */
  name: string
  /** Whether this source is enabled */
  enabled: boolean
  /** Base URL for API requests (default: https://api.github.com) */
  baseUrl?: string
  /** Rate limiting configuration */
  rateLimit?: {
    maxRequests: number
    windowMs: number
    minDelayMs: number
  }
  /** Authentication configuration */
  auth?: {
    type: 'token' | 'basic' | 'oauth' | 'none'
    credentials?: string
  }
  /** Additional source-specific options */
  options?: Record<string, unknown>
}

/**
 * Factory function for creating GitHub adapters
 */
export function createGitHubAdapter(config: GitHubAdapterConfig): GitHubSourceAdapter {
  return new GitHubSourceAdapter({
    ...config,
    type: 'github',
    baseUrl: config.baseUrl ?? 'https://api.github.com',
  })
}
