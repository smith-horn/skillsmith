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
import {
  parseInventorySyncEnabled,
  parseAuditEmailEnabled,
  buildTelemetryUpsertRow,
} from '../../../lib/telemetry-body'

interface TelemetryPreferenceRow {
  user_id: string
  enabled: boolean
  anonymous_id: string | null
  anonymous_id_created_at: string | null
  updated_at: string
  inventory_sync_enabled: boolean
  audit_email_enabled: boolean
}

interface PutBody {
  enabled?: unknown
  anonymous_id?: unknown
  inventory_sync_enabled?: unknown
  audit_email_enabled?: unknown
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

async function resolveUser(
  accessToken: string
): Promise<{ id: string; emailVerified: boolean } | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { data, error } = await client.auth.getUser(accessToken)
  if (error || !data.user) return null
  // `email_confirmed_at` is the canonical Supabase verified-email signal (same
  // field the account page reads to gate the audit-email toggle). Surfaced here
  // so the PUT handler can enforce it server-side, not just client-side.
  return { id: data.user.id, emailVerified: data.user.email_confirmed_at != null }
}

function defaultRow(userId: string): TelemetryPreferenceRow {
  return {
    user_id: userId,
    enabled: false,
    anonymous_id: null,
    anonymous_id_created_at: null,
    updated_at: new Date(0).toISOString(),
    inventory_sync_enabled: false,
    audit_email_enabled: false,
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

  const user = await resolveUser(token)
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
  const userId = user.id

  const client = userScopedClient(token)
  if (!client) return jsonResponse({ error: 'service_unavailable' }, 503)

  const { data, error } = await client
    .from('user_telemetry_preferences')
    .select(
      'user_id, enabled, anonymous_id, anonymous_id_created_at, updated_at, inventory_sync_enabled, audit_email_enabled'
    )
    .eq('user_id', userId)
    .maybeSingle<TelemetryPreferenceRow>()

  if (error) return jsonResponse({ error: 'fetch_failed' }, 500)

  return jsonResponse({ preference: data ?? defaultRow(userId) })
}

export const PUT: APIRoute = async ({ request }) => {
  const token = extractBearerToken(request)
  if (!token) return jsonResponse({ error: 'unauthorized' }, 401)

  const user = await resolveUser(token)
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401)
  const userId = user.id

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
  // timestamp; subsequent updates retain the original timestamp. We also read
  // `inventory_sync_enabled` and `audit_email_enabled` so an omitted field uses
  // the stored value (read-modify-write semantics for optional fields). This is
  // the P-5 coordination invariant: an unrelated telemetry PUT (e.g. just
  // toggling `enabled`) must never clobber a user's dedicated audit-email
  // consent (SMI-5540) — CAN-SPAM requires that consent stay independently
  // scoped, not inferred from or reset by other preference writes.
  const { data: existing } = await client
    .from('user_telemetry_preferences')
    .select('anonymous_id, anonymous_id_created_at, inventory_sync_enabled, audit_email_enabled')
    .eq('user_id', userId)
    .maybeSingle<{
      anonymous_id: string | null
      anonymous_id_created_at: string | null
      inventory_sync_enabled: boolean
      audit_email_enabled: boolean
    }>()

  const inventorySyncResult = parseInventorySyncEnabled(
    body.inventory_sync_enabled,
    existing?.inventory_sync_enabled ?? false
  )
  if (inventorySyncResult.error !== null) {
    return jsonResponse({ error: inventorySyncResult.error }, 400)
  }
  // After the null check the discriminated union narrows `value` to `boolean`.

  const auditEmailResult = parseAuditEmailEnabled(
    body.audit_email_enabled,
    existing?.audit_email_enabled ?? false
  )
  if (auditEmailResult.error !== null) {
    return jsonResponse({ error: auditEmailResult.error }, 400)
  }
  // After the null check the discriminated union narrows `value` to `boolean`.

  // Server-side enforcement of the verified-email gate. The account-page toggle
  // is only a UX affordance; a token holder could PUT audit_email_enabled=true
  // directly. Consent to be *emailed* requires a verified address (CAN-SPAM),
  // and we must not rely on 2C-2's cron as the sole downstream check ("recording
  // != consuming" / sole-gate trap). Enabling for an unverified email is
  // rejected; disabling (value === false) is always allowed.
  if (auditEmailResult.value === true && !user.emailVerified) {
    return jsonResponse({ error: 'email_not_verified' }, 400)
  }

  const now = new Date().toISOString()
  const upsertRow = buildTelemetryUpsertRow({
    userId,
    enabled: body.enabled,
    anonymousId,
    inventorySyncEnabled: inventorySyncResult.value,
    auditEmailEnabled: auditEmailResult.value,
    existing,
    now,
  })

  const { data, error } = await client
    .from('user_telemetry_preferences')
    .upsert(upsertRow, { onConflict: 'user_id' })
    .select(
      'user_id, enabled, anonymous_id, anonymous_id_created_at, updated_at, inventory_sync_enabled, audit_email_enabled'
    )
    .single<TelemetryPreferenceRow>()

  if (error || !data) return jsonResponse({ error: 'upsert_failed' }, 500)
  return jsonResponse({ preference: data })
}
