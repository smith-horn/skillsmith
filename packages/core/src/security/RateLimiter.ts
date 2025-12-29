/**
 * Rate Limiter - SMI-730
 *
 * Token bucket algorithm for rate limiting API endpoints and adapters.
 * Prevents abuse and DoS attacks with configurable limits and windows.
 *
 * Features:
 * - Token bucket algorithm for smooth rate limiting
 * - Per-IP and per-user limits
 * - Configurable limits and windows
 * - In-memory storage (Redis-compatible interface)
 * - Graceful degradation on errors
 */

import { createLogger } from '../utils/logger.js'

const log = createLogger('RateLimiter')

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum tokens in bucket (burst capacity) */
  maxTokens: number
  /** Tokens refilled per second */
  refillRate: number
  /** Window duration in milliseconds (for cleanup) */
  windowMs: number
  /** Key prefix for storage */
  keyPrefix?: string
  /** Enable debug logging */
  debug?: boolean
}

/**
 * Token bucket state
 */
interface TokenBucket {
  /** Current number of tokens */
  tokens: number
  /** Last refill timestamp */
  lastRefill: number
  /** First request timestamp (for window tracking) */
  firstRequest: number
}

/**
 * Rate limit result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean
  /** Remaining tokens */
  remaining: number
  /** Total tokens in bucket */
  limit: number
  /** Milliseconds until bucket refills */
  retryAfterMs?: number
  /** When the limit resets (ISO timestamp) */
  resetAt?: string
}

/**
 * Storage interface for rate limit data
 */
export interface RateLimitStorage {
  get(key: string): Promise<TokenBucket | null>
  set(key: string, value: TokenBucket, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
  clear?(): Promise<void>
}

/**
 * In-memory storage implementation
 */
export class InMemoryRateLimitStorage implements RateLimitStorage {
  private store = new Map<string, { bucket: TokenBucket; expiresAt: number }>()
  private cleanupInterval: NodeJS.Timeout | null = null

  constructor(cleanupIntervalMs = 60000) {
    // Periodic cleanup of expired entries
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, cleanupIntervalMs)
  }

  async get(key: string): Promise<TokenBucket | null> {
    const entry = this.store.get(key)
    if (!entry) return null

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }

