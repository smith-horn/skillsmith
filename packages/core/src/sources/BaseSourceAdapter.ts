/**
 * Base Source Adapter
 * Abstract base class providing common functionality for source adapters
 *
 * SMI-1013: Enhanced with token bucket rate limiting and request queuing
 */

import type { ISourceAdapter } from './ISourceAdapter.js'
import { validateUrl } from '../validation/index.js'
import {
  RateLimiter,
  InMemoryRateLimitStorage,
  RATE_LIMIT_PRESETS,
  type RateLimitConfig as TokenBucketConfig,
} from '../security/index.js'
import { fetchWithRetry, type RetryConfig } from '../utils/retry.js'
import type {
  SourceConfig,
  SourceLocation,
  SourceRepository,
  SourceSearchOptions,
  SourceSearchResult,
  SkillContent,
  SourceHealth,
  RateLimitConfig,
} from './types.js'

/**
 * Default rate limit configuration (legacy window-based)
 */
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 30,
  windowMs: 60000,
  minDelayMs: 150,
}

/**
 * Extended source config with token bucket rate limiting (SMI-1013)
 */
export interface ExtendedSourceConfig extends SourceConfig {
  /** Use token bucket rate limiter with queue support (SMI-1013) */
  useTokenBucket?: boolean
  /** Token bucket configuration (overrides legacy rateLimit) */
  tokenBucketConfig?: TokenBucketConfig
  /** Enable retry logic for transient network failures (SMI-880) */
  enableRetry?: boolean
  /** Retry configuration (SMI-880) */
  retryConfig?: RetryConfig
}

/**
 * Abstract base class for source adapters
 *
 * Provides:
 * - Configuration management
 * - Rate limiting
 * - Request timing
 * - Error handling utilities
 *
 * Subclasses must implement:
 * - search()
 * - getRepository()
 * - fetchSkillContent()
 * - doHealthCheck()
 */
export abstract class BaseSourceAdapter implements ISourceAdapter {
  readonly config: ExtendedSourceConfig
  readonly id: string
  readonly name: string
  readonly type: string

  protected initialized = false
  protected lastRequestTime = 0
  protected requestCount = 0
  protected windowStart = 0

  /** Token bucket rate limiter (SMI-1013) */
  protected rateLimiter: RateLimiter | null = null

  constructor(config: SourceConfig | ExtendedSourceConfig) {
    this.config = {
      ...config,
      rateLimit: config.rateLimit ?? DEFAULT_RATE_LIMIT,
    }
    this.id = config.id
    this.name = config.name
    this.type = config.type

    // Initialize token bucket rate limiter if enabled (SMI-1013)
    const extConfig = config as ExtendedSourceConfig
    if (extConfig.useTokenBucket) {
      const tokenBucketConfig: TokenBucketConfig = extConfig.tokenBucketConfig ?? {
        ...RATE_LIMIT_PRESETS.STANDARD,
        enableQueue: true,
        queueTimeoutMs: 30000,
        maxQueueSize: 100,
        keyPrefix: `adapter:${config.id}`,
      }
      this.rateLimiter = new RateLimiter(tokenBucketConfig, new InMemoryRateLimitStorage())
    }
  }

  /**
   * Initialize the adapter
   * Override in subclasses for custom initialization
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.doInitialize()
    this.initialized = true
  }

  /**
   * Subclass initialization hook
   */
  protected async doInitialize(): Promise<void> {
    // Default: no-op, override in subclasses
  }

