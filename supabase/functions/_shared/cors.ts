/**
 * CORS headers for Supabase Edge Functions
 * @module _shared/cors
 *
 * SMI-1180: API Development - Wave 3
 * SMI-1230: Production CORS configuration
 * SMI-1269: CORS documentation
 * SMI-1904: Dynamic CORS configuration with Vercel pattern matching
 *
 * @see scripts/supabase/DEPLOYMENT.md for configuration guide
 *
 * Configuration:
 * - Set CORS_ALLOWED_ORIGINS env var for additional origins (comma-separated)
 * - Vercel preview URLs (*.vercel.app) are auto-allowed for our org
 * - Default origins always included (skillsmith.app, localhost)
 */

/**
 * Default allowed origins (always included)
 */
const DEFAULT_ORIGINS = [
  // Production domains
  'https://skillsmith.app',
  'https://www.skillsmith.app',
  'https://skillsmith.dev',
  'https://www.skillsmith.dev',
  'https://app.skillsmith.dev',
  'https://api.skillsmith.dev',
  // Vercel production frontend (from CLAUDE.md)
  'https://frontend-nine-bice-67.vercel.app',
  // Localhost for development
  'http://localhost:3000',
  'http://localhost:4321',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4321',
  'http://127.0.0.1:5173',
]

/**
 * Additional origins from environment variable (comma-separated)
 */
const ENV_ORIGINS: string[] = (() => {
  const envOrigins = Deno.env.get('CORS_ALLOWED_ORIGINS')
  if (envOrigins) {
    return envOrigins
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  }
  return []
})()

/**
 * Combined allowed origins list (defaults + env)
 */
const ALLOWED_ORIGINS = [...DEFAULT_ORIGINS, ...ENV_ORIGINS]

/**
 * Vercel preview URL pattern
 * Matches: https://<project>-<hash>-<org>.vercel.app
 * Only allows our organization's preview deployments
 */
const VERCEL_PREVIEW_PATTERN = /^https:\/\/[a-z0-9-]+-smithhorngroup\.vercel\.app$/

/**
 * Check if origin is allowed
 * SMI-1904: Enhanced with Vercel preview pattern matching
 *
 * @param origin - Request origin header
 * @returns True if origin is allowed
 */
export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false

  // In development mode (local Supabase), allow all origins
  const isDev =
    Deno.env.get('SUPABASE_URL')?.includes('localhost') ||
    Deno.env.get('SUPABASE_URL')?.includes('127.0.0.1')
  if (isDev) return true

  // Check explicit allowlist (defaults + env origins)
  if (ALLOWED_ORIGINS.includes(origin)) return true

  // Check Vercel preview pattern (auto-allow our org's preview deployments)
  if (VERCEL_PREVIEW_PATTERN.test(origin)) return true

  return false
}

/**
 * Get CORS origin header value
 * Returns the origin if allowed, otherwise null
 * @param origin - Request origin header
 * @returns Allowed origin or null
 */
export function getCorsOrigin(origin: string | null): string | null {
  if (isOriginAllowed(origin)) {
    return origin
  }
  return null
}

/**
 * Build CORS headers for a specific origin
 * @param origin - Request origin (or null)
 * @returns CORS headers object
 */
export function buildCorsHeaders(origin: string | null): Record<string, string> {
  const corsOrigin = getCorsOrigin(origin)
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-request-id, x-api-key',
    'Access-Control-Max-Age': '86400',
  }

  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin
    headers['Vary'] = 'Origin'
  }

  return headers
}

/**
 * Handle CORS preflight requests
 * @param origin - Request origin header (for production CORS)
 * @returns Response for OPTIONS requests
 */
export function handleCorsPreflightRequest(origin?: string | null): Response {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(origin ?? null),
  })
}

/**
 * Add CORS headers to a JSON response
 * @param data - Response data to serialize
 * @param status - HTTP status code
 * @param origin - Request origin for CORS (optional, defaults to permissive for dev)
 * @returns Response with CORS headers
 */
export function jsonResponse<T>(data: T, status = 200, origin?: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...buildCorsHeaders(origin ?? null),
      'Content-Type': 'application/json',
    },
  })
}

/**
 * Create an error response with CORS headers
 * @param message - Error message
 * @param status - HTTP status code
 * @param details - Optional error details
 * @param origin - Request origin for CORS (optional)
 * @returns Error response with CORS headers
 */
export function errorResponse(
  message: string,
  status = 400,
  details?: Record<string, unknown>,
  origin?: string | null
): Response {
  const body: { error: string; details?: Record<string, unknown> } = {
    error: message,
  }

  if (details) {
    body.details = details
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...buildCorsHeaders(origin ?? null),
      'Content-Type': 'application/json',
    },
  })
}

/**
 * Add rate limiting headers to response
 * @param remaining - Remaining requests in window
 * @param resetTime - Unix timestamp when limit resets
 * @returns Headers object with rate limit info
 */
export function rateLimitHeaders(remaining: number, resetTime: number): Record<string, string> {
  return {
    'X-RateLimit-Limit': '100',
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
    'X-RateLimit-Reset': String(resetTime),
  }
}
