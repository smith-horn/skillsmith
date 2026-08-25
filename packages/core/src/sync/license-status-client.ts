/**
 * Session-token tier self-check client (SMI-6098, umbrella SMI-6085).
 *
 * SMI-1953 fixed the MCP server's live tier resolution for a personal
 * `SKILLSMITH_API_KEY`, but a user authenticated only via the standard
 * `skillsmith login` device-session (no separately-configured API key) was
 * never covered — the MCP license middleware always fell back to `community`
 * regardless of real entitlement. This client authenticates with the stored
 * device-login session (proactively refreshing via `resolveAccessToken`) and
 * calls the `license-status` edge function with the session token, mirroring
 * `inventory-client.ts` / `audit-notify-client.ts`.
 *
 * @module @skillsmith/core/sync/license-status-client
 */

import { resolveAccessToken as resolveSessionToken } from './access-token.js'
import { DEFAULT_BASE_URL, PRODUCTION_ANON_KEY } from '../api/utils.js'

/**
 * Timeout for the `license-status` request. Matches `license.tier.ts`'s
 * `LICENSE_STATUS_TIMEOUT_MS` (the API-key resolver's own precedent) — a
 * stalled connection here must not block `getLicenseInfo()` indefinitely.
 */
const LICENSE_STATUS_TIMEOUT_MS = 5000

/** The tier values a genuine `authenticated: true` response can carry. */
const KNOWN_TIERS = new Set(['community', 'individual', 'team', 'enterprise'])

/**
 * No usable device session — none stored, or a refresh attempt failed. This
 * is a real, definitive "not authenticated this way" (same class as a
 * missing/bad API key): callers should fall back to community, cached at
 * the middleware's normal definitive TTL.
 */
export class SessionTierAuthError extends Error {
  constructor(message = 'Not authenticated. Run `skillsmith login` and try again.') {
    super(message)
    this.name = 'SessionTierAuthError'
  }
}

/**
 * A transport or server failure that is NOT a definitive tier signal —
 * network error, timeout, an HTTP 5xx/429 from `license-status`, or an
 * unparseable/unexpected response shape. Callers MUST treat this as
 * transient (retry soon / serve a stale cached value), never collapse it
 * into "community" — a real paying customer must not be downgraded for the
 * full cache TTL just because the tier check itself glitched.
 */
export class SessionTierTransientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionTierTransientError'
  }
}

/** Mirrors `license-status`'s `data` response shape. */
export interface SessionTierResult {
  authenticated: boolean
  /** Raw tier string from the server; validate against the known enum at the call site. */
  tier?: string
  rateLimit?: number
  userId?: string
}

/**
 * Resolve the caller's real subscription tier via the device-login session.
 *
 * `authenticated: false` in the returned result is itself a DEFINITIVE
 * signal (the server verified the JWT and found no session), distinct from
 * the thrown errors below, which mean the check couldn't be completed at
 * all.
 *
 * @throws {SessionTierAuthError} No stored session, or the proactive refresh failed.
 * @throws {SessionTierTransientError} Network error, HTTP 429/5xx, or an
 *   unparseable/unexpected response — not a definitive tier signal.
 */
export async function resolveSessionTier(): Promise<SessionTierResult> {
  const accessToken = await resolveSessionToken(() => new SessionTierAuthError())

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), LICENSE_STATUS_TIMEOUT_MS)

  let res: Response
  try {
    try {
      res = await fetch(`${DEFAULT_BASE_URL}/license-status`, {
        method: 'GET',
        headers: {
          apikey: PRODUCTION_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      })
    } catch (error) {
      const detail = controller.signal.aborted
        ? 'timeout'
        : error instanceof Error
          ? error.message
          : String(error)
      throw new SessionTierTransientError(`license-status request failed: ${detail}`)
    }
  } finally {
    clearTimeout(timeoutId)
  }

  // license-status's own abuse rate limit (429), or a server error — neither
  // is a stable tier signal (mirrors createTierResolver's API-key handling).
  if (res.status === 429 || res.status >= 500) {
    throw new SessionTierTransientError(`license-status returned HTTP ${res.status}`)
  }

  let body: { data?: SessionTierResult } | null
  try {
    body = (await res.json()) as { data?: SessionTierResult } | null
  } catch {
    throw new SessionTierTransientError('license-status returned an unreadable body')
  }

  const data = body?.data
  if (!res.ok || !data || typeof data.authenticated !== 'boolean') {
    throw new SessionTierTransientError(
      `license-status returned an unexpected response (status ${res.status})`
    )
  }

  // A genuine `authenticated: true` response must carry a recognized tier.
  // Without this, a malformed/buggy response (authenticated:true, no tier,
  // or a garbage tier string) would fall through the middleware's "no tier"
  // branch and get silently cached as a DEFINITIVE community result — the
  // exact anti-pattern the server side already guards against, mirrored
  // here for defense-in-depth.
  if (data.authenticated === true && !KNOWN_TIERS.has(data.tier ?? '')) {
    throw new SessionTierTransientError(
      `license-status returned authenticated:true with an unrecognized tier: ${String(data.tier)}`
    )
  }

  return data
}
