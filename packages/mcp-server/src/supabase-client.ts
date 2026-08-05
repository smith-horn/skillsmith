/**
 * @fileoverview Supabase client singleton for MCP server
 * @module @skillsmith/mcp-server/tools/supabase-client
 * @see SMI-3914: Wave 0 Shared Infrastructure
 *
 * @supabase/supabase-js is an optional peer dep — dynamic import.
 * Clients are lazy-initialized on first use and cached for the process lifetime.
 * Call resetSupabaseClients() in tests to clear cached instances.
 */

let _client: unknown = null
let _adminClient: unknown = null

/**
 * Get the Supabase anon-key client (lazy singleton).
 * Requires SUPABASE_URL and SUPABASE_ANON_KEY env vars.
 */
export async function getSupabaseClient(): Promise<unknown> {
  if (_client) return _client
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error('Supabase not configured: SUPABASE_URL and SUPABASE_ANON_KEY required')
  }
  try {
    const { createClient } = await import('@supabase/supabase-js')
    _client = createClient(url, anonKey)
    return _client
  } catch {
    throw new Error('Supabase client unavailable: @supabase/supabase-js not installed')
  }
}

/**
 * Get the Supabase service-role client (lazy singleton).
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
 */
export async function getSupabaseAdminClient(): Promise<unknown> {
  if (_adminClient) return _adminClient
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('Supabase admin not configured: SUPABASE_SERVICE_ROLE_KEY required')
  }
  try {
    const { createClient } = await import('@supabase/supabase-js')
    _adminClient = createClient(url, serviceKey)
    return _adminClient
  } catch {
    throw new Error('Supabase client unavailable: @supabase/supabase-js not installed')
  }
}

/**
 * Build a Supabase client bound to a specific end-user's access token (SMI-5882 / SMI-5822).
 *
 * Deliberately NOT a singleton: the returned client carries one user's JWT in its headers, so
 * caching it process-wide would let a later caller inherit an earlier caller's identity — the
 * exact confusion this path exists to remove.
 *
 * Requests made through it reach PostgREST as the `authenticated` role with `auth.uid()` resolved
 * from the token, so row-level security (e.g. `private_registry_skills_admin_update`) is the thing
 * that authorizes them, rather than app-level logic that can drift from the policy.
 *
 * @param accessToken - a Supabase user access token (from `skillsmith login`)
 */
export async function getSupabaseUserClient(accessToken: string): Promise<unknown> {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error('Supabase not configured: SUPABASE_URL and SUPABASE_ANON_KEY required')
  }
  if (!accessToken) {
    throw new Error('Supabase user client requires a non-empty access token')
  }
  try {
    const { createClient } = await import('@supabase/supabase-js')
    return createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      // The MCP subprocess is not a browser session: never persist or background-refresh here.
      // Token lifecycle is owned by the CLI credential store (SMI-4402).
      auth: { persistSession: false, autoRefreshToken: false },
    })
  } catch {
    throw new Error('Supabase client unavailable: @supabase/supabase-js not installed')
  }
}

/** Check if Supabase is configured (env vars present) */
export function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
}

/** Reset clients (for testing) */
export function resetSupabaseClients(): void {
  _client = null
  _adminClient = null
}
