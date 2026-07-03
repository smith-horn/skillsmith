/**
 * Inventory Purge API
 *
 * SMI-5510 R0 W1a: POST to purge the caller's stored cross-machine inventory.
 *
 * Backs the purge control on /account/telemetry. We forward the user's Supabase
 * access token as a Bearer credential to the gateway-verified `purge-inventory`
 * edge function, which authenticates the JWT and deletes only the caller's rows
 * (RLS + `auth.uid()`-scoped). The token is **never** logged or echoed in
 * responses. A missing/invalid token yields a 401.
 *
 * Auth: `Authorization: Bearer <supabase-access-token>` (the same token the
 * client uses against edge functions). No request body is required.
 */

export const prerender = false

import type { APIRoute } from 'astro'

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

export const POST: APIRoute = async ({ request }) => {
  const token = extractBearerToken(request)
  if (!token) return jsonResponse({ error: 'unauthorized' }, 401)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'service_unavailable' }, 503)
  }

  // Forward the caller's token to the gateway-verified edge function. The
  // function verifies the JWT and scopes the delete to `auth.uid()`, so a stale
  // or invalid token is rejected upstream (401 passed straight through).
  let upstream: Response
  try {
    upstream = await fetch(`${SUPABASE_URL}/functions/v1/purge-inventory`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
    })
  } catch {
    return jsonResponse({ error: 'purge_failed' }, 500)
  }

  let body: unknown
  try {
    body = await upstream.json()
  } catch {
    return jsonResponse({ error: 'purge_failed' }, 500)
  }

  // Pass the edge function's JSON + status through unchanged.
  return jsonResponse(body, upstream.status)
}
