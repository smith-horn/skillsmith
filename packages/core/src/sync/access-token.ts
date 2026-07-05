/**
 * Shared device-session access-token resolver (SMI-5541, extracted from
 * SMI-5392 `inventory-client.ts`).
 *
 * Both the inventory upload/purge client and the audit-notify client need to
 * resolve a fresh access token from the stored device-login credentials,
 * transparently refreshing (and persisting) one that is within
 * {@link TOKEN_REFRESH_SKEW_MS} of expiry. This is security-sensitive logic
 * (token refresh + persistence), so it lives in exactly one place; each caller
 * supplies its own namespaced "not authenticated" error via `makeAuthError` so
 * the shared helper stays error-type-agnostic.
 *
 * @module @skillsmith/core/sync/access-token
 */

import {
  loadCredentials,
  refreshAccessToken,
  storeCredentials,
} from '../config/token-credentials.js'

/** Refresh the access token this many ms before it actually expires. */
export const TOKEN_REFRESH_SKEW_MS = 60_000

/**
 * Resolve a fresh access token, refreshing (and persisting) if the stored one
 * is within {@link TOKEN_REFRESH_SKEW_MS} of expiry.
 *
 * @param makeAuthError - Factory for the caller's namespaced auth error, thrown
 *   when there are no stored credentials or the refresh fails. Kept as a factory
 *   (not a value) so the stack originates at the throw site.
 * @throws Whatever `makeAuthError()` returns, on no/expired-unrefreshable session.
 */
export async function resolveAccessToken(makeAuthError: () => Error): Promise<string> {
  const creds = await loadCredentials()
  if (!creds) throw makeAuthError()

  if (creds.expiresAt <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    const refreshed = await refreshAccessToken(creds.refreshToken)
    if (!refreshed) throw makeAuthError()
    await storeCredentials(refreshed)
    return refreshed.accessToken
  }

  return creds.accessToken
}
