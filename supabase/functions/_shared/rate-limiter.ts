/**
 * Rate Limiter using Upstash Redis with in-memory fallback
 * @module _shared/rate-limiter
 *
 * SMI-1231: Implement Redis-based rate limiting
 * SMI-1259: Implement fail-closed or fallback rate limiter
 *
 * Configuration via environment variables:
 * - UPSTASH_REDIS_REST_URL: Upstash Redis REST URL
 * - UPSTASH_REDIS_REST_TOKEN: Upstash Redis REST token
 * - RATE_LIMIT_FAIL_CLOSED: If "true", reject all requests when Redis fails
 *                           If not set or "false", use in-memory fallback
 */

import { Redis } from 'https://esm.sh/@upstash/redis@1.28.0'
import { Ratelimit } from 'https://esm.sh/@upstash/ratelimit@1.0.1'

/**
 * In-memory rate limit entry
 */
interface InMemoryLimitEntry {
  /** Request count in current window */
  count: number
  /** Unix timestamp (ms) when the window resets */
  resetAt: number
}

/**
 * In-memory rate limit storage
 * Used as fallback when Redis is unavailable
 */
const inMemoryLimits = new Map<string, InMemoryLimitEntry>()

/**
 * Cleanup interval for expired entries (5 minutes)
 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

/**
 * Last cleanup timestamp
 */
let lastCleanup = Date.now()

/**
 * Rate limit configuration per endpoint
 */
export interface RateLimitConfig {
  /** Requests allowed per window */
  requests: number
  /** Window duration in seconds */
  windowSeconds: number
}

/**
 * Rate limit result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  success: boolean
  /** Remaining requests in window */
  remaining: number
  /** Unix timestamp when limit resets */
  reset: number
  /** Maximum requests allowed */
  limit: number
}

/**
 * Default rate limits per endpoint
 */
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'skills-search': { requests: 100, windowSeconds: 60 },
  'skills-get': { requests: 100, windowSeconds: 60 },
  'skills-recommend': { requests: 50, windowSeconds: 60 },
  events: { requests: 200, windowSeconds: 60 },
}

/**
 * Check if Upstash Redis is configured
 */
export function isRedisConfigured(): boolean {
  return !!(Deno.env.get('UPSTASH_REDIS_REST_URL') && Deno.env.get('UPSTASH_REDIS_REST_TOKEN'))
}

/**
 * Create Upstash Redis client
 * Returns null if not configured
 */
function createRedisClient(): Redis | null {
  const url = Deno.env.get('UPSTASH_REDIS_REST_URL')
  const token = Deno.env.get('UPSTASH_REDIS_REST_TOKEN')

  if (!url || !token) {
    return null
  }

  return new Redis({ url, token })
}

/**
 * Create rate limiter for an endpoint
 * @param endpoint - Endpoint name (e.g., 'skills-search')
 * @returns Ratelimit instance or null if Redis not configured
 */
function createRateLimiter(endpoint: string): Ratelimit | null {
  const redis = createRedisClient()
  if (!redis) return null

  const config = RATE_LIMITS[endpoint] || { requests: 100, windowSeconds: 60 }

  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(config.requests, `${config.windowSeconds}s`),
    prefix: `skillsmith:ratelimit:${endpoint}`,
    analytics: true,
  })
}

/**
 * Extract client identifier from request
 * Uses IP address or X-Forwarded-For header
 * @param req - Request object
 * @returns Client identifier string
 */
export function getClientIdentifier(req: Request): string {
  // Check X-Forwarded-For for proxied requests
  const forwardedFor = req.headers.get('x-forwarded-for')
  if (forwardedFor) {
    // Take the first IP in the chain (original client)
    return forwardedFor.split(',')[0].trim()
  }

  // Check X-Real-IP
  const realIp = req.headers.get('x-real-ip')
  if (realIp) {
    return realIp
  }

  // Check CF-Connecting-IP (Cloudflare)
  const cfIp = req.headers.get('cf-connecting-ip')
  if (cfIp) {
    return cfIp
  }

  // Fallback to a hash of the user agent + some request properties
  const ua = req.headers.get('user-agent') || 'unknown'
  return `anonymous:${hashString(ua)}`
}

/**
 * Simple string hash function
 */
function hashString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16)
}

/**
 * Check if fail-closed mode is enabled
 * When enabled, requests are rejected if Redis is unavailable
 * @returns true if RATE_LIMIT_FAIL_CLOSED is set to "true"
 */
function isFailClosedMode(): boolean {
  return Deno.env.get('RATE_LIMIT_FAIL_CLOSED') === 'true'
}

/**
 * Cleanup expired entries from in-memory storage
 * Called periodically to prevent memory leaks
 */
function cleanupExpiredEntries(): void {
  const now = Date.now()

  // Only cleanup every CLEANUP_INTERVAL_MS
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) {
    return
  }

  lastCleanup = now

  for (const [key, entry] of inMemoryLimits.entries()) {
    if (entry.resetAt < now) {
      inMemoryLimits.delete(key)
    }
  }
}

/**
 * Check rate limit using in-memory storage
 * Used as fallback when Redis is unavailable
 * @param endpoint - Endpoint name
 * @param identifier - Client identifier
 * @param config - Rate limit configuration
 * @returns Rate limit result
 */
