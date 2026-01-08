/**
 * Rate Limiter - SMI-730, SMI-1013, SMI-1189
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
 * - Request queue for waiting when rate limited (SMI-1013)
 * - Configurable timeout for queued requests (SMI-1013)
 */

import { createLogger } from '../../utils/logger.js'
import type {
  RateLimitConfig,
  RateLimitMetrics,
  RateLimitResult,
  RateLimitStorage,
  TokenBucket,
} from './types.js'
import { InMemoryRateLimitStorage } from './storage.js'
import {
  tryConsumeToken as tryConsumeTokenCore,
  getTokenBucketState,
  resetTokenBucket,
} from './token-bucket.js'
import { MetricsManager } from './metrics-manager.js'
import { QueueManager } from './queue-manager.js'

const log = createLogger('RateLimiter')

/**
 * Rate Limiter using Token Bucket Algorithm
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter({
 *   maxTokens: 100,
 *   refillRate: 100 / 60,
 *   windowMs: 60000,
 * })
 *
 * const result = await limiter.checkLimit('user:123')
 * if (result.allowed) {
 *   // Process request
 * } else {
 *   // Return 429 Too Many Requests
 * }
 * ```
 */
export class RateLimiter {
  private readonly config: Required<
    Omit<
      RateLimitConfig,
      'onLimitExceeded' | 'failMode' | 'enableQueue' | 'queueTimeoutMs' | 'maxQueueSize'
    >
  > & {
    onLimitExceeded?: (key: string, metrics: RateLimitMetrics) => void
    failMode: 'open' | 'closed'
    enableQueue: boolean
    queueTimeoutMs: number
    maxQueueSize: number
  }
  private readonly storage: RateLimitStorage
  private readonly metricsManager: MetricsManager
  private readonly queueManager: QueueManager

  constructor(config: RateLimitConfig, storage: RateLimitStorage = new InMemoryRateLimitStorage()) {
    this.config = {
      keyPrefix: 'ratelimit',
      debug: false,
      failMode: 'open',
      enableQueue: false,
      queueTimeoutMs: 30000,
      maxQueueSize: 100,
      ...config,
    }
    this.storage = storage
    this.metricsManager = new MetricsManager(this.config.debug, log)
    this.queueManager = new QueueManager(
      {
        maxQueueSize: this.config.maxQueueSize,
        queueTimeoutMs: this.config.queueTimeoutMs,
        debug: this.config.debug,
      },
      log
    )

    // Start queue processor if queuing is enabled (SMI-1013)
    if (this.config.enableQueue) {
      this.queueManager.startProcessor(
        (key, cost) => this.tryConsumeToken(key, cost),
        (key, allowed) => this.metricsManager.update(key, allowed)
      )
    }

    // Start metrics cleanup interval
    this.metricsManager.startCleanup()

    if (this.config.debug) {
      log.info('Rate limiter initialized', {
        maxTokens: this.config.maxTokens,
        refillRate: this.config.refillRate,
        windowMs: this.config.windowMs,
        failMode: this.config.failMode,
        enableQueue: this.config.enableQueue,
        queueTimeoutMs: this.config.queueTimeoutMs,
        maxQueueSize: this.config.maxQueueSize,
      })
    }
  }

  /**
   * Try to consume a token without queuing (internal method)
   */
  private async tryConsumeToken(key: string, cost: number): Promise<RateLimitResult> {
    return tryConsumeTokenCore(this.storage, this.config, key, cost)
  }

