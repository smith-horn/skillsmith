/**
 * Refresh-on-401 logic for SkillsmithApiClient (SMI-4402)
 * @module api/client.token-refresh
 *
 * Companion to client.ts. Extracted to keep client.ts under the 500-line
 * CI file-length limit. Handles the JWT token refresh flow: load stored
 * credentials, call refreshAccessToken, persist refreshed creds.
 */

import {
  loadCredentials,
  refreshAccessToken,
  storeCredentials,
} from '../config/token-credentials.js'

/**
 * Attempt to refresh the current access token.
 * Loads stored credentials, exchanges the refresh token, persists the new tokens.
 *
 * @returns New access token if refresh succeeded, null otherwise.
 */
export async function tryRefreshToken(): Promise<string | null> {
  const creds = await loadCredentials()
  if (!creds) return null

  const refreshed = await refreshAccessToken(creds.refreshToken)
  if (!refreshed) return null

  await storeCredentials(refreshed)
  return refreshed.accessToken
}

/**
 * Load the access token from stored credentials.
 * Returns null if no JWT credentials are stored (legacy apiKey-only users).
 */
export async function loadStoredAccessToken(): Promise<string | null> {
  const creds = await loadCredentials()
  if (!creds) return null
  return creds.accessToken
}
