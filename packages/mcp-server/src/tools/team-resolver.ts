/**
 * @fileoverview Credential resolution for team-scoped MCP tools
 * @module @skillsmith/mcp-server/tools/team-resolver
 * @see SMI-4292: Wave 5A — Team workspaces foundation (finding C3)
 * @see SMI-5822 / SMI-5882: admin operations need a user-bound credential, not a team one
 * @see SMI-6080: `SKILLSMITH_API_KEY` fallback for admin-granted (non-JWT) Enterprise access
 *
 * Two distinct credentials, for two distinct questions:
 *
 * 1. `resolveLicenseTeamId` — **which team** is this call for? Unified team resolution for MCP
 *    tools; both team-workspace.ts and registry-tools.ts call it so there is one auth path.
 *    Credential source, in order: explicit `licenseKey` argument (from `ToolContext` or tool
 *    input), then `process.env.SKILLSMITH_LICENSE_KEY`, then `process.env.SKILLSMITH_API_KEY`.
 *    Calls the `resolve_team_from_license` RPC (migration 071) using an anon-key Supabase client
 *    (the RPC is SECURITY DEFINER). Returns null if the credential is missing, invalid, expired,
 *    or not attached to a team.
 *
 *    Why `SKILLSMITH_API_KEY` is a legitimate source here, and not a security downgrade (SMI-6080):
 *    `resolve_team_from_license(p_license_key TEXT)` SHA-256-hashes whatever string it is handed
 *    and matches it against `license_keys.key_hash`. It has no JWT-specific requirement, so a plain
 *    `sk_live_*` personal API key resolves through the *identical* lookup a signed license blob
 *    does — same table, same hash, same team, same failure modes. Reading it here therefore widens
 *    nothing: any key that resolves via this fallback would have resolved just as well had the
 *    operator copied it into `SKILLSMITH_LICENSE_KEY`.
 *
 *    Why the fallback is *needed*: an account whose Enterprise access came from
 *    `admin-grant-subscription` holds a plain API key and never a signed JWT license blob. The
 *    separate tier feature-gate (`middleware/license.ts`) requires `SKILLSMITH_LICENSE_KEY` to be
 *    *unset* so it falls back to live tier resolution via `SKILLSMITH_API_KEY` → `/license-status`;
 *    setting `SKILLSMITH_LICENSE_KEY` to a non-JWT string instead makes that gate attempt real
 *    `@smith-horn/enterprise` JWT validation and fail closed. Before this fallback there was no
 *    single env configuration that satisfied both gates for such an account.
 *
 *    Precedence is preserved: `SKILLSMITH_LICENSE_KEY` still wins whenever both are set, so an
 *    account that does hold a real license blob keeps resolving exactly as it did before.
 *
 * 2. `resolveUserAccessToken` — **who** is making this call? A license key cannot answer that.
 *    `resolve_team_from_license` is `(p_license_key TEXT) RETURNS TEXT`: it resolves a *team*,
 *    never a *person*, and never reads `team_members`. Nor could a wider return type help — a
 *    team's resolvable key is the single row the checkout webhook created for the *purchaser*
 *    (`license_keys.user_id` = purchaser, `subscription_id` = the team's subscription), then
 *    shared with the whole team. `license_keys.user_id` therefore names the buyer, not the caller,
 *    so deriving a role from it would produce a check that passes for everyone — worse than no
 *    check, because it would look like one. Admin-gated operations instead require the end user's
 *    own Supabase JWT, stored by `skillsmith login` (SMI-4402) and refreshed on expiry.
 */

import { resolveFreshAccessToken } from '@skillsmith/core'
import { getSupabaseClient, isSupabaseConfigured } from '../supabase-client.js'

/**
 * Shape of a Supabase client's rpc() response (minimal — avoid hard dep).
 */
interface SupabaseRpcResult<T> {
  data: T | null
  error: { message?: string } | null
}

interface MinimalSupabaseClient {
  rpc<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<SupabaseRpcResult<T>>
}

/**
 * Extract the team-resolution credential from an optional explicit value or the environment.
 *
 * Order: explicit argument, then `SKILLSMITH_LICENSE_KEY`, then `SKILLSMITH_API_KEY` (SMI-6080 —
 * see the fallback rationale in this file's header; both hash into `license_keys.key_hash`
 * identically, and the license key still wins when both env vars are set).
 *
 * An env var set to the empty string counts as unset for the env half of the chain, so a config
 * carrying `SKILLSMITH_LICENSE_KEY=""` still reaches the API-key fallback rather than resolving to
 * "no credential". An explicit empty-string *argument* still short-circuits to null, unchanged —
 * call sites pass `licenseKey ?? ''` and rely on that.
 */
export function readLicenseKey(explicit?: string): string | null {
  const licenseEnv = process.env.SKILLSMITH_LICENSE_KEY
  const fromEnv =
    licenseEnv !== undefined && licenseEnv.length > 0
      ? licenseEnv
      : (process.env.SKILLSMITH_API_KEY ?? '')
  const raw = explicit ?? fromEnv
  return raw.length > 0 ? raw : null
}

/**
 * Resolve a license key (or API key — SMI-6080) to a team_id via `resolve_team_from_license` RPC.
 *
 * @param licenseKey - optional explicit credential; falls back to env per {@link readLicenseKey}
 * @returns resolved team_id, or null if Supabase is not configured / credential invalid
 */
export async function resolveLicenseTeamId(licenseKey?: string): Promise<string | null> {
  if (!isSupabaseConfigured()) return null

  const key = readLicenseKey(licenseKey)
  if (!key) return null

  const client = (await getSupabaseClient()) as MinimalSupabaseClient
  const { data, error } = await client.rpc<string>('resolve_team_from_license', {
    p_license_key: key,
  })

  if (error || !data) return null
  return data
}

/**
 * Resolve the signed-in user's Supabase access token, refreshing it if it has expired.
 *
 * Mirrors the credential handling `context.async.ts` already performs for the API client, so the
 * MCP process has exactly one notion of "the logged-in user" (SMI-4402).
 *
 * SMI-5905 Wave 1: the refresh-or-null logic (including the `TOKEN_EXPIRY_SKEW_MS=60s` skew) now
 * lives in `@skillsmith/core`'s `resolveFreshAccessToken()` — extracted so the CLI can reuse it
 * too. This function is an unchanged-behavior delegate; no call site here needs to change.
 *
 * @returns the access token, or null when the user has not run `skillsmith login` on this machine
 *          (or the stored refresh token is no longer valid)
 */
export async function resolveUserAccessToken(): Promise<string | null> {
  return resolveFreshAccessToken()
}
