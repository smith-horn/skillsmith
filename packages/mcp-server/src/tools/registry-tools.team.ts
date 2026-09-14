/**
 * @fileoverview Registry-only team resolution — no `isSupabaseConfigured()` gate
 * @module @skillsmith/mcp-server/tools/registry-tools.team
 * @see SMI-6622: the public `@skillsmith/mcp-server` package must NEVER need Supabase env vars.
 *   `registry-tools.ts` previously gated BOTH its live/stub service selection AND its team
 *   resolution on `isSupabaseConfigured()` (`SUPABASE_URL` + `SUPABASE_ANON_KEY` both set) — so a
 *   customer running with no Supabase env got a silently-inert in-memory stub (`publish` returned
 *   `success:true` with nothing written) instead of the real, already-env-optional live path
 *   (`supabase-client.ts`'s `getSupabaseClient()`/`getSupabaseUserClient()` already fall back to a
 *   hardcoded production URL/anon key — SMI-6109 — so no Supabase env var was ever actually
 *   required to reach it).
 * @see SMI-6623: `team-resolver.ts`'s shared `resolveLicenseTeamId()`/`readLicenseKey()` stay
 *   exactly as they were — `team-workspace.ts` and other tool families still call them directly
 *   and still need their `isSupabaseConfigured()` gate / null-on-unconfigured behavior unchanged.
 *   This module is a SEPARATE, registry-only resolver `registry-tools.ts` calls INSTEAD.
 *
 * Credential resolution order (mirrors `team-resolver.ts`'s `readLicenseKey()` precedence, then
 * adds one more fallback):
 *   1. `SKILLSMITH_LICENSE_KEY` env, then `SKILLSMITH_API_KEY` env (`readLicenseKey()`, reused
 *      as-is from `team-resolver.ts` — same precedence, same "empty string counts as unset" rule).
 *   2. `~/.skillsmith/config.json`'s `apiKey` field (`getApiKey()`, `@skillsmith/core`) — the same
 *      file `skillsmith login` / an admin-granted account's CLI session already writes, so an
 *      account with no shell-exported env var (shell exports do not reach MCP subprocesses) still
 *      resolves a team without needing to hand-copy a key into MCP server config.
 *
 * Team resolution then ALWAYS runs the `resolve_team_from_license` RPC against
 * `getSupabaseClient()` (the anon-key client — SMI-6109's production fallback applies here too) —
 * never gated on `isSupabaseConfigured()`, and NEVER falls back to a placeholder/stub team id. Every
 * failure mode throws, distinguishably:
 *   - no credential anywhere (env or config.json) → a plain, actionable `Error`
 *   - the RPC call itself fails (network/transport, or a non-null `error` in its response) →
 *     {@link RegistryTeamResolutionError}
 *   - the RPC succeeds but resolves to no team (unknown/malformed/revoked key) → a plain `Error`
 *
 * Team-vs-membership mismatch (a license key that resolves to team A, while the signed-in user —
 * `skillsmith login` — is actually a member of team B or no team at all) is NOT this module's
 * concern: it is a DIFFERENT identity signal, checked downstream by real RLS policies
 * (`private_registry_skills_member_read`/`_member_insert`/`_admin_update`) once
 * `registry-tools.live.ts` combines this module's resolved `teamId` with the signed-in user's own
 * JWT (`getMemberUserClient()`/`getAdminUserClient()`, `registry-tools.live.auth.ts`) — see that
 * file's own header comment for why RLS, not this module, is the enforcement point.
 */

import { getApiKey } from '@skillsmith/core'
import { getSupabaseClient } from '../supabase-client.js'
import { readLicenseKey } from './team-resolver.js'

/** Shape of a Supabase client's rpc() response (minimal — avoid hard dep). */
interface SupabaseRpcResult<T> {
  data: T | null
  error: { message?: string } | null
}

interface MinimalSupabaseClient {
  rpc<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<SupabaseRpcResult<T>>
}

/**
 * Thrown when `resolve_team_from_license` could not be reached at all — a network/transport
 * failure, or a non-null `error` in the RPC response. Distinct from the plain `Error` thrown when
 * the RPC succeeds but resolves to no team, so a caller (or a test) can tell "we asked and the key
 * is wrong/unknown" apart from "we could not even ask."
 */
export class RegistryTeamResolutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RegistryTeamResolutionError'
  }
}

/**
 * Read the registry team-resolution credential: env first (`SKILLSMITH_LICENSE_KEY` then
 * `SKILLSMITH_API_KEY`, via `readLicenseKey()`), then `~/.skillsmith/config.json`'s `apiKey` field
 * (`getApiKey()` already re-checks `SKILLSMITH_API_KEY` internally before the file — harmless
 * redundancy, not a behavior change, since `readLicenseKey()` already covered that case).
 */
function readRegistryCredential(): string | null {
  const envKey = readLicenseKey()
  if (envKey) return envKey
  const configKey = getApiKey()
  return configKey && configKey.length > 0 ? configKey : null
}

/**
 * Resolve the caller's team_id for the private registry. See this module's header for the full
 * credential order, no-env-gate rationale, and failure-mode contract. Never returns a
 * placeholder/stub id — every failure path throws instead.
 */
export async function resolveRegistryTeamId(): Promise<string> {
  const key = readRegistryCredential()
  if (!key) {
    throw new Error(
      'SKILLSMITH_LICENSE_KEY or SKILLSMITH_API_KEY is required for private registry operations. ' +
        'Set one in your MCP server config (shell exports do not reach MCP subprocesses), or run ' +
        '`skillsmith login` / configure an API key so it is saved to ~/.skillsmith/config.json. ' +
        'Publishing, installing, and reviewing submissions additionally require `skillsmith login`.'
    )
  }

  let rpcResult: SupabaseRpcResult<string>
  try {
    const client = (await getSupabaseClient()) as MinimalSupabaseClient
    rpcResult = await client.rpc<string>('resolve_team_from_license', { p_license_key: key })
  } catch (err) {
    throw new RegistryTeamResolutionError(
      `Failed to resolve your team from the configured credential: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
      { cause: err }
    )
  }

  if (rpcResult.error) {
    throw new RegistryTeamResolutionError(
      `Failed to resolve your team from the configured credential: ${
        rpcResult.error.message ?? 'unknown error'
      }`
    )
  }

  if (!rpcResult.data) {
    throw new Error(
      'Unable to resolve team from the configured key. Ensure SKILLSMITH_LICENSE_KEY or ' +
        'SKILLSMITH_API_KEY (or the apiKey saved in ~/.skillsmith/config.json) is active and ' +
        'attached to an Enterprise-tier subscription.'
    )
  }

  return rpcResult.data
}
