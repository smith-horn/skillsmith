/**
 * GET /v1/stats - Get platform statistics
 * @module stats
 *
 * SMI-1550: Display live skill count from database
 *
 * Returns:
 * - skillCount: Total number of published skills
 * - lastUpdated: ISO timestamp of last update
 *
 * Response is cached for 5 minutes to reduce database load.
 */

import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'

import { createSupabaseClient, getRequestId, logInvocation } from '../_shared/supabase.ts'

// Cache duration in seconds (5 minutes)
const CACHE_TTL_SECONDS = 300

// In-memory cache for stats
let cachedStats: { skillCount: number; lastUpdated: string } | null = null
let cacheExpiry = 0

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin')

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest(origin)
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed', 405)
  }

  const requestId = getRequestId(req.headers)
  logInvocation('stats', requestId)

  try {
    const now = Date.now()

    // Return cached response if valid
    if (cachedStats && now < cacheExpiry) {
      const jsonRes = jsonResponse({
        data: cachedStats,
        cached: true,
      })

      const headers = new Headers(jsonRes.headers)
      Object.entries(buildCorsHeaders(origin)).forEach(([key, value]) => {
        headers.set(key, value)
      })
      headers.set('X-Request-ID', requestId)
      headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`)

      return new Response(jsonRes.body, {
        status: jsonRes.status,
        headers,
      })
    }

    const supabase = createSupabaseClient()

    // Get total skill count
    const { count, error } = await supabase
      .from('skills')
      .select('*', { count: 'exact', head: true })

    if (error) {
      console.error('Database error:', error)
      return errorResponse('Failed to retrieve stats', 500, {
        code: error.code,
      })
    }

    // Update cache
    cachedStats = {
      skillCount: count ?? 0,
      lastUpdated: new Date().toISOString(),
    }
    cacheExpiry = now + CACHE_TTL_SECONDS * 1000

    const jsonRes = jsonResponse({
      data: cachedStats,
      cached: false,
    })

    const headers = new Headers(jsonRes.headers)
    Object.entries(buildCorsHeaders(origin)).forEach(([key, value]) => {
      headers.set(key, value)
    })
    headers.set('X-Request-ID', requestId)
    headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`)

    return new Response(jsonRes.body, {
      status: jsonRes.status,
      headers,
    })
  } catch (error) {
    console.error('Unexpected error:', error)
    return errorResponse('Internal server error', 500, {
      request_id: requestId,
    })
  }
})
