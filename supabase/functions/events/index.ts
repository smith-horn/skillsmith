/**
 * POST /v1/events - Telemetry events endpoint
 * @module events
 *
 * SMI-1180: API Development - Wave 3
 *
 * Request Body:
 * - event (required): Event type (e.g., "skill_view", "skill_install", "search")
 * - skill_id (optional): Associated skill ID
 * - anonymous_id (required): Anonymous user identifier for aggregation
 * - metadata (optional): Additional event metadata
 *
 * Returns:
 * - { ok: boolean } on success
 *
 * Privacy Note:
 * - No PII is collected
 * - anonymous_id should be a hashed value generated client-side
 * - Events are aggregated for analytics only
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

import { createSupabaseAdminClient, getRequestId, logInvocation } from '../_shared/supabase.ts'

interface TelemetryEvent {
  event: string
  skill_id?: string
  anonymous_id: string
  metadata?: Record<string, unknown>
}

/**
 * Allowed event types for validation
 */
const ALLOWED_EVENTS = [
  'skill_view',
  'skill_install',
  'skill_uninstall',
  'skill_rate',
  'search',
  'recommend',
  'compare',
  'validate',
] as const

/**
 * Validate event name
 */
function isValidEvent(event: string): boolean {
  return ALLOWED_EVENTS.includes(event as (typeof ALLOWED_EVENTS)[number])
}

/**
 * Validate anonymous_id format (should be hex string of reasonable length)
 */
function isValidAnonymousId(id: string): boolean {
  return typeof id === 'string' && id.length >= 16 && id.length <= 128 && /^[a-f0-9-]+$/i.test(id)
}

/**
 * Sanitize metadata to prevent injection
 */
function sanitizeMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }

  const sanitized: Record<string, unknown> = {}
  const allowed = ['version', 'platform', 'source', 'query', 'results_count', 'duration_ms']

  for (const [key, value] of Object.entries(metadata)) {
    // Only allow primitive values for known keys
    if (allowed.includes(key)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        sanitized[key] = value
      }
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null
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
  logInvocation('events', requestId)

  // Check rate limit
  const rateLimitResult = await checkRateLimit('events', req)
  if (!rateLimitResult.success) {
    return rateLimitExceededResponse(rateLimitResult, buildCorsHeaders(origin))
  }

  try {
    // Parse request body
    let body: TelemetryEvent
    try {
      body = await req.json()
    } catch {
      return errorResponse('Invalid JSON body', 400)
    }

    // Validate required fields
    if (!body.event || typeof body.event !== 'string') {
      return errorResponse('event is required', 400, { parameter: 'event' })
    }

    if (!isValidEvent(body.event)) {
      return errorResponse(
        `Invalid event type. Must be one of: ${ALLOWED_EVENTS.join(', ')}`,
        400,
        {
          parameter: 'event',
          received: body.event,
          allowed: ALLOWED_EVENTS,
        }
      )
    }

    if (!body.anonymous_id || !isValidAnonymousId(body.anonymous_id)) {
      return errorResponse(
        'anonymous_id is required and must be a valid hex string (16-128 characters)',
        400,
        { parameter: 'anonymous_id' }
      )
    }

    // Validate skill_id if provided
    if (body.skill_id !== undefined) {
      if (typeof body.skill_id !== 'string' || body.skill_id.trim() === '') {
        return errorResponse('skill_id must be a non-empty string', 400, {
          parameter: 'skill_id',
        })
      }
    }

    // Use admin client to write to audit_logs (bypasses RLS)
    const supabase = createSupabaseAdminClient()

    // Build audit log entry
    const auditEntry = {
      event_type: `telemetry:${body.event}`,
      actor: body.anonymous_id, // Anonymous, hashed identifier
      resource: body.skill_id || null,
      action: body.event,
      result: 'success',
      metadata: {
        ...sanitizeMetadata(body.metadata),
        request_id: requestId,
        timestamp: new Date().toISOString(),
      },
    }

    // Insert telemetry event as audit log
    const { error } = await supabase.from('audit_logs').insert(auditEntry)

    if (error) {
      console.error('Failed to log telemetry:', error)
      // Don't expose internal errors for telemetry
      // Still return success to client (telemetry should be non-blocking)
    }

    const response = jsonResponse({ ok: true })

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
    // For telemetry, still return success to not block client
    return jsonResponse({ ok: true })
  }
})
