/**
 * Trial Limiter for unauthenticated API requests
 * @module _shared/trial-limiter
 *
 * SMI-XXXX: API Key Authentication
 *
 * Tracks trial usage per IP hash. Users get 100 requests TOTAL
 * before requiring authentication.
 */

import { createSupabaseAdminClient } from './supabase.ts'
import { errorResponse } from './cors.ts'

/** Trial limit: 100 requests TOTAL (not per day) */
const TRIAL_LIMIT = 100

/** Default salt value (used when TRIAL_SALT env var is not set) */
const DEFAULT_TRIAL_SALT = 'skillsmith-trial-2026'

/**
 * Salt for IP hashing
 * SMI-56: Log warning when falling back to default salt
 */
const TRIAL_SALT =
  Deno.env.get('TRIAL_SALT') ||
  (() => {
    console.warn(
      '[trial-limiter] TRIAL_SALT environment variable not set, using default. ' +
        'Set TRIAL_SALT in production for improved security.'
    )
    return DEFAULT_TRIAL_SALT
  })()

/**
 * Trial check result
 */
export interface TrialResult {
  /** Whether this request is allowed */
  allowed: boolean
  /** Number of requests used */
  used: number
  /** Remaining requests */
  remaining: number
}

/**
 * Hash an IP address for privacy
 * Uses SHA-256 with a salt
 */
async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(ip + TRIAL_SALT)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  // Return first 32 chars (128 bits) for reasonable uniqueness
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 32)
}

/**
 * Extract client IP from request headers
 */
function getClientIP(req: Request): string {
  // Check common proxy headers in order of reliability
  const forwardedFor = req.headers.get('x-forwarded-for')
  if (forwardedFor) {
    // Take the first IP (original client)
    return forwardedFor.split(',')[0].trim()
  }

  const realIp = req.headers.get('x-real-ip')
  if (realIp) {
    return realIp
  }

  const cfIp = req.headers.get('cf-connecting-ip')
  if (cfIp) {
    return cfIp
  }

  // Fallback
  return 'unknown'
}

/**
 * Check if a request is within trial limits
 *
 * @param req - The incoming request
 * @returns Trial check result with allowed status and usage counts
 */
export async function checkTrialLimit(req: Request): Promise<TrialResult> {
  const ip = getClientIP(req)
  const ipHash = await hashIP(ip)

  try {
    const adminClient = createSupabaseAdminClient()
    const { data, error } = await adminClient.rpc('check_trial_usage', {
      ip_hash_input: ipHash,
    })

    if (error) {
      console.error('Trial limit check failed:', error)
      // On error, be permissive (don't block users due to DB issues)
      return { allowed: true, used: 0, remaining: TRIAL_LIMIT }
    }

    if (!data || data.length === 0) {
      // No data returned, be permissive
      return { allowed: true, used: 0, remaining: TRIAL_LIMIT }
    }

    // RPC returns an array, take first row
    const result = Array.isArray(data) ? data[0] : data
    return {
      allowed: result.allowed,
      used: result.used,
      remaining: result.remaining,
    }
  } catch (err) {
    console.error('Trial limit check exception:', err)
    // On exception, be permissive
    return { allowed: true, used: 0, remaining: TRIAL_LIMIT }
  }
}

/**
 * Create a 401 response for trial limit exceeded
 *
 * @param result - The trial result
 * @param origin - CORS origin header
 * @returns Response with authentication required error
 */
export function trialExceededResponse(result: TrialResult, origin?: string | null): Response {
  return errorResponse(
    'Authentication required',
    401,
    {
      reason: `Free trial exhausted (${result.used} requests)`,
      signupUrl: 'https://skillsmith.app/signup',
      docsUrl: 'https://skillsmith.app/docs/getting-started#api-key',
      hint: 'Create a free account for 1,000 requests/month. Your API key will be generated automatically.',
      trialUsed: result.used,
      trialLimit: TRIAL_LIMIT,
    },
    origin
  )
}

/**
 * Get the trial limit constant
 */
export function getTrialLimit(): number {
  return TRIAL_LIMIT
}
