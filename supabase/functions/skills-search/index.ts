/**
 * GET /v1/skills/search - Search skills with filters
 * @module skills-search
 *
 * SMI-1180: API Development - Wave 3
 *
 * Query Parameters:
 * - query (required): Search term (min 2 characters)
 * - category: Filter by category
 * - trust_tier: Filter by trust level (verified, community, experimental, unknown)
 * - min_score: Minimum quality score (0-100, will be converted to 0-1)
 * - limit: Max results (default 20, max 100)
 * - offset: Pagination offset
 */

import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
  buildCorsHeaders,
} from '../_shared/cors.ts'

import {
  checkRateLimit,
  createRateLimitHeaders,
  rateLimitExceededResponse,
} from '../_shared/rate-limiter.ts'

import {
  createSupabaseClient,
  validatePagination,
  getRequestId,
  logInvocation,
  type SearchResult,
} from '../_shared/supabase.ts'

const VALID_TRUST_TIERS = ['verified', 'community', 'experimental', 'unknown'] as const

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest()
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed', 405)
  }

  const requestId = getRequestId(req.headers)
  const origin = req.headers.get('origin')
  logInvocation('skills-search', requestId)

  // Check rate limit
  const rateLimitResult = await checkRateLimit('skills-search', req)
  if (!rateLimitResult.success) {
    return rateLimitExceededResponse(rateLimitResult, buildCorsHeaders(origin))
  }

  try {
    const url = new URL(req.url)
    const query = url.searchParams.get('query')
    const category = url.searchParams.get('category')
    const trustTier = url.searchParams.get('trust_tier')
    const minScore = url.searchParams.get('min_score')
    const { limit, offset } = validatePagination(
      url.searchParams.get('limit'),
      url.searchParams.get('offset')
    )

    // Validate required query parameter
    if (!query || query.trim().length < 2) {
      return errorResponse('Query parameter required (minimum 2 characters)', 400, {
        parameter: 'query',
        received: query,
      })
    }

    // Validate trust_tier if provided
    if (trustTier && !VALID_TRUST_TIERS.includes(trustTier as (typeof VALID_TRUST_TIERS)[number])) {
      return errorResponse(
        `Invalid trust_tier. Must be one of: ${VALID_TRUST_TIERS.join(', ')}`,
        400,
        {
          parameter: 'trust_tier',
          received: trustTier,
          allowed: VALID_TRUST_TIERS,
        }
      )
    }

    // Validate min_score if provided
    let normalizedMinScore: number | null = null
    if (minScore !== null) {
      const parsedScore = Number(minScore)
      if (isNaN(parsedScore) || parsedScore < 0 || parsedScore > 100) {
        return errorResponse('min_score must be a number between 0 and 100', 400, {
          parameter: 'min_score',
          received: minScore,
        })
      }
      // Convert 0-100 scale to 0-1 for database
      normalizedMinScore = parsedScore / 100
    }

    const supabase = createSupabaseClient(req.headers.get('authorization') ?? undefined)

    // Use the search_skills function for full-text search
    const { data: searchResults, error: searchError } = await supabase.rpc('search_skills', {
      search_query: query.trim(),
      limit_count: limit,
      offset_count: offset,
    })

    if (searchError) {
      console.error('Search error:', searchError)
      return errorResponse('Search failed', 500, { code: searchError.code })
    }

    let results: SearchResult[] = searchResults || []

    // Apply additional filters in-memory (could be optimized with a custom RPC)
    if (trustTier) {
      results = results.filter((skill) => skill.trust_tier === trustTier)
    }

    if (normalizedMinScore !== null) {
      results = results.filter(
        (skill) => skill.quality_score !== null && skill.quality_score >= normalizedMinScore
      )
    }

    // If category filter is provided, join with skill_categories
    if (category) {
      const skillIds = results.map((r) => r.id)
      if (skillIds.length > 0) {
        const { data: categoryData } = await supabase
          .from('skill_categories')
          .select('skill_id, categories!inner(name)')
          .in('skill_id', skillIds)
          .eq('categories.name', category)

        if (categoryData) {
          const matchingIds = new Set(categoryData.map((c) => c.skill_id))
          results = results.filter((skill) => matchingIds.has(skill.id))
        } else {
          results = []
        }
      }
    }

    const response = jsonResponse({
      data: results,
      meta: {
        query: query.trim(),
        total: results.length,
        limit,
        offset,
        filters: {
          category: category || null,
          trust_tier: trustTier || null,
          min_score: minScore ? Number(minScore) : null,
        },
      },
    })

    // Add rate limit and CORS headers
    const headers = new Headers(response.headers)
    Object.entries(createRateLimitHeaders(rateLimitResult)).forEach(([key, value]) => {
      headers.set(key, value)
    })
    Object.entries(buildCorsHeaders(origin)).forEach(([key, value]) => {
      headers.set(key, value)
    })
    headers.set('X-Request-ID', requestId)

    return new Response(response.body, {
      status: response.status,
      headers,
    })
  } catch (error) {
    console.error('Unexpected error:', error)
    return errorResponse('Internal server error', 500, {
      request_id: requestId,
    })
  }
})
