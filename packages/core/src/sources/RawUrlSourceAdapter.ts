/**
 * Raw URL Source Adapter (SMI-591)
 *
 * Fetches skills from arbitrary HTTP/HTTPS URLs.
 * Useful for custom registries or standalone skill files.
 */

import { BaseSourceAdapter } from './BaseSourceAdapter.js'
import type {
  SourceConfig,
  SourceLocation,
  SourceRepository,
  SourceSearchOptions,
  SourceSearchResult,
  SkillContent,
  SourceHealth,
} from './types.js'
import { createHash } from 'crypto'
import { createLogger } from '../utils/logger.js'
import { validateUrl } from '../validation/index.js'
import { ApiError, NetworkError, wrapError } from '../errors/SkillsmithError.js'

const log = createLogger('RawUrlAdapter')

/**
 * Registry entry for a skill URL
 */
export interface SkillUrlEntry {
  /** Unique identifier */
  id: string
  /** Human-readable name */
  name: string
  /** Full URL to the SKILL.md file */
  url: string
  /** Optional description */
  description?: string
  /** Optional author */
  author?: string
  /** Optional tags for searching */
  tags?: string[]
}

/**
 * Configuration for Raw URL adapter
 */
export interface RawUrlSourceConfig extends SourceConfig {
  /** Predefined list of skill URLs to index */
  skillUrls?: SkillUrlEntry[]
  /** URL to a JSON registry file containing skill entries */
  registryUrl?: string
  /** Request timeout in milliseconds */
  timeout?: number
}

/**
 * Raw URL Source Adapter
 *
 * Fetches skill files from arbitrary HTTP/HTTPS URLs.
 * Can work with:
 * - A predefined list of skill URLs
 * - A JSON registry file containing skill entries
 * - Direct URL locations
 *
 * @example
 * ```typescript
 * const adapter = new RawUrlSourceAdapter({
 *   id: 'custom-registry',
 *   name: 'Custom Registry',
 *   type: 'raw-url',
 *   baseUrl: 'https://example.com',
 *   enabled: true,
 *   skillUrls: [
 *     { id: '1', name: 'My Skill', url: 'https://example.com/skill.md' }
 *   ]
 * })
 *
 * await adapter.initialize()
 * const content = await adapter.fetchSkillContent({
 *   owner: 'example.com',
 *   repo: 'my-skill',
 *   path: 'https://example.com/skill.md'
 * })
 * ```
 */
export class RawUrlSourceAdapter extends BaseSourceAdapter {
  private skillUrls: SkillUrlEntry[] = []
  private readonly timeout: number

  constructor(config: RawUrlSourceConfig) {
    super(config)
    this.skillUrls = config.skillUrls ?? []
    this.timeout = config.timeout ?? 30000
  }

  /**
   * Initialize adapter - load registry if configured
   */
  protected override async doInitialize(): Promise<void> {
    const config = this.config as RawUrlSourceConfig

    if (config.registryUrl) {
      await this.loadRegistry(config.registryUrl)
    }
  }

  /**
   * Load skill entries from a remote JSON registry
   */
  private async loadRegistry(registryUrl: string): Promise<void> {
    try {
      validateUrl(registryUrl)
      const response = await this.fetchWithTimeout(registryUrl)

      if (!response.ok) {
        throw new ApiError(`Failed to load registry: ${response.status}`, {
          statusCode: response.status,
          url: registryUrl,
        })
      }

      const data = (await response.json()) as { skills?: SkillUrlEntry[] }

      if (data.skills && Array.isArray(data.skills)) {
        this.skillUrls = [...this.skillUrls, ...data.skills]
      }
    } catch (error) {
      // Registry load is optional - log but don't fail (SMI-881: preserve error context)
      const wrappedError = wrapError(error, `Failed to load registry from ${registryUrl}`)
      log.warn(wrappedError.message)
    }
  }

  /**
   * Check if the source is reachable
   */
  protected async doHealthCheck(): Promise<Partial<SourceHealth>> {
    // Try to reach the base URL
    try {
      validateUrl(this.config.baseUrl)
      const response = await this.fetchWithTimeout(this.config.baseUrl, { method: 'HEAD' })
      return {
        healthy: response.ok || response.status === 405, // 405 = Method Not Allowed is ok for HEAD
      }
    } catch {
      return {
        healthy: false,
        error: 'Base URL unreachable',
      }
    }
  }

