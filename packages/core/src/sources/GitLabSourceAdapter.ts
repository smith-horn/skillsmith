/**
 * GitLab Source Adapter (SMI-591)
 *
 * Implements the ISourceAdapter interface for GitLab repositories.
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
import { createLogger } from '../utils/logger.js'

const log = createLogger('GitLabAdapter')

/**
 * GitLab API project response
 */
interface GitLabProject {
  id: number
  path_with_namespace: string
  name: string
  namespace: {
    path: string
    name: string
  }
  description: string | null
  web_url: string
  star_count: number
  forks_count: number
  topics: string[]
  last_activity_at: string
  created_at: string
  default_branch: string
  license?: {
    key: string
    name: string
  }
}

/**
 * GitLab API file response
 */
interface GitLabFileResponse {
  file_name: string
  file_path: string
  content: string
  encoding: string
  content_sha256: string
  last_commit_id: string
}

/**
 * Default topics to search for skill repositories
 */
const DEFAULT_TOPICS = ['claude-code-skill', 'claude-code', 'claude-skill']

/**
 * Default skill file paths to check (use shared paths, SMI-879)
 */
const SKILL_FILE_PATHS = SHARED_SKILL_FILE_PATHS

/**
 * GitLab Source Adapter
 *
 * Connects to GitLab API to search for and fetch skill repositories.
 *
 * @example
 * ```typescript
 * const adapter = new GitLabSourceAdapter({
 *   id: 'gitlab',
 *   name: 'GitLab',
 *   type: 'gitlab',
 *   baseUrl: 'https://gitlab.com/api/v4',
 *   enabled: true,
 *   auth: {
 *     type: 'token',
 *     credentials: process.env.GITLAB_TOKEN
 *   }
 * })
 *
 * await adapter.initialize()
 * const result = await adapter.search({ topics: ['claude-skill'] })
 * ```
 */
export class GitLabSourceAdapter extends BaseSourceAdapter {
  private readonly apiBaseUrl: string

  constructor(config: SourceConfig) {
    super(config)
    this.apiBaseUrl = config.baseUrl || 'https://gitlab.com/api/v4'
    validateUrl(this.apiBaseUrl)
  }

  /**
   * Validate API access on initialization
   */
  protected override async doInitialize(): Promise<void> {
    // Validate API access on initialization
    const health = await this.doHealthCheck()
    if (!health.healthy) {
      log.warn(`API health check warning: ${health.error ?? 'unknown issue'}`)
    }
  }

  /**
   * Check GitLab API health
   */
  protected async doHealthCheck(): Promise<Partial<SourceHealth>> {
    const response = await this.fetchWithRateLimit(`${this.apiBaseUrl}/version`)

    if (!response.ok) {
      return {
        healthy: false,
        error: `GitLab API returned ${response.status}`,
      }
    }

    // Check rate limit headers
    const rateLimitRemaining = response.headers.get('ratelimit-remaining')
    const rateLimitReset = response.headers.get('ratelimit-reset')

    return {
      healthy: true,
      rateLimitRemaining: rateLimitRemaining ? parseInt(rateLimitRemaining, 10) : undefined,
      rateLimitReset: rateLimitReset
        ? new Date(parseInt(rateLimitReset, 10) * 1000).toISOString()
        : undefined,
    }
  }

  /**
   * Search GitLab for skill repositories
   */
  async search(options: SourceSearchOptions = {}): Promise<SourceSearchResult> {
    await this.waitForRateLimit()

    const topics = options.topics ?? DEFAULT_TOPICS
    const limit = options.limit ?? 100
    const perPage = Math.min(limit, 100)

    // Build search URL - GitLab uses separate topic parameter
    const params = new URLSearchParams({
      per_page: String(perPage),
      order_by: 'last_activity_at',
      sort: 'desc',
      topics: topics.join(','),
    })

    if (options.query) {
      params.set('search', options.query)
    }

    const url = `${this.apiBaseUrl}/projects?${params}`
    const response = await this.fetchWithRateLimit(url)

    if (!response.ok) {
      if (isRateLimitStatus(response.status)) {
        throw new ApiError('GitLab API rate limit exceeded', {
          statusCode: response.status,
          url,
        })
      }
      throw new ApiError(`GitLab API error: ${response.status}`, {
        statusCode: response.status,
        url,
      })
    }

    const data = (await response.json()) as GitLabProject[]
    const repositories: SourceRepository[] = data.map((item) => this.mapApiProject(item))

    // Check pagination headers
    const totalHeader = response.headers.get('x-total')
    const totalCount = totalHeader ? parseInt(totalHeader, 10) : data.length

    return {
      repositories,
      totalCount,
      hasMore: totalCount > perPage,
      nextCursor: perPage < totalCount ? '2' : undefined,
    }
  }

  /**
   * Get repository metadata by location
   */
  async getRepository(location: SourceLocation): Promise<SourceRepository> {
    await this.waitForRateLimit()

    const projectPath = encodeURIComponent(`${location.owner}/${location.repo}`)
    const url = `${this.apiBaseUrl}/projects/${projectPath}`
    const response = await this.fetchWithRateLimit(url)

    if (!response.ok) {
      if (response.status === 404) {
        throw new ApiError(`Repository not found: ${location.owner}/${location.repo}`, {
          statusCode: 404,
          url,
        })
      }
      throw new ApiError(`GitLab API error: ${response.status}`, {
        statusCode: response.status,
        url,
      })
    }

    const data = (await response.json()) as GitLabProject
    return this.mapApiProject(data)
  }