    return entry.bucket
  }

  async set(key: string, value: TokenBucket, ttlMs: number): Promise<void> {
    this.store.set(key, {
      bucket: value,
      expiresAt: Date.now() + ttlMs,
    })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now()
    let cleaned = 0

    // Use Array.from to avoid downlevelIteration requirement
    Array.from(this.store.entries()).forEach(([key, entry]) => {
      if (now > entry.expiresAt) {
        this.store.delete(key)
        cleaned++
      }
    })

    if (cleaned > 0) {
      log.debug(`Cleaned up ${cleaned} expired rate limit entries`)
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.store.clear()
  }

  /**
   * Get storage stats (for testing/monitoring)
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.store.size,
      keys: Array.from(this.store.keys()),
    }
  }
}

/**
 * Rate Limiter using Token Bucket Algorithm
 *
 * The token bucket algorithm allows for burst traffic while maintaining
 * a steady long-term rate. Each request consumes a token from the bucket.
 * Tokens are refilled at a constant rate.
 *
 * @example
 * ```typescript
 * // Create rate limiter: 100 requests per minute
 * const limiter = new RateLimiter({
 *   maxTokens: 100,
 *   refillRate: 100 / 60, // ~1.67 tokens/sec
 *   windowMs: 60000,
 * })
 *
 * // Check if request is allowed
 * const result = await limiter.checkLimit('user:123')
 * if (result.allowed) {
 *   // Process request
 * } else {
 *   // Return 429 Too Many Requests
 *   // Retry after: result.retryAfterMs
 * }
 * ```
 */
export class RateLimiter {
  private readonly config: Required<RateLimitConfig>
  private readonly storage: RateLimitStorage

  constructor(
    config: RateLimitConfig,
    storage: RateLimitStorage = new InMemoryRateLimitStorage()
  ) {
    this.config = {
      keyPrefix: 'ratelimit',
      debug: false,
      ...config,
    }
    this.storage = storage

    if (this.config.debug) {
      log.info('Rate limiter initialized', {
        maxTokens: this.config.maxTokens,
        refillRate: this.config.refillRate,
        windowMs: this.config.windowMs,
      })
    }
  }

  /**
   * Check if a request is allowed under rate limit
   *
   * @param key - Unique identifier (e.g., 'ip:192.168.1.1' or 'user:123')
   * @param cost - Number of tokens to consume (default: 1)
   * @returns Rate limit result
   */
  async checkLimit(key: string, cost = 1): Promise<RateLimitResult> {
    const storageKey = `${this.config.keyPrefix}:${key}`
    const now = Date.now()

    try {
      // Get current bucket state
      let bucket = await this.storage.get(storageKey)

      if (!bucket) {
        // Initialize new bucket
        bucket = {
          tokens: this.config.maxTokens,
          lastRefill: now,
          firstRequest: now,
        }
      }

      // Refill tokens based on elapsed time
      const elapsedMs = now - bucket.lastRefill
      const elapsedSeconds = elapsedMs / 1000
      const tokensToAdd = elapsedSeconds * this.config.refillRate

      if (tokensToAdd > 0) {
        bucket.tokens = Math.min(this.config.maxTokens, bucket.tokens + tokensToAdd)
        bucket.lastRefill = now
      }

      // Check if we have enough tokens
      const allowed = bucket.tokens >= cost

      if (allowed) {
        // Consume tokens
        bucket.tokens -= cost

        // Save updated bucket
        await this.storage.set(storageKey, bucket, this.config.windowMs)

        if (this.config.debug) {
          log.debug(`Rate limit check: ${key}`, {
            allowed: true,
            remaining: bucket.tokens,
            cost,
          })
        }

        return {
          allowed: true,
          remaining: Math.floor(bucket.tokens),
          limit: this.config.maxTokens,
        }
      } else {
        // Not enough tokens - calculate retry time
        const tokensNeeded = cost - bucket.tokens
        const retryAfterMs = Math.ceil((tokensNeeded / this.config.refillRate) * 1000)
        const resetAt = new Date(now + retryAfterMs).toISOString()

        // Don't update bucket since we're denying the request
        if (this.config.debug) {
          log.debug(`Rate limit exceeded: ${key}`, {
            allowed: false,
            remaining: bucket.tokens,
            cost,
            retryAfterMs,
          })
        }

        return {
          allowed: false,
          remaining: Math.floor(bucket.tokens),
          limit: this.config.maxTokens,
          retryAfterMs,
          resetAt,
        }
      }
    } catch (error) {
      // Graceful degradation: allow request on storage errors
      log.error(`Rate limiter error for ${key}: ${error instanceof Error ? error.message : String(error)}`)

      return {
        allowed: true,
        remaining: this.config.maxTokens,
        limit: this.config.maxTokens,
      }
    }
  }

  /**
   * Reset rate limit for a key (e.g., after authentication)
   */
  async reset(key: string): Promise<void> {
    const storageKey = `${this.config.keyPrefix}:${key}`
    await this.storage.delete(storageKey)

    if (this.config.debug) {
      log.debug(`Rate limit reset: ${key}`)
    }
  }

  /**
   * Get current state for a key (for monitoring/debugging)
   */
  async getState(key: string): Promise<TokenBucket | null> {
    const storageKey = `${this.config.keyPrefix}:${key}`
    return await this.storage.get(storageKey)
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    if (this.storage instanceof InMemoryRateLimitStorage) {
      this.storage.dispose()
    }
  }
}

/**
 * Preset rate limit configurations
 */
export const RATE_LIMIT_PRESETS = {
  /** Very strict: 10 requests per minute */
  STRICT: {
    maxTokens: 10,
    refillRate: 10 / 60, // 0.167 tokens/sec
    windowMs: 60000,
  },
  /** Standard: 30 requests per minute (default for adapters) */
  STANDARD: {
    maxTokens: 30,
    refillRate: 30 / 60, // 0.5 tokens/sec
    windowMs: 60000,
  },
  /** Relaxed: 60 requests per minute */
  RELAXED: {
    maxTokens: 60,
    refillRate: 60 / 60, // 1 token/sec
    windowMs: 60000,
  },
  /** Generous: 120 requests per minute */
  GENEROUS: {
    maxTokens: 120,
    refillRate: 120 / 60, // 2 tokens/sec
    windowMs: 60000,
  },
  /** High throughput: 300 requests per minute */
  HIGH_THROUGHPUT: {
    maxTokens: 300,
    refillRate: 300 / 60, // 5 tokens/sec
    windowMs: 60000,
  },
} as const

/**
 * Create a rate limiter from a preset
 */
export function createRateLimiterFromPreset(
  preset: keyof typeof RATE_LIMIT_PRESETS,
  storage?: RateLimitStorage
): RateLimiter {
  return new RateLimiter(RATE_LIMIT_PRESETS[preset], storage)
}
