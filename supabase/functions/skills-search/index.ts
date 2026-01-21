/**
 * GET /v1/skills/search - Search skills with filters
 * @module skills-search
 *
 * SMI-1180: API Development - Wave 3
 * SMI-1613: Anti-scraping protection (min 3 chars, no wildcards)
 *
 * Query Parameters:
 * - query (optional): Search term (min 3 chars if provided; if omitted, at least one filter required)
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

    // Validate: require query OR at least one filter
    const hasQuery = query && query.trim().length > 0
    const hasFilters = category || trustTier || minScore !== null

    if (!hasQuery && !hasFilters) {
      return errorResponse(
        'Provide a search query or at least one filter (category, trust_tier, min_score)',
        400,
        { parameters: { query, category, trust_tier: trustTier, min_score: minScore } }
      )
    }

    // SMI-1613: Anti-scraping protection - require minimum 3 chars when query IS provided
    if (hasQuery && query!.trim().length < 3) {
      return errorResponse('Query must be at least 3 characters', 400, {
        parameter: 'query',
        received: query,
        hint: 'Use specific search terms like "testing", "git", or "docker"',
      })
    }

    // Block wildcard queries explicitly
    if (hasQuery && query!.trim() === '*') {
      return errorResponse(
        'Wildcard queries are not supported. Please use specific search terms.',
        400,
        {
          parameter: 'query',
          received: query,
        }
      )
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

    let results: SearchResult[] = []

    if (hasQuery) {
      // Full-text search path: use search_skills RPC
      const { data: searchResults, error: searchError } = await supabase.rpc('search_skills', {
        search_query: query!.trim(),
        limit_count: limit,
        offset_count: offset,
      })

      if (searchError) {
        console.error('Search error:', searchError)
        return errorResponse('Search failed', 500, { code: searchError.code })
      }

      results = searchResults || []

      // Apply additional filters in-memory for query path
      if (trustTier) {
        results = results.filter((skill) => skill.trust_tier === trustTier)
      }

      if (normalizedMinScore !== null) {
        results = results.filter(
          (skill) => skill.quality_score !== null && skill.quality_score >= normalizedMinScore
        )
      }

      // If category filter is provided with query, join with skill_categories
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
    } else {
      // Filter-only path: query skills table directly
      if (category) {
        // Category requires a join with skill_categories
        let categoryQuery = supabase
          .from('skills')
          .select(
            `
            id, name, description, author, repo_url, quality_score, trust_tier, tags, stars, created_at, updated_at,
            skill_categories!inner(category_id, categories!inner(name))
          `
          )
          .eq('skill_categories.categories.name', category)
          .order('quality_score', { ascending: false, nullsFirst: false })
          .limit(limit)
          .range(offset, offset + limit - 1)

        if (trustTier) {
          categoryQuery = categoryQuery.eq('trust_tier', trustTier)
        }
        if (normalizedMinScore !== null) {
          categoryQuery = categoryQuery.gte('quality_score', normalizedMinScore)
        }

        const { data: categoryResults, error: catError } = await categoryQuery

        if (catError) {
          console.error('Category filter query error:', catError)
          return errorResponse('Filter query failed', 500, { code: catError.code })
        }

        // Map results to remove the nested join data
        results = (categoryResults || []).map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          author: skill.author,
          repo_url: skill.repo_url,
          quality_score: skill.quality_score,
          trust_tier: skill.trust_tier,
          tags: skill.tags,
          stars: skill.stars,
          created_at: skill.created_at,
          updated_at: skill.updated_at,
        }))
      } else {
        // No category filter, simple query with trust_tier and/or min_score
        let queryBuilder = supabase
          .from('skills')
          .select(
            'id, name, description, author, repo_url, quality_score, trust_tier, tags, stars, created_at, updated_at'
          )
          .order('quality_score', { ascending: false, nullsFirst: false })
          .limit(limit)
          .range(offset, offset + limit - 1)

        if (trustTier) {
          queryBuilder = queryBuilder.eq('trust_tier', trustTier)
        }
        if (normalizedMinScore !== null) {
          queryBuilder = queryBuilder.gte('quality_score', normalizedMinScore)
        }

        const { data: filterResults, error: filterError } = await queryBuilder

        if (filterError) {
          console.error('Filter query error:', filterError)
          return errorResponse('Filter query failed', 500, { code: filterError.code })
        }

        results = filterResults || []
      }
    }

    const response = jsonResponse({
      data: results,
      meta: {
        query: hasQuery ? query!.trim() : null,
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