function checkInMemoryLimit(
  endpoint: string,
  identifier: string,
  config: RateLimitConfig
): RateLimitResult {
  // Periodically cleanup expired entries
  cleanupExpiredEntries()

  const now = Date.now()
  const windowMs = config.windowSeconds * 1000
  const key = `skillsmith:ratelimit:${endpoint}:${identifier}`
  const entry = inMemoryLimits.get(key)

  // If no entry or window expired, start fresh
  if (!entry || entry.resetAt < now) {
    const resetAt = now + windowMs
    inMemoryLimits.set(key, { count: 1, resetAt })
    return {
      success: true,
      remaining: config.requests - 1,
      reset: Math.floor(resetAt / 1000),
      limit: config.requests,
    }
  }

  // Check if limit exceeded
  if (entry.count >= config.requests) {
    return {
      success: false,
      remaining: 0,
      reset: Math.floor(entry.resetAt / 1000),
      limit: config.requests,
    }
  }

  // Increment count and allow request
  entry.count++
  return {
    success: true,
    remaining: config.requests - entry.count,
    reset: Math.floor(entry.resetAt / 1000),
    limit: config.requests,
  }
}

/**
 * Create a fail-closed rate limit result
 * Used when Redis is unavailable and fail-closed mode is enabled
 * @param config - Rate limit configuration
 * @returns Rate limit result indicating request is blocked
 */
function createFailClosedResult(config: RateLimitConfig): RateLimitResult {
  const resetTime = Math.floor(Date.now() / 1000) + config.windowSeconds
  return {
    success: false,
    remaining: 0,
    reset: resetTime,
    limit: config.requests,
  }
}

/**
 * Clear all in-memory rate limit entries
 * Useful for testing or manual reset
 */
export function clearInMemoryLimits(): void {
  inMemoryLimits.clear()
}

/**
 * Get the current size of the in-memory rate limit storage
 * Useful for monitoring and debugging
 * @returns Number of entries in the in-memory storage
 */
export function getInMemoryLimitCount(): number {
  return inMemoryLimits.size
}

/**
 * Check if the rate limiter is using fail-closed mode
 * @returns true if RATE_LIMIT_FAIL_CLOSED is enabled
 */
export function isUsingFailClosedMode(): boolean {
  return isFailClosedMode()
}

/**
 * Check rate limit for a request
 *
 * Behavior when Redis is unavailable:
 * - RATE_LIMIT_FAIL_CLOSED=true: Reject all requests (fail-closed)
 * - RATE_LIMIT_FAIL_CLOSED=false or not set: Use in-memory fallback
 *
 * @param endpoint - Endpoint name
 * @param req - Request object
 * @returns Rate limit result
 */
export async function checkRateLimit(endpoint: string, req: Request): Promise<RateLimitResult> {
  const config = RATE_LIMITS[endpoint] || { requests: 100, windowSeconds: 60 }
  const identifier = getClientIdentifier(req)
  const failClosed = isFailClosedMode()

  // If Redis is not configured, use fallback strategy
  if (!isRedisConfigured()) {
    console.warn('Redis not configured for rate limiting, using fallback strategy')
    if (failClosed) {
      console.warn('Fail-closed mode: rejecting request due to missing Redis')
      return createFailClosedResult(config)
    }
    // Use in-memory fallback instead of allowing all requests
    return checkInMemoryLimit(endpoint, identifier, config)
  }

  const rateLimiter = createRateLimiter(endpoint)
  if (!rateLimiter) {
    // Rate limiter creation failed, use fallback strategy
    console.error('Failed to create rate limiter, using fallback strategy')
    if (failClosed) {
      console.warn('Fail-closed mode: rejecting request due to rate limiter creation failure')
      return createFailClosedResult(config)
    }
    // Use in-memory fallback instead of allowing all requests
    return checkInMemoryLimit(endpoint, identifier, config)
  }

  try {
    const result = await rateLimiter.limit(identifier)

    return {
      success: result.success,
      remaining: result.remaining,
      reset: result.reset,
      limit: result.limit,
    }
  } catch (error) {
    // Redis operation failed, use fallback strategy
    console.error('Rate limit check failed:', error)
    if (failClosed) {
      console.warn('Fail-closed mode: rejecting request due to Redis error')
      return createFailClosedResult(config)
    }
    // Use in-memory fallback instead of allowing all requests
    console.warn('Using in-memory fallback due to Redis error')
    return checkInMemoryLimit(endpoint, identifier, config)
  }
}

/**
 * Create rate limit headers from result
 * @param result - Rate limit result
 * @returns Headers object
 */
export function createRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(Math.max(0, result.remaining)),
    'X-RateLimit-Reset': String(result.reset),
  }
}

/**
 * Create rate limit exceeded response
 * @param result - Rate limit result
 * @param corsHeaders - CORS headers to include
 * @returns 429 Too Many Requests response
 */
export function rateLimitExceededResponse(
  result: RateLimitResult,
  corsHeaders: Record<string, string>
): Response {
  const retryAfter = Math.max(0, result.reset - Math.floor(Date.now() / 1000))

  return new Response(
    JSON.stringify({
      error: 'Rate limit exceeded',
      details: {
        limit: result.limit,
        remaining: result.remaining,
        reset: result.reset,
        retry_after: retryAfter,
      },
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        ...createRateLimitHeaders(result),
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    }
  )
}