  /**
   * Search for skills in the configured registry
   */
  async search(options: SourceSearchOptions = {}): Promise<SourceSearchResult> {
    await this.waitForRateLimit()

    let filtered = [...this.skillUrls]

    // Filter by query (search in name, description, tags)
    if (options.query) {
      const query = options.query.toLowerCase()
      filtered = filtered.filter(
        (entry) =>
          entry.name.toLowerCase().includes(query) ||
          entry.description?.toLowerCase().includes(query) ||
          entry.tags?.some((tag) => tag.toLowerCase().includes(query))
      )
    }

    // Filter by topics (match against tags)
    if (options.topics?.length) {
      filtered = filtered.filter((entry) =>
        options.topics!.some((topic) => entry.tags?.includes(topic))
      )
    }

    // Apply limit
    const limit = options.limit ?? 100
    const limitedResults = filtered.slice(0, limit)

    // Convert to SourceRepository format
    const repositories: SourceRepository[] = limitedResults.map((entry) =>
      this.entryToRepository(entry)
    )

    return {
      repositories,
      totalCount: filtered.length,
      hasMore: filtered.length > limit,
    }
  }

  /**
   * Get repository (skill entry) by location
   */
  async getRepository(location: SourceLocation): Promise<SourceRepository> {
    await this.waitForRateLimit()

    // Find by URL or ID
    const url = location.path ?? `${this.config.baseUrl}/${location.owner}/${location.repo}`
    const entry = this.skillUrls.find((e) => e.url === url || e.id === location.repo)

    if (entry) {
      return this.entryToRepository(entry)
    }

    // Create a synthetic entry for the URL
    return {
      id: this.generateId(url),
      name: location.repo ?? 'Unknown Skill',
      url,
      description: null,
      owner: location.owner ?? new URL(url).hostname,
      defaultBranch: 'main',
      stars: 0,
      forks: 0,
      topics: [],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      license: null,
      metadata: { sourceType: 'raw-url' },
    }
  }

  /**
   * Fetch skill content from a URL
   */
  async fetchSkillContent(location: SourceLocation): Promise<SkillContent> {
    // Determine the URL to fetch
    let url: string
    if (location.path?.startsWith('http')) {
      url = location.path
    } else {
      // Try to find in registry
      const entry = this.skillUrls.find((e) => e.id === location.repo || e.name === location.repo)
      if (entry) {
        url = entry.url
      } else {
        // Construct URL from base
        url = `${this.config.baseUrl}/${location.owner}/${location.repo}/SKILL.md`
      }
    }

    // Validate URL to prevent SSRF attacks (SMI-721, SMI-726, SMI-729)
    validateUrl(url)

    // Note: Rate limiting is handled by fetchWithTimeout -> fetchWithRateLimit
    const response = await this.fetchWithTimeout(url)

    if (!response.ok) {
      throw new ApiError(`Failed to fetch skill content: ${response.status}`, {
        statusCode: response.status,
        url,
      })
    }

    const rawContent = await response.text()
    const sha = this.generateSha(rawContent)

    return {
      rawContent,
      sha,
      location,
      filePath: new URL(url).pathname,
      encoding: 'utf-8',
    }
  }

  /**
   * Add a skill URL to the registry
   */
  addSkillUrl(entry: SkillUrlEntry): void {
    this.skillUrls.push(entry)
  }

  /**
   * Remove a skill URL from the registry
   */
  removeSkillUrl(id: string): boolean {
    const index = this.skillUrls.findIndex((e) => e.id === id)
    if (index >= 0) {
      this.skillUrls.splice(index, 1)
      return true
    }
    return false
  }

  /**
   * Get all registered skill URLs
   */
  getSkillUrls(): SkillUrlEntry[] {
    return [...this.skillUrls]
  }

  /**
   * Convert a registry entry to SourceRepository
   */
  private entryToRepository(entry: SkillUrlEntry): SourceRepository {
    const urlObj = new URL(entry.url)

    return {
      id: entry.id,
      name: entry.name,
      url: entry.url,
      description: entry.description ?? null,
      owner: entry.author ?? urlObj.hostname,
      defaultBranch: 'main',
      stars: 0,
      forks: 0,
      topics: entry.tags ?? [],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      license: null,
      metadata: { sourceType: 'raw-url' },
    }
  }

  /**
   * Fetch with timeout
   */
  private async fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await this.fetchWithRateLimit(url, {
        ...options,
        signal: controller.signal,
      })
      return response
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Generate a deterministic ID from a URL
   */
  private generateId(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 16)
  }

  /**
   * Generate SHA hash for content
   */
  private generateSha(content: string): string {
    return createHash('sha256').update(content).digest('hex')
  }
}

/**
 * Factory function for creating Raw URL adapters
 */
export function createRawUrlAdapter(config: RawUrlSourceConfig): RawUrlSourceAdapter {
  return new RawUrlSourceAdapter({
    ...config,
    type: 'raw-url',
  })
}
