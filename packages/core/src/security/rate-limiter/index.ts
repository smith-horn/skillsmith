/**
 * Rate Limiter Module - SMI-730, SMI-1013, SMI-1189
 *
 * Re-exports for rate limiting functionality.
 */

// Types
export type {
  RateLimitConfig,
  RateLimitMetrics,
  RateLimitResult,
  RateLimitStorage,
  TokenBucket,
  QueuedRequest,
} from './types.js'

// Constants
export { MAX_UNIQUE_KEYS, METRICS_TTL_MS } from './constants.js'

// Errors
export { RateLimitQueueTimeoutError, RateLimitQueueFullError } from './errors.js'

// Storage
export { InMemoryRateLimitStorage } from './storage.js'

// Main class
export { RateLimiter } from './RateLimiter.js'

// Presets
export { RATE_LIMIT_PRESETS, createRateLimiterFromPreset } from './presets.js'
