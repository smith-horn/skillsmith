/**
 * GET /v1/skills/:id - Get skill by ID
 * @module skills-get
 *
 * SMI-1180: API Development - Wave 3
 *
 * Path Parameters:
 * - id (required): Skill ID in format "author/name" or UUID
 *
 * Returns:
 * - Skill object with full details
 * - 404 if skill not found
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
  escapeLikePattern,
  type Skill,
} from '../_shared/supabase.ts'

/**
 * Extract skill ID from URL path
 * Supports both direct UUID and author/name format
 */
function extractSkillId(url: URL): string | null {
  const pathname = url.pathname
  // Pattern: /skills-get/author/name or /skills-get/uuid
  const match = pathname.match(/\/skills-get\/(.+)$/)
  if (match) {
    return decodeURIComponent(match[1])
  }
  // Also check query parameter as fallback
  return url.searchParams.get('id')
}

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
  logInvocation('skills-get', requestId)

  // Check rate limit
  const rateLimitResult = await checkRateLimit('skills-get', req)
  if (!rateLimitResult.success) {
    return rateLimitExceededResponse(rateLimitResult, buildCorsHeaders(origin))
  }

  try {
    const url = new URL(req.url)
    const skillId = extractSkillId(url)

    // Validate skill ID is provided
    if (!skillId || skillId.trim() === '') {
      return errorResponse('Skill ID required', 400, {
        parameter: 'id',
        hint: 'Provide skill ID as path parameter or query parameter',
      })
    }

    const supabase = createSupabaseClient(req.headers.get('authorization') ?? undefined)

    // Try to find the skill
    // First attempt: direct ID match
    const query = supabase.from('skills').select('*').eq('id', skillId.trim()).single()

    let { data: skill, error } = await query

    // If not found by ID, try matching by author/name pattern
    if (error?.code === 'PGRST116' && skillId.includes('/')) {
      const [author, name] = skillId.split('/')
      const { data: skillByAuthor, error: authorError } = await supabase
        .from('skills')
        .select('*')
        .eq('author', author)
        .eq('name', name)
        .single()

      if (!authorError) {
        skill = skillByAuthor
        error = null
      }
    }

    // If still not found, try fuzzy name match
    // Escape LIKE special characters to prevent wildcard injection
    if (error?.code === 'PGRST116') {
      const escapedName = escapeLikePattern(skillId.trim())
      const { data: skillByName, error: nameError } = await supabase
        .from('skills')
        .select('*')
        .ilike('name', escapedName)
        .limit(1)
        .single()

      if (!nameError) {
        skill = skillByName
        error = null
      }
    }

    // Handle not found
    if (error?.code === 'PGRST116' || !skill) {
      return errorResponse('Skill not found', 404, {
        id: skillId,
      })
    }

    // Handle other errors
    if (error) {
      console.error('Database error:', error)
      return errorResponse('Failed to retrieve skill', 500, {
        code: error.code,
      })
    }

    // Fetch associated categories
    const { data: categories } = await supabase
      .from('skill_categories')
      .select('categories(id, name)')
      .eq('skill_id', skill.id)

    // Build response with categories
    const response: Skill & { categories: string[] } = {
      ...skill,
      categories:
        categories?.map((c) => (c.categories as { name: string })?.name).filter(Boolean) || [],
    }

    const jsonRes = jsonResponse({
      data: response,
    })

    // Add rate limit, CORS, and request ID headers
    const headers = new Headers(jsonRes.headers)
    Object.entries(createRateLimitHeaders(rateLimitResult)).forEach(([key, value]) => {
      headers.set(key, value)
    })
    Object.entries(buildCorsHeaders(origin)).forEach(([key, value]) => {
      headers.set(key, value)
    })
    headers.set('X-Request-ID', requestId)

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
