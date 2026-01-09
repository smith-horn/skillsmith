/**
 * POST /v1/skills/recommend - Get skill recommendations
 * @module skills-recommend
 *
 * SMI-1180: API Development - Wave 3
 *
 * Request Body:
 * - stack (required): Array of technology names (e.g., ["react", "typescript"])
 * - project_type (optional): Type of project (e.g., "web", "api", "cli")
 * - limit (optional): Max recommendations (default 10, max 50)
 *
 * Returns:
 * - Array of recommended skills sorted by relevance
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
  getRequestId,
  logInvocation,
  sanitizeFilterInput,
  isValidFilterInput,
  type Skill,
} from '../_shared/supabase.ts'

interface RecommendRequest {
  stack: string[]
  project_type?: string
  limit?: number
}

/**
 * Map project types to relevant categories
 */
const PROJECT_TYPE_CATEGORIES: Record<string, string[]> = {
  web: ['Development', 'Testing', 'DevOps'],
  api: ['Development', 'Testing', 'Security', 'Documentation'],
  cli: ['Development', 'DevOps'],
  mobile: ['Development', 'Testing'],
  data: ['Development', 'Testing', 'Documentation'],
  ml: ['Development', 'Testing', 'Documentation'],
}

/**
 * Calculate relevance score based on stack match
 */
function calculateRelevance(skill: Skill, stack: string[]): number {
  const stackLower = stack.map((s) => s.toLowerCase())
  let score = 0

  // Check tags match
  const tags = Array.isArray(skill.tags) ? skill.tags : []
  for (const tag of tags) {
    const tagLower = String(tag).toLowerCase()
    if (stackLower.some((s) => tagLower.includes(s) || s.includes(tagLower))) {
      score += 20
    }
  }

  // Check name/description match
  const nameLower = skill.name.toLowerCase()
  const descLower = (skill.description || '').toLowerCase()
  for (const tech of stackLower) {
    if (nameLower.includes(tech)) score += 15
    if (descLower.includes(tech)) score += 5
  }

  // Boost by quality score
  if (skill.quality_score) {
    score += skill.quality_score * 30
  }

  // Boost verified skills
  if (skill.trust_tier === 'verified') score += 10
  if (skill.trust_tier === 'community') score += 5

  // Boost by stars
  if (skill.stars) {
    score += Math.min(skill.stars / 100, 10)
  }

  return score
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCorsPreflightRequest()
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  const requestId = getRequestId(req.headers)
  const origin = req.headers.get('origin')
  logInvocation('skills-recommend', requestId)

  // Check rate limit
  const rateLimitResult = await checkRateLimit('skills-recommend', req)
  if (!rateLimitResult.success) {
    return rateLimitExceededResponse(rateLimitResult, buildCorsHeaders(origin))
  }

  try {
    // Parse request body
    let body: RecommendRequest
    try {
      body = await req.json()
    } catch {
      return errorResponse('Invalid JSON body', 400)
    }

    // Validate stack
    if (!body.stack || !Array.isArray(body.stack) || body.stack.length === 0) {
      return errorResponse('stack is required and must be a non-empty array', 400, {
        parameter: 'stack',
        received: body.stack,
      })
    }

    // Validate and sanitize stack items
    // Filter for valid strings and sanitize to prevent filter injection
    const validStack = body.stack
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => sanitizeFilterInput(item.trim()))
      .filter((item) => item.length > 0 && isValidFilterInput(item))

    if (validStack.length === 0) {
      return errorResponse('stack must contain valid string values (alphanumeric only)', 400)
    }

    // Limit stack size to prevent DoS
    if (validStack.length > 10) {
      return errorResponse('stack cannot contain more than 10 items', 400, {
        parameter: 'stack',
        received: body.stack.length,
        max: 10,
      })
    }

    // Validate limit
    const limit = Math.min(Math.max(1, body.limit || 10), 50)

    // Validate project_type if provided
    const projectType = body.project_type?.toLowerCase()
    if (projectType && !PROJECT_TYPE_CATEGORIES[projectType]) {
      return errorResponse(
        `Invalid project_type. Must be one of: ${Object.keys(PROJECT_TYPE_CATEGORIES).join(', ')}`,
        400,
        {
          parameter: 'project_type',
          received: projectType,
          allowed: Object.keys(PROJECT_TYPE_CATEGORIES),
        }
      )
    }

    const supabase = createSupabaseClient(req.headers.get('authorization') ?? undefined)

    // Use search_skills RPC function for safe parameterized search
    // This avoids filter injection by using server-side function with proper parameterization
    const searchQuery = validStack.join(' ')

    // Get skills using the safe RPC function instead of building filters
    const { data: skills, error } = await supabase.rpc('search_skills', {
      search_query: searchQuery,
      limit_count: limit * 5,
      offset_count: 0,
    })

    if (error) {
      console.error('Database error:', error)
      return errorResponse('Failed to get recommendations', 500, { code: error.code })
    }

    let recommendations = skills || []

    // If no results from direct match, try fuzzy search
    if (recommendations.length === 0) {
      const { data: fuzzyResults } = await supabase.rpc('fuzzy_search_skills', {
        search_query: validStack[0],
        similarity_threshold: 0.2,
        limit_count: limit * 3,
      })
      recommendations = fuzzyResults || []
    }

    // Calculate relevance scores and sort
    const scored = recommendations.map((skill) => ({
      ...skill,
      relevance_score: calculateRelevance(skill, validStack),
    }))

    // Sort by relevance score descending
    scored.sort((a, b) => b.relevance_score - a.relevance_score)

    // Take top results
    const topRecommendations = scored.slice(0, limit)

    const response = jsonResponse({
      data: topRecommendations,
      meta: {
        stack: validStack,
        project_type: projectType || null,
        total: topRecommendations.length,
        limit,
      },
    })

    // Add rate limit, CORS, and request ID headers
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