  /**
   * Check source health
   */
  async checkHealth(): Promise<SourceHealth> {
    const startTime = Date.now()
    try {
      const result = await this.doHealthCheck()
      return {
        healthy: result.healthy ?? true,
        responseTimeMs: Date.now() - startTime,
        lastCheck: new Date().toISOString(),
        rateLimitRemaining: result.rateLimitRemaining,
        rateLimitReset: result.rateLimitReset,
        error: result.error,
      }
    } catch (error) {
      return {
        healthy: false,
        responseTimeMs: Date.now() - startTime,
        lastCheck: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Subclass health check implementation
   */
  protected abstract doHealthCheck(): Promise<Partial<SourceHealth>>

  /**
   * Search for repositories
   */
  abstract search(options: SourceSearchOptions): Promise<SourceSearchResult>

  /**
   * Get repository metadata
   */
  abstract getRepository(location: SourceLocation): Promise<SourceRepository>

  /**
   * Fetch skill content
   */
  abstract fetchSkillContent(location: SourceLocation): Promise<SkillContent>

  /**
   * Check if skill exists at location
   */
  async skillExists(location: SourceLocation): Promise<boolean> {
    try {
      await this.fetchSkillContent(location)
      return true
    } catch {
      return false
    }
  }

  /**
   * Get skill file SHA for change detection
   */
  async getSkillSha(location: SourceLocation): Promise<string | null> {
    try {
      const content = await this.fetchSkillContent(location)
      return content.sha
    } catch {
      return null
    }
  }

  /**
   * Dispose of resources
   */
  async dispose(): Promise<void> {
    // SMI-1013: Dispose rate limiter
    if (this.rateLimiter) {
      this.rateLimiter.dispose()
      this.rateLimiter = null
    }

    await this.doDispose()
    this.initialized = false
  }

  /**
   * Subclass disposal hook
   */
  protected async doDispose(): Promise<void> {
    // Default: no-op, override in subclasses
  }

  /**
   * Wait for rate limit before making a request
   */
  protected async waitForRateLimit(): Promise<void> {
    const config = this.config.rateLimit ?? DEFAULT_RATE_LIMIT
    const now = Date.now()

    // Reset window if expired
    if (now - this.windowStart > config.windowMs) {
      this.windowStart = now
      this.requestCount = 0
    }

    // Check if we've exceeded the rate limit
    if (this.requestCount >= config.maxRequests) {
      const waitTime = config.windowMs - (now - this.windowStart)
      if (waitTime > 0) {
        await this.delay(waitTime)
        this.windowStart = Date.now()
        this.requestCount = 0
      }
    }

    // Ensure minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime
    if (timeSinceLastRequest < config.minDelayMs) {
      await this.delay(config.minDelayMs - timeSinceLastRequest)
    }

    this.lastRequestTime = Date.now()
    this.requestCount++
  }

  /**
   * Make a rate-limited fetch request with retry support
   *
   * SMI-1013: Uses token bucket rate limiter with queue support when enabled,
   * otherwise falls back to legacy window-based rate limiting.
   *
   * SMI-880: Automatically retries on transient network failures (ETIMEDOUT,
   * ECONNRESET, 5xx) with exponential backoff when enableRetry is true.
   */
  protected async fetchWithRateLimit(url: string, options?: RequestInit): Promise<Response> {
    validateUrl(url)

    // SMI-1013: Use token bucket rate limiter if available
    if (this.rateLimiter) {
      // waitForToken will queue the request if rate limited
      await this.rateLimiter.waitForToken(this.id)
    } else {
      // Legacy window-based rate limiting
      await this.waitForRateLimit()
    }

    const headers = new Headers(options?.headers)

    // Add auth header if configured
    if (this.config.auth?.type === 'token' && this.config.auth.credentials) {
      headers.set('Authorization', `Bearer ${this.config.auth.credentials}`)
    } else if (this.config.auth?.type === 'basic' && this.config.auth.credentials) {
      headers.set('Authorization', `Basic ${this.config.auth.credentials}`)
    }

    const fetchOptions: RequestInit = {
      ...options,
      headers,
    }

    // SMI-880: Use retry logic if explicitly enabled
    const extendedConfig = this.config as ExtendedSourceConfig
    let response: Response

    if (extendedConfig.enableRetry === true) {
      // Opt-in retry for resilience against transient failures
      response = await fetchWithRetry(url, fetchOptions, extendedConfig.retryConfig)
    } else {
      response = await fetch(url, fetchOptions)
    }

    // Update rate limit info from response headers if available
    this.updateRateLimitFromResponse(response)

    return response
  }

  /**
   * Get rate limiter status (SMI-1013)
   *
   * Returns information about the token bucket rate limiter state,
   * including queue status if queuing is enabled.
   */
  getRateLimiterStatus(): {
    usingTokenBucket: boolean
    queueStatus?: { totalQueued: number; queues: Map<string, number> } | number
  } {
    if (!this.rateLimiter) {
      return { usingTokenBucket: false }
    }

    return {
      usingTokenBucket: true,
      queueStatus: this.rateLimiter.getQueueStatus(),
    }
  }

  /**
   * Update rate limit tracking from response headers
   */
  protected updateRateLimitFromResponse(response: Response): void {
    // Common rate limit headers (GitHub, GitLab, etc.)
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = response.headers.get('x-ratelimit-reset')

    if (remaining !== null) {
      const remainingNum = parseInt(remaining, 10)
      if (remainingNum <= 0 && reset) {
        // We've hit the rate limit, update window
        const _resetTime = parseInt(reset, 10) * 1000
        this.windowStart = Date.now()
        this.requestCount = this.config.rateLimit?.maxRequests ?? DEFAULT_RATE_LIMIT.maxRequests
      }
    }
  }

  /**
   * Build the default skill file path
   */
  protected getDefaultSkillPath(location: SourceLocation): string {
    return location.path ?? 'SKILL.md'
  }

  /**
   * Build the default branch
   */
  protected getDefaultBranch(location: SourceLocation): string {
    return location.branch ?? 'main'
  }

  /**
   * Delay helper
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Validate configuration
   */
  protected validateConfig(): void {
    if (!this.config.id) {
      throw new Error('Source adapter requires an id')
    }
    if (!this.config.name) {
      throw new Error('Source adapter requires a name')
    }
    if (!this.config.baseUrl) {
      throw new Error('Source adapter requires a baseUrl')
    }
  }
}
