/**
 * Rate Limiter Presets - SMI-730, SMI-1189
 *
 * Pre-configured rate limit settings for common use cases.
 */

import type { RateLimitStorage } from './types.js'
import { RateLimiter } from './RateLimiter.js'

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
