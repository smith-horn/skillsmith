/**
 * Token Bucket Core Logic - SMI-730, SMI-1189
 *
 * Core token bucket algorithm implementation for rate limiting.
 */

import type { TokenBucket, RateLimitResult, RateLimitStorage } from './types.js'

/**
 * Configuration for token bucket operations
 */
export interface TokenBucketConfig {
  maxTokens: number
  refillRate: number
  windowMs: number
  keyPrefix: string
  failMode: 'open' | 'closed'
}

/**
 * Try to consume tokens from a bucket (internal helper)
 *
 * @param storage - Storage for token buckets
 * @param config - Token bucket configuration
 * @param key - Rate limit key
 * @param cost - Number of tokens to consume
 * @returns Rate limit result
 */
export async function tryConsumeToken(
  storage: RateLimitStorage,
  config: TokenBucketConfig,
  key: string,
  cost: number
): Promise<RateLimitResult> {
  const storageKey = `${config.keyPrefix}:${key}`
  const now = Date.now()

  try {
    let bucket = await storage.get(storageKey)

    if (!bucket) {
      bucket = {
        tokens: config.maxTokens,
        lastRefill: now,
        firstRequest: now,
      }
    }

    // Refill tokens based on elapsed time
    const elapsedMs = now - bucket.lastRefill
    const elapsedSeconds = elapsedMs / 1000
    const tokensToAdd = elapsedSeconds * config.refillRate

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(config.maxTokens, bucket.tokens + tokensToAdd)
      bucket.lastRefill = now
    }

    // Check if we have enough tokens
    const allowed = bucket.tokens >= cost

    if (allowed) {
      bucket.tokens -= cost
      await storage.set(storageKey, bucket, config.windowMs)

      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit: config.maxTokens,
      }
    } else {
      const tokensNeeded = cost - bucket.tokens
      const retryAfterMs = Math.ceil((tokensNeeded / config.refillRate) * 1000)
      const resetAt = new Date(now + retryAfterMs).toISOString()

      return {
        allowed: false,
        remaining: Math.floor(bucket.tokens),
        limit: config.maxTokens,
        retryAfterMs,
        resetAt,
      }
    }
  } catch {
    // On error, return based on fail mode
    if (config.failMode === 'closed') {
      return {
        allowed: false,
        remaining: 0,
        limit: config.maxTokens,
        retryAfterMs: config.windowMs,
      }
    }
    return {
      allowed: true,
      remaining: config.maxTokens,
      limit: config.maxTokens,
    }
  }
}

/**
 * Get the current state of a token bucket
 *
 * @param storage - Storage for token buckets
 * @param keyPrefix - Key prefix for storage
 * @param key - Rate limit key
 * @returns Current bucket state or null
 */
export async function getTokenBucketState(
  storage: RateLimitStorage,
  keyPrefix: string,
  key: string
): Promise<TokenBucket | null> {
  const storageKey = `${keyPrefix}:${key}`
  return await storage.get(storageKey)
}

/**
 * Reset a token bucket
 *
 * @param storage - Storage for token buckets
 * @param keyPrefix - Key prefix for storage
 * @param key - Rate limit key
 */
export async function resetTokenBucket(
  storage: RateLimitStorage,
  keyPrefix: string,
  key: string
): Promise<void> {
  const storageKey = `${keyPrefix}:${key}`
  await storage.delete(storageKey)
}
