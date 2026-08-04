// SMI-4402: JWT refresh helpers extracted from client.ts to stay under 500-line limit.
import {
  loadCredentials,
  refreshAccessToken,
  storeCredentials,
} from '../config/token-credentials.js'

export async function tryRefreshToken(): Promise<string | null> {
  const creds = await loadCredentials()
  if (!creds) return null

  const refreshed = await refreshAccessToken(creds.refreshToken)
  if (!refreshed) return null

  await storeCredentials(refreshed)
  return refreshed.accessToken
}

export async function loadStoredAccessToken(): Promise<string | null> {
  const creds = await loadCredentials()
  if (!creds) return null
  return creds.accessToken
}

/**
 * SMI-5905 Wave 1: refresh a token this many ms before its recorded expiry.
 *
 * Extracted from `packages/mcp-server/src/tools/team-resolver.ts`'s
 * `resolveUserAccessToken()` (originally SMI-4292) so a 2nd consumer (the
 * CLI, via a future private-registry command) can resolve "the signed-in
 * user's fresh access token" without depending on mcp-server. team-resolver.ts
 * now delegates to `resolveFreshAccessToken()` below — same skew constant,
 * same refresh-or-null fallback, no behavior change for its existing callers.
 */
const TOKEN_EXPIRY_SKEW_MS = 60_000

/**
 * Resolve the signed-in user's Supabase access token, refreshing it if it has
 * expired (or is within `TOKEN_EXPIRY_SKEW_MS` of expiring).
 *
 * @returns the access token, or null when no credentials are stored on this
 *          machine (or the stored refresh token is no longer valid).
 */
export async function resolveFreshAccessToken(): Promise<string | null> {
  const creds = await loadCredentials()
  if (!creds) return null
  if (Date.now() < creds.expiresAt - TOKEN_EXPIRY_SKEW_MS) return creds.accessToken
  return tryRefreshToken()
}
