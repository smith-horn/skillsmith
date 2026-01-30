/**
 * Authentication Middleware
 * @module _shared/auth-middleware
 *
 * SMI-54: Extract auth middleware to reduce code duplication
 * SMI-55: Tier-aware rate limiting using authResult.rateLimit
 *
 * Combines authentication, trial limit, and rate limit checks
 * into a single middleware function.
 */

import { buildCorsHeaders } from './cors.ts'
import { authenticateRequest, type AuthResult } from './api-key-auth.ts'
import { checkTrialLimit, trialExceededResponse, type TrialResult } from './trial-limiter.ts'
import {
  checkRateLimit,
  createRateLimitHeaders,
  rateLimitExceededResponse,
  type RateLimitResult,
} from './rate-limiter.ts'

/**
 * Default rate limits per tier (requests per minute)
 */
const TIER_RATE_LIMITS: Record<string, number> = {
  trial: 100, // Unauthenticated
  community: 30,
  individual: 60,
  team: 120,
  enterprise: 300,
}

/**
 * Result of running authentication middleware
 */
export interface AuthMiddlewareResult {
  /** Authentication result (always present) */
  authResult: AuthResult
  /** Trial result (only for unauthenticated users) */
  trialResult?: TrialResult
  /** Rate limit result (always present when earlyResponse is null) */
  rateLimitResult?: RateLimitResult
  /** Early response to return if auth/trial/rate limit failed */
  earlyResponse: Response | null
}

/**
 * Run authentication middleware
 *
 * Performs the following checks in order:
 * 1. API key authentication
 * 2. Trial limit check (for unauthenticated users)
 * 3. Rate limit check (tier-aware for authenticated users)
 *
 * If any check fails, returns an early response to send to the client.
 *
 * @param req - The incoming request
 * @param endpoint - Endpoint name for rate limiting (e.g., 'skills-search')
 * @param origin - CORS origin header (for error responses)
 * @returns Middleware result with auth context or early response
 */
export async function runAuthMiddleware(
  req: Request,
  endpoint: string,
  origin: string | null
): Promise<AuthMiddlewareResult> {
  // Step 1: Check API key authentication
  const authResult = await authenticateRequest(req)

  // Step 2: If not authenticated, check trial limit
  let trialResult: TrialResult | undefined
  if (!authResult.authenticated) {
    trialResult = await checkTrialLimit(req)
    if (!trialResult.allowed) {
      return {
        authResult,
        trialResult,
        earlyResponse: trialExceededResponse(trialResult, origin),
      }
    }
  }

  // Step 3: Check rate limit (tier-aware)
  // SMI-55: Use tier-specific limits and track by API key for authenticated users
  const rateLimitOptions = authResult.authenticated
    ? {
        customLimit: authResult.rateLimit || TIER_RATE_LIMITS[authResult.tier || 'community'],
        keyPrefix: authResult.keyPrefix,
      }
    : {
        customLimit: TIER_RATE_LIMITS.trial,
      }

  const rateLimitResult = await checkRateLimit(endpoint, req, rateLimitOptions)

  if (!rateLimitResult.success) {
    return {
      authResult,
      trialResult,
      rateLimitResult,
      earlyResponse: rateLimitExceededResponse(rateLimitResult, buildCorsHeaders(origin)),
    }
  }

  // All checks passed
  return {
    authResult,
    trialResult,
    rateLimitResult,
    earlyResponse: null,
  }
}

/**
 * Add authentication headers to a response
 *
 * Adds X-Authenticated, X-Tier, X-Trial-Remaining, and rate limit headers.
 *
 * @param headers - Headers object to modify
 * @param middlewareResult - Result from runAuthMiddleware
 */
export function addAuthHeaders(headers: Headers, middlewareResult: AuthMiddlewareResult): void {
  const { authResult, trialResult, rateLimitResult } = middlewareResult

  // Add auth-related headers
  if (authResult.authenticated) {
    headers.set('X-Authenticated', 'true')
    headers.set('X-Tier', authResult.tier || 'community')
  } else if (trialResult) {
    headers.set('X-Trial-Remaining', String(trialResult.remaining))
  }

  // Add rate limit headers
  if (rateLimitResult) {
    Object.entries(createRateLimitHeaders(rateLimitResult)).forEach(([key, value]) => {
      headers.set(key, value)
    })
  }
}

/**
 * Get the effective rate limit for a tier
 *
 * @param tier - User tier or undefined for trial
 * @returns Rate limit per minute
 */
export function getTierRateLimit(tier?: string): number {
  if (!tier) return TIER_RATE_LIMITS.trial
  return TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS.community
}

// Re-export types for convenience
export type { AuthResult } from './api-key-auth.ts'
export type { TrialResult } from './trial-limiter.ts'
export type { RateLimitResult } from './rate-limiter.ts'