  /**
   * Fetch skill content from repository
   */
  async fetchSkillContent(location: SourceLocation): Promise<SkillContent> {
    await this.waitForRateLimit()

    const branch = this.getDefaultBranch(location)
    const paths = location.path ? [location.path] : SKILL_FILE_PATHS
    const projectPath = encodeURIComponent(`${location.owner}/${location.repo}`)

    // Try each possible skill file path
    for (const path of paths) {
      try {
        const filePath = encodeURIComponent(path)
        const url = `${this.apiBaseUrl}/projects/${projectPath}/repository/files/${filePath}?ref=${branch}`
        const response = await this.fetchWithRateLimit(url)

        if (response.ok) {
          const data = (await response.json()) as GitLabFileResponse
          // SMI-879: Use shared decodeBase64Content utility
          const rawContent = decodeBase64Content(data.content, data.encoding)

          return {
            rawContent,
            sha: data.content_sha256,
            location,
            filePath: data.file_path,
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
  override async skillExists(location: SourceLocation): Promise<boolean> {
    const paths = location.path ? [location.path] : SKILL_FILE_PATHS
    const branch = this.getDefaultBranch(location)
    const projectPath = encodeURIComponent(`${location.owner}/${location.repo}`)

    for (const path of paths) {
      try {
        await this.waitForRateLimit()
        const filePath = encodeURIComponent(path)
        const url = `${this.apiBaseUrl}/projects/${projectPath}/repository/files/${filePath}?ref=${branch}`
        const response = await this.fetchWithRateLimit(url, { method: 'HEAD' })

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
  override async getSkillSha(location: SourceLocation): Promise<string | null> {
    const paths = location.path ? [location.path] : SKILL_FILE_PATHS
    const branch = this.getDefaultBranch(location)
    const projectPath = encodeURIComponent(`${location.owner}/${location.repo}`)

    for (const path of paths) {
      try {
        await this.waitForRateLimit()
        const filePath = encodeURIComponent(path)
        const url = `${this.apiBaseUrl}/projects/${projectPath}/repository/files/${filePath}?ref=${branch}`
        const response = await this.fetchWithRateLimit(url)

        if (response.ok) {
          const data = (await response.json()) as GitLabFileResponse
          return data.content_sha256
        }
      } catch {
        continue
      }
    }

    return null
  }

  /**
   * Paginated search with page number
   */
  async searchWithCursor(options: SourceSearchOptions, page: number): Promise<SourceSearchResult> {
    await this.waitForRateLimit()

    const topics = options.topics ?? DEFAULT_TOPICS
    const perPage = Math.min(options.limit ?? 30, 100)

    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      order_by: 'last_activity_at',
      sort: 'desc',
      topics: topics.join(','),
    })

    if (options.query) {
      params.set('search', options.query)
    }

    const url = `${this.apiBaseUrl}/projects?${params}`
    const response = await this.fetchWithRateLimit(url)

    if (!response.ok) {
      if (isRateLimitStatus(response.status)) {
        throw new ApiError('GitLab API rate limit exceeded', {
          statusCode: response.status,
          url,
        })
      }
      throw new ApiError(`GitLab API error: ${response.status}`, {
        statusCode: response.status,
        url,
      })
    }

    const data = (await response.json()) as GitLabProject[]
    const repositories: SourceRepository[] = data.map((item) => this.mapApiProject(item))

    const totalHeader = response.headers.get('x-total')
    const totalPagesHeader = response.headers.get('x-total-pages')
    const totalCount = totalHeader ? parseInt(totalHeader, 10) : data.length
    const totalPages = totalPagesHeader ? parseInt(totalPagesHeader, 10) : 1

    const hasMore = page < totalPages

    return {
      repositories,
      totalCount,
      hasMore,
      nextCursor: hasMore ? String(page + 1) : undefined,
    }
  }

  /**
   * Map GitLab API project to SourceRepository
   */
  private mapApiProject(item: GitLabProject): SourceRepository {
    return {
      id: String(item.id),
      name: item.name,
      url: item.web_url,
      description: item.description,
      owner: item.namespace.path,
      defaultBranch: item.default_branch,
      stars: item.star_count,
      forks: item.forks_count,
      topics: item.topics || [],
      updatedAt: item.last_activity_at,
      createdAt: item.created_at,
      license: item.license?.key ?? null,
      metadata: {
        fullPath: item.path_with_namespace,
        namespace: item.namespace.name,
      },
    }
  }

  // SMI-879: decodeContent removed - using shared decodeBase64Content utility
}

/**
 * Configuration for createGitLabAdapter factory
 */
export interface GitLabAdapterConfig {
  /** Unique identifier for this source instance */
  id: string
  /** Human-readable name */
  name: string
  /** Whether this source is enabled */
  enabled: boolean
  /** Base URL for API requests (default: https://gitlab.com/api/v4) */
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
 * Factory function for creating GitLab adapters
 */
export function createGitLabAdapter(config: GitLabAdapterConfig): GitLabSourceAdapter {
  return new GitLabSourceAdapter({
    ...config,
    type: 'gitlab',
    baseUrl: config.baseUrl ?? 'https://gitlab.com/api/v4',
  })
}
