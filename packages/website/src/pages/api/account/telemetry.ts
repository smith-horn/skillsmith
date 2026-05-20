/**
 * User Telemetry Preferences API
 *
 * SMI-5019 W2.S4: GET + PUT for the user_telemetry_preferences table.
 *
 * Backs the consent page at /account/telemetry. RLS policy
 * `user_telemetry_self_rw` (migration from SMI-5013) restricts read/write to
 * the row keyed by `auth.uid()`, so we forward the user's Supabase access
 * token as a Bearer credential and let the database enforce isolation.
 *
 * Auth: `Authorization: Bearer <supabase-access-token>` (the same token the
 * client uses against edge functions). The token is **never** logged or
 * echoed in responses. A missing/invalid token yields a 401.
 */

export const prerender = false

import type { APIRoute } from 'astro'
import { createClient } from '@supabase/supabase-js'

interface TelemetryPreferenceRow {
  user_id: string
  enabled: boolean
  anonymous_id: string | null
  anonymous_id_created_at: string | null
  updated_at: string
}

interface PutBody {
  enabled?: unknown
  anonymous_id?: unknown
}

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? ''

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

/**
 * Build a Supabase client that authenticates requests **as the calling user**
 * by injecting their access token into every PostgREST call. This is the
 * canonical pattern for RLS-enforced endpoints — the client itself does not
 * call `auth.setSession()`, which would mutate global cookie/auth state.
 */
function userScopedClient(accessToken: string) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

async function resolveUserId(accessToken: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { data, error } = await client.auth.getUser(accessToken)
  if (error || !data.user) return null
  return data.user.id
}

function defaultRow(userId: string): TelemetryPreferenceRow {
  return {
    user_id: userId,
    enabled: false,
    anonymous_id: null,
    anonymous_id_created_at: null,
    updated_at: new Date(0).toISOString(),
  }
}

function sanitizeAnonymousId(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  // anonymous_id is opaque but we cap length defensively to avoid abuse of a
  // free-form text column.
  if (trimmed.length > 128) return null
  return trimmed
}

export const GET: APIRoute = async ({ request }) => {
  const token = extractBearerToken(request)
  if (!token) return jsonResponse({ error: 'unauthorized' }, 401)

  const userId = await resolveUserId(token)
  if (!userId) return jsonResponse({ error: 'unauthorized' }, 401)

  const client = userScopedClient(token)
  if (!client) return jsonResponse({ error: 'service_unavailable' }, 503)

  const { data, error } = await client
    .from('user_telemetry_preferences')
    .select('user_id, enabled, anonymous_id, anonymous_id_created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle<TelemetryPreferenceRow>()

  if (error) return jsonResponse({ error: 'fetch_failed' }, 500)

  return jsonResponse({ preference: data ?? defaultRow(userId) })
}

export const PUT: APIRoute = async ({ request }) => {
  const token = extractBearerToken(request)
  if (!token) return jsonResponse({ error: 'unauthorized' }, 401)

  const userId = await resolveUserId(token)
  if (!userId) return jsonResponse({ error: 'unauthorized' }, 401)

  let body: PutBody
  try {
    body = (await request.json()) as PutBody
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400)
  }

  if (typeof body.enabled !== 'boolean') {
    return jsonResponse({ error: 'invalid_enabled' }, 400)
  }

  const anonymousId = sanitizeAnonymousId(body.anonymous_id)

  const client = userScopedClient(token)
  if (!client) return jsonResponse({ error: 'service_unavailable' }, 503)

  // Read current row first so we preserve `anonymous_id_created_at` across
  // toggles: an anonymous_id supplied for the first time gets a creation
  // timestamp; subsequent updates retain the original timestamp.
  const { data: existing } = await client
    .from('user_telemetry_preferences')
    .select('anonymous_id, anonymous_id_created_at')
    .eq('user_id', userId)
    .maybeSingle<{ anonymous_id: string | null; anonymous_id_created_at: string | null }>()

  const now = new Date().toISOString()
  const anonymousIdChanged = anonymousId !== null && existing?.anonymous_id !== anonymousId
  const anonymousIdCreatedAt = anonymousIdChanged
    ? now
    : (existing?.anonymous_id_created_at ?? (anonymousId !== null ? now : null))

  const upsertRow = {
    user_id: userId,
    enabled: body.enabled,
    anonymous_id: anonymousId ?? existing?.anonymous_id ?? null,
    anonymous_id_created_at: anonymousIdCreatedAt,
    updated_at: now,
  }

  const { data, error } = await client
    .from('user_telemetry_preferences')
    .upsert(upsertRow, { onConflict: 'user_id' })
    .select('user_id, enabled, anonymous_id, anonymous_id_created_at, updated_at')
    .single<TelemetryPreferenceRow>()

  if (error || !data) return jsonResponse({ error: 'upsert_failed' }, 500)
  return jsonResponse({ preference: data })
}
