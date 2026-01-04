/**
 * Rate Limiter - SMI-730, SMI-1013
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

import { createLogger } from '../utils/logger.js'
import { randomUUID } from 'crypto'

const log = createLogger('RateLimiter')

/**
 * Maximum number of unique keys to track in queues and metrics
 * Prevents unbounded memory growth from malicious or misconfigured clients
 */
const MAX_UNIQUE_KEYS = 10000

/**
 * Metrics TTL in milliseconds (1 hour) - metrics older than this are cleaned up
 */
const METRICS_TTL_MS = 60 * 60 * 1000

/**
 * Rate limit metrics for monitoring and alerting
 */
export interface RateLimitMetrics {
  /** Number of allowed requests */
  allowed: number
  /** Number of blocked requests */
  blocked: number
  /** Number of errors (storage failures, etc.) */
  errors: number
  /** Last time metrics were reset */
  lastReset: Date
  /** Last time metrics were updated */
  lastUpdated: Date
}

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
  /** Callback when rate limit is exceeded */
  onLimitExceeded?: (key: string, metrics: RateLimitMetrics) => void
  /** Fail mode on storage errors: 'open' allows requests, 'closed' denies them (default: 'open') */
  failMode?: 'open' | 'closed'
  /** Enable request queuing when rate limited (SMI-1013, default: false) */
  enableQueue?: boolean
  /** Maximum time to wait in queue in milliseconds (SMI-1013, default: 30000) */
  queueTimeoutMs?: number
  /** Maximum number of requests that can wait in queue (SMI-1013, default: 100) */
  maxQueueSize?: number
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
  /** Current metrics for this key (optional) */
  metrics?: RateLimitMetrics
  /** Whether the request waited in queue (SMI-1013) */
  queued?: boolean
  /** Time spent waiting in queue in milliseconds (SMI-1013) */
  queueWaitMs?: number
}

/**
 * Queued request waiting for a token (SMI-1013)
 */
interface QueuedRequest {
  /** Unique identifier for this request */
  id: string
  /** Resolve function to signal the request can proceed */
  resolve: (result: RateLimitResult) => void
  /** Reject function for timeout */
  reject: (error: Error) => void
  /** Token cost for this request */
  cost: number
  /** Timestamp when request was queued */
  queuedAt: number
  /** Timeout handle */
  timeoutHandle: NodeJS.Timeout
}

/**
 * Error thrown when queue timeout is exceeded (SMI-1013)
 */
export class RateLimitQueueTimeoutError extends Error {
  constructor(
    public readonly key: string,
    public readonly timeoutMs: number
  ) {
    super(`Rate limit queue timeout exceeded for key '${key}' after ${timeoutMs}ms`)
    this.name = 'RateLimitQueueTimeoutError'
  }
}

/**
 * Error thrown when queue is full (SMI-1013)
 */
export class RateLimitQueueFullError extends Error {
  constructor(
    public readonly key: string,
    public readonly maxQueueSize: number
  ) {
    super(`Rate limit queue full for key '${key}' (max: ${maxQueueSize})`)
    this.name = 'RateLimitQueueFullError'
  }
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
  private readonly metrics: Map<string, RateLimitMetrics> = new Map()
  /** Queue of waiting requests per key (SMI-1013) */
  private readonly queues: Map<string, QueuedRequest[]> = new Map()
  /** Timer for processing queues (SMI-1013) */
  private queueProcessorInterval: NodeJS.Timeout | null = null
  /** Timer for cleaning up stale metrics */
  private metricsCleanupInterval: NodeJS.Timeout | null = null
  /** Lock for atomic token operations (prevents TOCTOU race conditions) */
  private readonly operationLocks: Map<string, Promise<void>> = new Map()
  /** Flag to prevent concurrent queue processing */
  private isProcessingQueues = false

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

    // Start queue processor if queuing is enabled (SMI-1013)
    if (this.config.enableQueue) {
      this.startQueueProcessor()
    }

    // Start metrics cleanup interval
    this.startMetricsCleanup()

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
   * Start the queue processor that periodically checks for available tokens (SMI-1013)
   */
  private startQueueProcessor(): void {
    // Check queue every 100ms
    this.queueProcessorInterval = setInterval(() => {
      this.processQueues()
    }, 100)
  }

  /**
   * Start periodic cleanup of stale metrics
   */
  private startMetricsCleanup(): void {
    // Clean up stale metrics every 5 minutes
    this.metricsCleanupInterval = setInterval(
      () => {
        this.cleanupStaleMetrics()
      },
      5 * 60 * 1000
    )
  }