  /**
   * Check if a request is allowed under rate limit
   */
  async checkLimit(key: string, cost = 1): Promise<RateLimitResult> {
    const storageKey = `${this.config.keyPrefix}:${key}`
    const now = Date.now()

    try {
      let bucket = await this.storage.get(storageKey)

      if (!bucket) {
        bucket = {
          tokens: this.config.maxTokens,
          lastRefill: now,
          firstRequest: now,
        }
      }

      // Refill tokens
      const elapsedMs = now - bucket.lastRefill
      const elapsedSeconds = elapsedMs / 1000
      const tokensToAdd = elapsedSeconds * this.config.refillRate

      if (tokensToAdd > 0) {
        bucket.tokens = Math.min(this.config.maxTokens, bucket.tokens + tokensToAdd)
        bucket.lastRefill = now
      }

      const allowed = bucket.tokens >= cost

      if (allowed) {
        bucket.tokens -= cost
        await this.storage.set(storageKey, bucket, this.config.windowMs)

        if (this.config.debug) {
          log.debug(`Rate limit check: ${key}`, { allowed: true, remaining: bucket.tokens, cost })
        }

        this.metricsManager.update(key, true)

        return {
          allowed: true,
          remaining: Math.floor(bucket.tokens),
          limit: this.config.maxTokens,
          metrics: this.metricsManager.get(key),
        }
      } else {
        const tokensNeeded = cost - bucket.tokens
        const retryAfterMs = Math.ceil((tokensNeeded / this.config.refillRate) * 1000)
        const resetAt = new Date(now + retryAfterMs).toISOString()

        if (this.config.debug) {
          log.debug(`Rate limit exceeded: ${key}`, {
            allowed: false,
            remaining: bucket.tokens,
            cost,
            retryAfterMs,
          })
        }

        this.metricsManager.update(key, false)

        const currentMetrics = this.metricsManager.get(key)
        if (this.config.onLimitExceeded && currentMetrics) {
          this.config.onLimitExceeded(key, currentMetrics)
        }

        return {
          allowed: false,
          remaining: Math.floor(bucket.tokens),
          limit: this.config.maxTokens,
          retryAfterMs,
          resetAt,
          metrics: currentMetrics,
        }
      }
    } catch (error) {
      this.metricsManager.update(key, this.config.failMode === 'open', true)

      if (this.config.failMode === 'closed') {
        log.error(
          `Rate limiter error (fail-closed) for ${key}: ${error instanceof Error ? error.message : String(error)}`
        )
        return {
          allowed: false,
          remaining: 0,
          limit: this.config.maxTokens,
          retryAfterMs: this.config.windowMs,
          resetAt: new Date(Date.now() + this.config.windowMs).toISOString(),
          metrics: this.metricsManager.get(key),
        }
      }

      log.error(
        `Rate limiter error (fail-open) for ${key}: ${error instanceof Error ? error.message : String(error)}`
      )
      return {
        allowed: true,
        remaining: this.config.maxTokens,
        limit: this.config.maxTokens,
        metrics: this.metricsManager.get(key),
      }
    }
  }

  /**
   * Wait for a token to become available (SMI-1013)
   */
  async waitForToken(key: string, cost = 1): Promise<RateLimitResult> {
    if (!this.config.enableQueue) {
      return this.checkLimit(key, cost)
    }

    const immediateResult = await this.tryConsumeToken(key, cost)

    if (immediateResult.allowed) {
      this.metricsManager.update(key, true)
      return {
        ...immediateResult,
        queued: false,
        metrics: this.metricsManager.get(key),
      }
    }

    const result = await this.queueManager.queueRequest(key, cost, (allowed) =>
      this.metricsManager.update(key, allowed)
    )

    return {
      ...result,
      metrics: this.metricsManager.get(key),
    }
  }

  /**
   * Get queue status for a key (SMI-1013)
   */
  getQueueStatus(key?: string): { totalQueued: number; queues: Map<string, number> } | number {
    return this.queueManager.getStatus(key)
  }

  /**
   * Clear queue for a key (SMI-1013)
   */
  clearQueue(key?: string): void {
    this.queueManager.clear(key)
    if (this.config.debug) {
      log.debug(`Queue cleared${key ? ` for key: ${key}` : ' (all)'}`)
    }
  }

  /**
   * Reset rate limit for a key
   */
  async reset(key: string): Promise<void> {
    await resetTokenBucket(this.storage, this.config.keyPrefix, key)
    if (this.config.debug) {
      log.debug(`Rate limit reset: ${key}`)
    }
  }

  /**
   * Get current state for a key
   */
  async getState(key: string): Promise<TokenBucket | null> {
    return getTokenBucketState(this.storage, this.config.keyPrefix, key)
  }

  /**
   * Get metrics for a specific key or all keys
   */
  getMetrics(key?: string): Map<string, RateLimitMetrics> | RateLimitMetrics | undefined {
    if (key) {
      return this.metricsManager.get(key)
    }
    return this.metricsManager.getAll()
  }

  /**
   * Reset metrics for a specific key or all keys
   */
  resetMetrics(key?: string): void {
    if (key) {
      this.metricsManager.delete(key)
    } else {
      this.metricsManager.clear()
    }
    if (this.config.debug) {
      log.debug(`Metrics reset${key ? ` for key: ${key}` : ' (all)'}`)
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.queueManager.dispose()
    this.metricsManager.dispose()
    if (this.storage instanceof InMemoryRateLimitStorage) {
      this.storage.dispose()
    }
  }
}
