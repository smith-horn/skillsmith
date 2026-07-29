/**
 * @fileoverview Credential resolution for team-scoped MCP tools
 * @module @skillsmith/mcp-server/tools/team-resolver
 * @see SMI-4292: Wave 5A — Team workspaces foundation (finding C3)
 * @see SMI-5822 / SMI-5882: admin operations need a user-bound credential, not a team one
 *
 * Two distinct credentials, for two distinct questions:
 *
 * 1. `resolveLicenseTeamId` — **which team** is this call for? Unified team resolution for MCP
 *    tools; both team-workspace.ts and registry-tools.ts call it so there is one auth path.
 *    License key source, in order: explicit `licenseKey` argument (from `ToolContext` or tool
 *    input), then `process.env.SKILLSMITH_LICENSE_KEY`. Calls the `resolve_team_from_license` RPC
 *    (migration 071) using an anon-key Supabase client (the RPC is SECURITY DEFINER). Returns null
 *    if the key is missing, invalid, expired, or not attached to a team.
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

import { loadCredentials, tryRefreshToken } from '@skillsmith/core'
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
 * Extract the license key from an optional explicit value or the environment.
 */
export function readLicenseKey(explicit?: string): string | null {
  const raw = explicit ?? process.env.SKILLSMITH_LICENSE_KEY ?? ''
  return raw.length > 0 ? raw : null
}

/**
 * Resolve a license key to a team_id via `resolve_team_from_license` RPC.
 *
 * @param licenseKey - optional explicit license key; falls back to env
 * @returns resolved team_id, or null if Supabase is not configured / key invalid
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

/** Refresh a token this many ms before its recorded expiry, matching context.async.ts. */
const TOKEN_EXPIRY_SKEW_MS = 60_000

/**
 * Resolve the signed-in user's Supabase access token, refreshing it if it has expired.
 *
 * Mirrors the credential handling `context.async.ts` already performs for the API client, so the
 * MCP process has exactly one notion of "the logged-in user" (SMI-4402).
 *
 * @returns the access token, or null when the user has not run `skillsmith login` on this machine
 *          (or the stored refresh token is no longer valid)
 */
export async function resolveUserAccessToken(): Promise<string | null> {
  const creds = await loadCredentials()
  if (!creds) return null
  if (Date.now() < creds.expiresAt - TOKEN_EXPIRY_SKEW_MS) return creds.accessToken
  const refreshed = await tryRefreshToken()
  return refreshed ?? null
}