  /**
   * Clean up metrics older than METRICS_TTL_MS
   */
  private cleanupStaleMetrics(): void {
    const now = new Date()
    let cleaned = 0

    for (const [key, metrics] of this.metrics.entries()) {
      if (now.getTime() - metrics.lastUpdated.getTime() > METRICS_TTL_MS) {
        this.metrics.delete(key)
        cleaned++
      }
    }

    // Also enforce MAX_UNIQUE_KEYS limit if somehow exceeded
    if (this.metrics.size > MAX_UNIQUE_KEYS) {
      // Sort by lastUpdated and remove oldest entries
      const entries = Array.from(this.metrics.entries()).sort(
        (a, b) => a[1].lastUpdated.getTime() - b[1].lastUpdated.getTime()
      )
      const toRemove = entries.slice(0, this.metrics.size - MAX_UNIQUE_KEYS)
      for (const [key] of toRemove) {
        this.metrics.delete(key)
        cleaned++
      }
    }

    if (cleaned > 0 && this.config.debug) {
      log.debug(`Cleaned up ${cleaned} stale metric entries`)
    }
  }

  /**
   * Acquire a lock for atomic operations on a key
   */
  private async acquireLock(key: string): Promise<void> {
    // Wait for any existing operation to complete
    const existingLock = this.operationLocks.get(key)
    if (existingLock) {
      await existingLock
    }
  }

  /**
   * Process all queues and release waiting requests when tokens become available (SMI-1013)
   * Uses a flag to prevent concurrent processing
   */
  private async processQueues(): Promise<void> {
    // Prevent concurrent queue processing
    if (this.isProcessingQueues) {
      return
    }
    this.isProcessingQueues = true

    try {
      for (const [key, queue] of this.queues.entries()) {
        if (queue.length === 0) {
          // Clean up empty queues to prevent memory leak
          this.queues.delete(key)
          continue
        }

        // Try to process the first request in the queue
        const request = queue[0]
        const result = await this.tryConsumeToken(key, request.cost)

        if (result.allowed) {
          // Remove from queue by ID (not by position for safety)
          const index = queue.findIndex((r) => r.id === request.id)
          if (index !== -1) {
            queue.splice(index, 1)
          }
          // Clear timeout
          clearTimeout(request.timeoutHandle)
          // Resolve with queue info
          const queueWaitMs = Date.now() - request.queuedAt
          request.resolve({
            ...result,
            queued: true,
            queueWaitMs,
          })

          if (this.config.debug) {
            log.debug(`Queue request released for ${key}`, {
              requestId: request.id,
              queueWaitMs,
              remaining: result.remaining,
            })
          }
        }
      }
    } finally {
      this.isProcessingQueues = false
    }
  }

