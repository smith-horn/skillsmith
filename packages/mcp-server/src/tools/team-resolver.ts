/**
 * @fileoverview Shared license-key → team_id resolver
 * @module @skillsmith/mcp-server/tools/team-resolver
 * @see SMI-4292: Wave 5A — Team workspaces foundation (finding C3)
 *
 * Unified team resolution for MCP tools. Both team-workspace.ts and
 * registry-tools.ts call `resolveLicenseTeamId` so they share one auth
 * path (no split auth resolution).
 *
 * License key source, in order:
 *   1. explicit `licenseKey` argument (from `ToolContext` or tool input)
 *   2. `process.env.SKILLSMITH_LICENSE_KEY`
 *
 * Calls the `resolve_team_from_license` RPC (migration 071) using an
 * anon-key Supabase client (RPC is SECURITY DEFINER). Returns null if
 * the key is missing, invalid, expired, or not attached to a team.
 */

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
