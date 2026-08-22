/**
 * @fileoverview Supabase client singleton for MCP server
 * @module @skillsmith/mcp-server/tools/supabase-client
 * @see SMI-3914: Wave 0 Shared Infrastructure
 * @see SMI-6109: env-override-with-fallback for the anon-key client paths
 *
 * @supabase/supabase-js is an optional peer dep — dynamic import.
 * Clients are lazy-initialized on first use and cached for the process lifetime.
 * Call resetSupabaseClients() in tests to clear cached instances.
 */

/**
 * Production Supabase project URL (ref `vrcnzpmndtroqxxoqkzy` — CLAUDE.md's "Project refs" table).
 * Fallback only, for the anon-key client paths below — an explicit SUPABASE_URL env var always
 * wins. Never used for getSupabaseAdminClient(), which stays strictly env-var-only (SMI-6109).
 */
const PRODUCTION_SUPABASE_URL = 'https://vrcnzpmndtroqxxoqkzy.supabase.co'

/**
 * Production Supabase anon key. Safe to ship in source — it grants only RLS-scoped access, never
 * admin access (byte-identical to packages/core/src/api/utils.ts's PRODUCTION_ANON_KEY;
 * duplicated rather than imported cross-package to avoid widening @skillsmith/core's public
 * export surface for this fix — keep both in sync if this key is ever rotated).
 */
const PRODUCTION_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyY256cG1uZHRyb3F4eG9xa3p5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzgwNzQsImV4cCI6MjA4MzQxNDA3NH0.WNK5jaNG3twxApOva5A1ZlCaZb5hVqBYtNJezRrR4t8'

/**
 * Resolve the Supabase URL/anon key for the anon-key client paths: an explicit env var always
 * wins, falling back to the hardcoded production values only when unset (SMI-6109). Mirrors
 * packages/core/src/api/utils.ts's DEFAULT_BASE_URL pattern — an explicit override (e.g.
 * private-registry-e2e.yml's `mcp-live` leg pointing SUPABASE_URL/SUPABASE_ANON_KEY at staging)
 * keeps working exactly as before; only a genuinely-unset var reaches the fallback.
 *
 * Deliberately NOT applied to isSupabaseConfigured() below: that flag also gates several unrelated
 * tool families' own live/stub selection (sso-tools, team-workspace, compliance-tools,
 * integration-tools, rbac-tools, team-resolver), each of which still needs real Supabase config
 * for its own (unrelated, still service-role-backed) live path — flipping it here would silently
 * move all of them from a working stub to a broken "live" attempt, well outside SMI-6109's scope
 * (removing SUPABASE_SERVICE_ROLE_KEY from the *customer-facing* surface, not making every tool
 * family Supabase-config-optional).
 */
function resolveSupabaseUrl(): string {
  return process.env.SUPABASE_URL || PRODUCTION_SUPABASE_URL
}

function resolveSupabaseAnonKey(): string {
  return process.env.SUPABASE_ANON_KEY || PRODUCTION_ANON_KEY
}

let _client: unknown = null
let _adminClient: unknown = null

/**
 * Get the Supabase anon-key client (lazy singleton).
 * Uses SUPABASE_URL/SUPABASE_ANON_KEY when set, else the production defaults (SMI-6109).
 */
export async function getSupabaseClient(): Promise<unknown> {
  if (_client) return _client
  const url = resolveSupabaseUrl()
  const anonKey = resolveSupabaseAnonKey()
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
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars. No fallback (SMI-6109) — unlike
 * the anon-key paths above, this credential must never default to a value baked into source.
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
 * Uses SUPABASE_URL/SUPABASE_ANON_KEY when set, else the production defaults (SMI-6109) — same
 * fallback as getSupabaseClient() above.
 *
 * @param accessToken - a Supabase user access token (from `skillsmith login`)
 */
export async function getSupabaseUserClient(accessToken: string): Promise<unknown> {
  const url = resolveSupabaseUrl()
  const anonKey = resolveSupabaseAnonKey()
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

/**
 * Check if Supabase is configured (real SUPABASE_URL + SUPABASE_ANON_KEY env vars present).
 *
 * Deliberately NOT affected by the anon-key fallback above (SMI-6109) — see that comment for why.
 *
 * Cross-provider review correction (SMI-6109): this means the fallback does NOT make the private
 * registry usable with zero Supabase config. `registry-tools.ts`'s own module-load service
 * selection AND its `resolveTeamId()` both still gate on this exact flag, so a customer with
 * neither `SUPABASE_URL` nor `SUPABASE_ANON_KEY` set gets the in-memory STUB service, never
 * reaching `getMemberUserClient()`/the fallback at all — by design, so a genuinely unconfigured
 * host still gets fast, offline-safe stub behavior instead of a live network call against a
 * license key that was never set up. The fallback's real, narrower benefit: once a customer HAS
 * set both vars (the expected Team/Enterprise setup — see the README), a *later* drift where one
 * of the two is missing in some specific execution context (e.g. propagated inconsistently to an
 * MCP subprocess) degrades gracefully instead of failing, and — matching
 * packages/core/src/api/utils.ts's identical DEFAULT_BASE_URL pattern — the anon-key surface never
 * needs a bespoke "not configured" error path of its own.
 */
export function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
}

/** Reset clients (for testing) */
export function resetSupabaseClients(): void {
  _client = null
  _adminClient = null
}
