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
