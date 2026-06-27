/**
 * Inventory upload HTTP client (SMI-5392, umbrella SMI-5382).
 *
 * Authenticates with the stored device-login session (JWT + refresh) and POSTs a
 * full inventory snapshot to the gateway-verified `inventory-upload` edge
 * function. Maps the edge function's status codes onto typed errors so callers
 * (CLI command, MCP tool) can render precise, actionable messages.
 *
 * @module @skillsmith/core/sync/inventory-client
 */

import {
  loadCredentials,
  refreshAccessToken,
  storeCredentials,
} from '../config/token-credentials.js'
import { DEFAULT_BASE_URL, PRODUCTION_ANON_KEY } from '../api/utils.js'
import type { InventoryUploadPayload, InventoryUploadResult } from './inventory-types.js'

/**
 * No usable session (no stored credentials, or a refresh that failed). The
 * message hints at the recovery action so the CLI/MCP surface can relay it.
 *
 * @see SMI-5392
 */
export class InventoryAuthError extends Error {
  constructor(message = 'Not authenticated. Run `skillsmith login` and try again.') {
    super(message)
    this.name = 'InventoryAuthError'
  }
}

/**
 * The `device_id` is already owned by another user (HTTP 409). The user must
 * forget the local device and re-register before retrying.
 *
 * @see SMI-5392
 */
export class InventoryConflictError extends Error {
  constructor(message = 'device_conflict') {
    super(message)
    this.name = 'InventoryConflictError'
  }
}

/**
 * The server rejected the payload as malformed (HTTP 400) — e.g.
 * `device_id_required`, `too_many_skills`, or an invalid field.
 *
 * @see SMI-5392
 */
export class InventoryValidationError extends Error {
  constructor(message = 'invalid payload') {
    super(message)
    this.name = 'InventoryValidationError'
  }
}

/**
 * Catch-all for transport failures and unexpected server responses (HTTP 5xx,
 * network errors, unparseable bodies).
 *
 * @see SMI-5392
 */
export class InventoryUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryUploadError'
  }
}

/** Refresh the access token this many ms before it actually expires. */
const TOKEN_REFRESH_SKEW_MS = 60_000

/**
 * Resolve a fresh access token, refreshing (and persisting) if the stored one is
 * within {@link TOKEN_REFRESH_SKEW_MS} of expiry.
 *
 * @throws {InventoryAuthError} When no credentials exist or the refresh fails.
 */
async function resolveAccessToken(): Promise<string> {
  const creds = await loadCredentials()
  if (!creds) throw new InventoryAuthError()

  if (creds.expiresAt <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    const refreshed = await refreshAccessToken(creds.refreshToken)
    if (!refreshed) throw new InventoryAuthError()
    await storeCredentials(refreshed)
    return refreshed.accessToken
  }

  return creds.accessToken
}

/**
 * Best-effort extraction of the server's `{ error: string }` body so a typed
 * error can carry the precise server message. Returns `null` when the body is
 * absent or not JSON.
 */
async function readServerError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : null
  } catch {
    return null
  }
}

/**
 * Upload a full inventory snapshot for this device.
 *
 * A `200` response is returned verbatim — this INCLUDES the consent-off no-op
 * `{ ok: true, applied: false, reason: 'consent_disabled' }`, which is a success,
 * not an error.
 *
 * @param payload - The device + skills snapshot to upload.
 * @returns The edge function's {@link InventoryUploadResult}.
 * @throws {InventoryAuthError} HTTP 401, or no/expired session.
 * @throws {InventoryConflictError} HTTP 409 (device owned by another user).
 * @throws {InventoryValidationError} HTTP 400 (malformed / oversized payload).
 * @throws {InventoryUploadError} HTTP 5xx, network failure, or unparseable 200 body.
 * @see SMI-5392
 */
export async function uploadInventory(
  payload: InventoryUploadPayload
): Promise<InventoryUploadResult> {
  const accessToken = await resolveAccessToken()

  let res: Response
  try {
    res = await fetch(`${DEFAULT_BASE_URL}/inventory-upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: PRODUCTION_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new InventoryUploadError(`Inventory upload request failed: ${detail}`)
  }

  if (res.ok) {
    try {
      return (await res.json()) as InventoryUploadResult
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new InventoryUploadError(`Inventory upload returned an unreadable body: ${detail}`)
    }
  }

  const serverError = await readServerError(res)
  switch (res.status) {
    case 401:
      throw new InventoryAuthError()
    case 409:
      throw new InventoryConflictError(serverError ?? 'device_conflict')
    case 400:
      throw new InventoryValidationError(serverError ?? 'invalid payload')
    default:
      throw new InventoryUploadError(
        `Inventory upload failed (HTTP ${res.status})${serverError ? `: ${serverError}` : ''}`
      )
  }
}
