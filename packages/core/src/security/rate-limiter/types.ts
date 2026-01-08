/**
 * Rate Limiter Types - SMI-730, SMI-1013, SMI-1189
 *
 * Type definitions for rate limiting functionality.
 */

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
export interface TokenBucket {
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
export interface QueuedRequest {
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
 * Storage interface for rate limit data
 */
export interface RateLimitStorage {
  get(key: string): Promise<TokenBucket | null>
  set(key: string, value: TokenBucket, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
  clear?(): Promise<void>
}