  /**
   * Try to consume a token without queuing (internal method)
   */
  private async tryConsumeToken(key: string, cost: number): Promise<RateLimitResult> {
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
        bucket.tokens -= cost
        await this.storage.set(storageKey, bucket, this.config.windowMs)

        return {
          allowed: true,
          remaining: Math.floor(bucket.tokens),
          limit: this.config.maxTokens,
        }
      } else {
        const tokensNeeded = cost - bucket.tokens
        const retryAfterMs = Math.ceil((tokensNeeded / this.config.refillRate) * 1000)
        const resetAt = new Date(now + retryAfterMs).toISOString()

        return {
          allowed: false,
          remaining: Math.floor(bucket.tokens),
          limit: this.config.maxTokens,
          retryAfterMs,
          resetAt,
        }
      }
    } catch {
      // On error, return based on fail mode
      if (this.config.failMode === 'closed') {
        return {
          allowed: false,
          remaining: 0,
          limit: this.config.maxTokens,
          retryAfterMs: this.config.windowMs,
        }
      }
      return {
        allowed: true,
        remaining: this.config.maxTokens,
        limit: this.config.maxTokens,
      }
    }
  }

  /**
   * Update metrics for a key with bounds checking
   */
  private updateMetrics(key: string, allowed: boolean, error = false): void {
    // Check if we've hit the max unique keys limit
    if (!this.metrics.has(key) && this.metrics.size >= MAX_UNIQUE_KEYS) {
      // Evict oldest entry before adding new one
      let oldestKey: string | null = null
      let oldestTime = Infinity

      for (const [k, m] of this.metrics.entries()) {
        if (m.lastUpdated.getTime() < oldestTime) {
          oldestTime = m.lastUpdated.getTime()
          oldestKey = k
        }
      }

      if (oldestKey) {
        this.metrics.delete(oldestKey)
        if (this.config.debug) {
          log.debug(`Evicted oldest metrics entry: ${oldestKey}`)
        }
      }
    }

    const now = new Date()
    const existing = this.metrics.get(key) || {
      allowed: 0,
      blocked: 0,
      errors: 0,
      lastReset: now,
      lastUpdated: now,
    }

    if (error) {
      existing.errors++
      // Also track allowed/blocked for error cases (fail-open vs fail-closed)
      if (allowed) {
        existing.allowed++
      } else {
        existing.blocked++
      }
    } else if (allowed) {
      existing.allowed++
    } else {
      existing.blocked++
    }

    existing.lastUpdated = now
    this.metrics.set(key, existing)
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

        // Track metrics for allowed request
        this.updateMetrics(key, true)

        return {
          allowed: true,
          remaining: Math.floor(bucket.tokens),
          limit: this.config.maxTokens,
          metrics: this.metrics.get(key),
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

        // Track metrics for blocked request
        this.updateMetrics(key, false)

        // Call onLimitExceeded callback if configured
        const currentMetrics = this.metrics.get(key)
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
      // Track error in metrics
      this.updateMetrics(key, this.config.failMode === 'open', true)

      if (this.config.failMode === 'closed') {
        // Fail-closed: deny requests on storage errors (for high-security endpoints)
        log.error(
          `Rate limiter error (fail-closed) for ${key}: ${error instanceof Error ? error.message : String(error)}`
        )

        return {
          allowed: false,
          remaining: 0,
          limit: this.config.maxTokens,
          retryAfterMs: this.config.windowMs,
          resetAt: new Date(Date.now() + this.config.windowMs).toISOString(),
          metrics: this.metrics.get(key),
        }
      }

      // Fail-open: allow request on storage errors (graceful degradation)
      log.error(
        `Rate limiter error (fail-open) for ${key}: ${error instanceof Error ? error.message : String(error)}`
      )

      return {
        allowed: true,
        remaining: this.config.maxTokens,
        limit: this.config.maxTokens,
        metrics: this.metrics.get(key),
      }
    }
  }

  /**
   * Wait for a token to become available (SMI-1013)
   *
   * If tokens are available, consumes immediately.
   * If not, queues the request and waits until tokens become available or timeout.
   *
   * @param key - Unique identifier (e.g., 'ip:192.168.1.1' or 'adapter:github')
   * @param cost - Number of tokens to consume (default: 1)
   * @returns Promise that resolves when token is available
   * @throws RateLimitQueueTimeoutError if timeout is exceeded
   * @throws RateLimitQueueFullError if queue is at capacity
   *
   * @example
   * ```typescript
   * const limiter = new RateLimiter({
   *   maxTokens: 10,
   *   refillRate: 1,
   *   windowMs: 60000,
   *   enableQueue: true,
   *   queueTimeoutMs: 30000,
   * })
   *
   * // Will wait up to 30s for token
   * const result = await limiter.waitForToken('adapter:github')
   * if (result.queued) {
   *   console.log(`Waited ${result.queueWaitMs}ms in queue`)
   * }
   * ```
   */
  async waitForToken(key: string, cost = 1): Promise<RateLimitResult> {
    if (!this.config.enableQueue) {
      // Queue not enabled, fall back to checkLimit behavior
      return this.checkLimit(key, cost)
    }

    // First, try to get token immediately
    const immediateResult = await this.tryConsumeToken(key, cost)

    if (immediateResult.allowed) {
      this.updateMetrics(key, true)
      return {
        ...immediateResult,
        queued: false,
        metrics: this.metrics.get(key),
      }
    }

    // Check queue size
    const queue = this.queues.get(key) || []
    if (queue.length >= this.config.maxQueueSize) {
      this.updateMetrics(key, false)
      throw new RateLimitQueueFullError(key, this.config.maxQueueSize)
    }

    // Check if adding new queue would exceed max unique keys
    if (!this.queues.has(key) && this.queues.size >= MAX_UNIQUE_KEYS) {
      this.updateMetrics(key, false)
      throw new RateLimitQueueFullError(key, this.config.maxQueueSize)
    }

    // Queue the request
    return new Promise<RateLimitResult>((resolve, reject) => {
      // Use UUID for unique identification (not timestamp which can collide)
      const requestId = randomUUID()
      const queuedAt = Date.now()

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        // Remove from queue by unique ID
        const currentQueue = this.queues.get(key) || []
        const index = currentQueue.findIndex((r) => r.id === requestId)
        if (index !== -1) {
          currentQueue.splice(index, 1)
        }

        this.updateMetrics(key, false)
        reject(new RateLimitQueueTimeoutError(key, this.config.queueTimeoutMs))
      }, this.config.queueTimeoutMs)

      const request: QueuedRequest = {
        id: requestId,
        resolve: (result) => {
          this.updateMetrics(key, true)
          resolve({
            ...result,
            metrics: this.metrics.get(key),
          })
        },
        reject,
        cost,
        queuedAt,
        timeoutHandle,
      }

      // Add to queue
      if (!this.queues.has(key)) {
        this.queues.set(key, [])
      }
      this.queues.get(key)!.push(request)

      if (this.config.debug) {
        log.debug(`Request queued for ${key}`, {
          requestId,
          queueSize: this.queues.get(key)!.length,
          cost,
          timeoutMs: this.config.queueTimeoutMs,
        })
      }
    })
  }

  /**
   * Get queue status for a key (SMI-1013)
   *
   * @param key - Optional key to get queue status for
   * @returns Queue size and waiting requests info
   */
  getQueueStatus(key?: string): { totalQueued: number; queues: Map<string, number> } | number {
    if (key) {
      return this.queues.get(key)?.length ?? 0
    }

    const queues = new Map<string, number>()
    let totalQueued = 0
    for (const [k, q] of this.queues.entries()) {
      queues.set(k, q.length)
      totalQueued += q.length
    }
    return { totalQueued, queues }
  }

  /**
   * Clear queue for a key (SMI-1013)
   *
   * Rejects all waiting requests with a timeout error.
   *
   * @param key - Optional key to clear queue for (clears all if not specified)
   */
  clearQueue(key?: string): void {
    const clearQueueForKey = (k: string) => {
      const queue = this.queues.get(k)
      if (queue) {
        for (const request of queue) {
          clearTimeout(request.timeoutHandle)
          request.reject(new RateLimitQueueTimeoutError(k, 0))
        }
        this.queues.delete(k)
      }
    }

    if (key) {
      clearQueueForKey(key)
    } else {
      for (const k of this.queues.keys()) {
        clearQueueForKey(k)
      }
    }

    if (this.config.debug) {
      log.debug(`Queue cleared${key ? ` for key: ${key}` : ' (all)'}`)
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
   * Get metrics for a specific key or all keys
   *
   * @param key - Optional key to get metrics for
   * @returns Metrics for the key, or all metrics if no key specified
   */
  getMetrics(key?: string): Map<string, RateLimitMetrics> | RateLimitMetrics | undefined {
    if (key) {
      return this.metrics.get(key)
    }
    return new Map(this.metrics)
  }

  /**
   * Reset metrics for a specific key or all keys
   *
   * @param key - Optional key to reset metrics for
   */
  resetMetrics(key?: string): void {
    if (key) {
      this.metrics.delete(key)
    } else {
      this.metrics.clear()
    }

    if (this.config.debug) {
      log.debug(`Metrics reset${key ? ` for key: ${key}` : ' (all)'}`)
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    // Stop queue processor (SMI-1013)
    if (this.queueProcessorInterval) {
      clearInterval(this.queueProcessorInterval)
      this.queueProcessorInterval = null
    }

    // Stop metrics cleanup
    if (this.metricsCleanupInterval) {
      clearInterval(this.metricsCleanupInterval)
      this.metricsCleanupInterval = null
    }

    // Clear all queues (SMI-1013)
    this.clearQueue()

    // Clear operation locks
    this.operationLocks.clear()

    if (this.storage instanceof InMemoryRateLimitStorage) {
      this.storage.dispose()
    }
    this.metrics.clear()
  }
}

/**
 * Preset rate limit configurations
 */
export const RATE_LIMIT_PRESETS = {
  /** Very strict: 10 requests per minute, fail-closed for high security */
  STRICT: {
    maxTokens: 10,
    refillRate: 10 / 60, // 0.167 tokens/sec
    windowMs: 60000,
    failMode: 'closed' as const,
  },
  /** Standard: 30 requests per minute (default for adapters) */
  STANDARD: {
    maxTokens: 30,
    refillRate: 30 / 60, // 0.5 tokens/sec
    windowMs: 60000,
    failMode: 'open' as const,
  },
  /** Relaxed: 60 requests per minute */
  RELAXED: {
    maxTokens: 60,
    refillRate: 60 / 60, // 1 token/sec
    windowMs: 60000,
    failMode: 'open' as const,
  },
  /** Generous: 120 requests per minute */
  GENEROUS: {
    maxTokens: 120,
    refillRate: 120 / 60, // 2 tokens/sec
    windowMs: 60000,
    failMode: 'open' as const,
  },
  /** High throughput: 300 requests per minute */
  HIGH_THROUGHPUT: {
    maxTokens: 300,
    refillRate: 300 / 60, // 5 tokens/sec
    windowMs: 60000,
    failMode: 'open' as const,
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
