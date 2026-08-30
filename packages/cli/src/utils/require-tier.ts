/**
 * @fileoverview requireTier — CLI license tier gate helper
 * @module @skillsmith/cli/utils/require-tier
 * @see SMI-skill-version-tracking Wave 1
 * @see SMI-6271 (Wave 1 of SMI-6266) — live credential-aware tier resolution
 *
 * Throws a user-friendly error when the current license tier is below
 * the minimum required for a CLI command or flag.
 *
 * Security properties:
 *  - Fail-secure: key present + validation failure → block, never fall back
 *    to community to silently allow access
 *  - SKILLSMITH_SKIP_LICENSE_CHECK=true is a CI/dev escape hatch only; it
 *    must use bracket notation per TypeScript/ESLint index-signature rules
 *  - SKILLSMITH_LICENSE_KEY is read from env but never logged
 *
 * SMI-6271: prior to this change, `requireTier()` (via `getLicenseStatus()`)
 * ONLY resolved `SKILLSMITH_LICENSE_KEY` — an enterprise-signed offline JWT.
 * A user authenticated via a personal `SKILLSMITH_API_KEY` or a stored
 * `skillsmith login` device session was always treated as community tier
 * regardless of their real subscription, the exact bug class SMI-1953 and
 * SMI-6098 already fixed for the MCP server. `resolveEffectiveTier()` below
 * generalizes that fix to the CLI, resolving whichever credential is
 * actually present (license key > API key > device session > none) via a
 * live `/license-status` call for the latter two — mirroring
 * `packages/mcp-server/src/middleware/license.tier.ts`'s `createTierResolver`
 * (API key) and `packages/core/src/sync/license-status-client.ts`'s
 * `resolveSessionTier()` (device session), which this module reuses directly.
 */

import {
  getApiBaseUrl,
  getApiKey,
  loadCredentials,
  resolveSessionTier,
  SessionTierAuthError,
  SessionTierTransientError,
} from '@skillsmith/core'
import { getLicenseStatus } from './license-validation.js'
import type { LicenseStatus, LicenseTier } from './license-types.js'
import { TIER_FEATURES } from './license-types.js'

/**
 * Ordered license tiers, lowest to highest.
 * Used for tier comparison arithmetic.
 */
const TIER_ORDER: LicenseTier[] = ['community', 'individual', 'team', 'enterprise']

/**
 * Prices for use in upgrade messages
 */
const TIER_PRICING: Record<LicenseTier, string> = {
  community: '$0/month',
  individual: '$9.99/month',
  team: '$25/user/month',
  enterprise: 'Custom pricing — Contact Sales',
}

/**
 * Timeout for the live `/license-status` request. Matches the 5s precedent
 * already used by `license.tier.ts` (MCP) and `license-status-client.ts` (core).
 *
 * Exported so tests can advance fake timers by exactly this amount to prove
 * the `AbortController` wiring is real, rather than hardcoding a duplicate
 * magic number that could silently drift from the actual value.
 */
export const LICENSE_STATUS_TIMEOUT_MS = 5000

/** The tier values a genuine `authenticated: true` response can carry. */
const KNOWN_TIERS = new Set<string>(['community', 'individual', 'team', 'enterprise'])

/** Which credential (if any) `resolveEffectiveTier()` resolved its result from. */
export type EffectiveTierSource = 'license-key' | 'api-key' | 'session' | 'none'

/**
 * Result of a credential-aware tier resolution.
 *
 * `transient: true` means the live check could not complete (network error,
 * timeout, HTTP 429/5xx, or an unparseable/unexpected response) — `status` in
 * that case is a placeholder (community), NOT a definitive signal. A
 * fail-closed caller (e.g. `requireTier()`) must refuse to trust `status` and
 * report a "could not verify" error rather than silently pass or silently
 * downgrade a real paying customer.
 */
export interface EffectiveTierResult {
  status: LicenseStatus
  source: EffectiveTierSource
  transient: boolean
}

function communityStatus(): LicenseStatus {
  return { valid: true, tier: 'community', features: TIER_FEATURES.community }
}

function definitiveResult(source: EffectiveTierSource, status: LicenseStatus): EffectiveTierResult {
  return { status, source, transient: false }
}

function transientResult(source: EffectiveTierSource): EffectiveTierResult {
  return { status: communityStatus(), source, transient: true }
}

/**
 * Build the `/license-status` URL from the CLI's configured API base.
 * Mirrors `packages/cli/src/commands/login.ts`'s `functionUrl()` and
 * `packages/mcp-server/src/middleware/license.tier.ts`'s `licenseStatusUrl()`:
 * `getApiBaseUrl()` already ends with `/functions/v1` in production, but this
 * normalizes for other (dev/test) configs that point at a bare base URL.
 */
function licenseStatusUrl(): string {
  const base = getApiBaseUrl()
  return base.endsWith('/functions/v1')
    ? `${base}/license-status`
    : `${base}/functions/v1/license-status`
}

/** Response contract from the `/license-status` edge function (SMI-1953/SMI-6271). */
interface LicenseStatusResponse {
  data?: {
    authenticated?: boolean
    tier?: string
  }
}

/**
 * Resolve tier via a personal `SKILLSMITH_API_KEY`, calling `/license-status`
 * live with `X-API-Key`. Mirrors `license.tier.ts`'s `createTierResolver`
 * exactly, minus that function's cross-call caching (a CLI invocation is a
 * single short-lived process, so there is nothing to cache across).
 */
async function resolveViaApiKey(apiKey: string): Promise<EffectiveTierResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), LICENSE_STATUS_TIMEOUT_MS)

  try {
    let response: Response
    try {
      response = await fetch(licenseStatusUrl(), {
        headers: { 'X-API-Key': apiKey },
        signal: controller.signal,
      })
    } catch {
      // Network error or AbortError from the timeout — not a definitive signal.
      return transientResult('api-key')
    }

    // The endpoint's own abuse rate limit (429) or a server error (5xx) —
    // neither is a stable tier signal.
    if (response.status === 429 || response.status >= 500) {
      return transientResult('api-key')
    }

    let body: LicenseStatusResponse | null
    try {
      body = (await response.json()) as LicenseStatusResponse | null
    } catch {
      return transientResult('api-key')
    }

    const data = body?.data

    // DEFINITIVE: authenticated with a recognized tier.
    if (response.ok && data?.authenticated === true && data.tier && KNOWN_TIERS.has(data.tier)) {
      const tier = data.tier as LicenseTier
      return definitiveResult('api-key', { valid: true, tier, features: TIER_FEATURES[tier] })
    }

    // DEFINITIVE: bad/expired/revoked/missing key — stable "not authenticated".
    // A contradictory shape (authenticated:false but a real tier present) is
    // NOT trustworthy — the endpoint's contract is that an unauthenticated
    // response carries no tier, so seeing both together means something is
    // wrong with the response itself, not a clean "not authenticated" signal.
    if (response.ok && data?.authenticated === false) {
      if (data.tier) {
        return transientResult('api-key')
      }
      return definitiveResult('api-key', communityStatus())
    }

    // Unexpected status/shape, or authenticated:true with a missing/garbage
    // tier — NOT definitive. Mirrors resolveSessionTier()'s own defense-in-
    // depth against a malformed "authenticated:true, no real tier" response.
    return transientResult('api-key')
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Resolve tier via a stored `skillsmith login` device session, reusing
 * `resolveSessionTier()` (`@skillsmith/core`) directly — the same client
 * SMI-6098 wired into the MCP server's session-token path.
 */
async function resolveViaSession(): Promise<EffectiveTierResult> {
  try {
    const result = await resolveSessionTier()

    // DEFINITIVE: a verified session with a resolved tier — including a
    // verified user who genuinely has no paid entitlement (community).
    if (result.authenticated && result.tier && KNOWN_TIERS.has(result.tier)) {
      const tier = result.tier as LicenseTier
      return definitiveResult('session', { valid: true, tier, features: TIER_FEATURES[tier] })
    }

    // DEFINITIVE: the server verified the JWT and found no session — a
    // stable "not authenticated" signal. A contradictory shape
    // (authenticated:false but a real tier present) is NOT trustworthy —
    // same defensive posture as resolveViaApiKey() above: the endpoint's
    // contract is that an unauthenticated response carries no tier, so
    // seeing both together means the response itself is suspect.
    if (result.authenticated === false) {
      if (result.tier) {
        return transientResult('session')
      }
      return definitiveResult('session', communityStatus())
    }

    return transientResult('session')
  } catch (error) {
    if (error instanceof SessionTierAuthError) {
      // SMI-6271 review finding: this catch is reached from exactly ONE call
      // site (resolveEffectiveTier()'s `if (hasSession) return
      // resolveViaSession()`), which already confirmed loadCredentials() !==
      // null moments earlier. Given that precondition, a SessionTierAuthError
      // surfacing HERE is (barring a narrow TOCTOU race) never the "no
      // session ever existed" case — resolveAccessToken() only throws this
      // error for that case OR for "a refresh attempt failed", and the two
      // are indistinguishable from the caught error alone (refreshAccessToken()
      // in token-credentials.ts collapses a network/transport failure during
      // refresh and a definitive refresh-token rejection into the same null).
      // A refresh failure can be a transient network blip, so treating this
      // as a definitive community downgrade would silently downgrade a real
      // paying customer on that blip — exactly the failure mode this wave
      // exists to prevent, and the same reasoning
      // packages/mcp-server/src/middleware/license.tier.ts's
      // createSessionTokenResolver (SMI-6098) already applies to the
      // identical ambiguity. Treat as transient, not definitive.
      return transientResult('session')
    }
    if (error instanceof SessionTierTransientError) {
      return transientResult('session')
    }
    // Unexpected error shape — treat conservatively as transient rather than
    // silently collapsing to a definitive community result.
    return transientResult('session')
  }
}

/**
 * Resolve the caller's effective license tier from whichever credential is
 * actually configured, in precedence order:
 *
 *  1. `SKILLSMITH_LICENSE_KEY` (enterprise-signed offline JWT) — unchanged,
 *     pre-existing behavior via `getLicenseStatus()`. Always definitive.
 *  2. `SKILLSMITH_API_KEY` (env or `~/.skillsmith/config.json`) — live
 *     `/license-status` call via `resolveViaApiKey()`.
 *  3. A stored `skillsmith login` device session — live `/license-status`
 *     call via `resolveViaSession()`. Gated on a cheap local
 *     `loadCredentials()` existence check first so a never-logged-in
 *     community user never pays a network round trip.
 *  4. No credential of any kind — community, definitive. Matches the
 *     pre-existing `getLicenseStatus()` no-key default exactly.
 *
 * NEVER throws — every path returns an `EffectiveTierResult`. Callers decide
 * their own fail-open/fail-closed policy for `transient: true` (see
 * `requireTier()` below for the fail-closed default).
 */
export async function resolveEffectiveTier(): Promise<EffectiveTierResult> {
  if (process.env['SKILLSMITH_LICENSE_KEY']) {
    return definitiveResult('license-key', await getLicenseStatus())
  }

  const apiKey = getApiKey()
  if (apiKey) {
    return resolveViaApiKey(apiKey)
  }

  const hasSession = (await loadCredentials()) !== null
  if (hasSession) {
    return resolveViaSession()
  }

  return definitiveResult('none', communityStatus())
}

/**
 * Throw if the current license tier is below minimumTier.
 *
 * Call this at the top of any CLI command or action that requires a paid tier.
 *
 * SMI-6271: resolves tier via `resolveEffectiveTier()` (license key > API key
 * > device session > community), not `SKILLSMITH_LICENSE_KEY` alone.
 *
 * Fail-closed on a transient live-check failure (`resolveEffectiveTier()`
 * returning `transient: true`): every current caller of `requireTier()`
 * (`audit advisories`, `diff`, `pin`) is a purely local operation with no
 * subsequent authoritative server-side gate for the same request, unlike
 * `registry-sync`'s own `requireSyncTier()` (which may safely defer to the
 * server's authoritative 403 because one exists for that specific request).
 * Silently passing here on a network blip would let a community caller
 * through on transient failure; silently downgrading would incorrectly block
 * a real paying customer. Neither is acceptable, so this reports a clear
 * "try again" error instead.
 *
 * @param minimumTier - Minimum tier required to use the feature
 * @throws Error with an upgrade prompt when the tier requirement is not met
 * @throws Error when a license key is present but fails validation (fail-secure)
 * @throws Error when the live tier check could not complete (fail-closed)
 *
 * @example
 * ```typescript
 * export function createOutdatedCommand(): Command {
 *   return new Command('outdated')
 *     .action(async () => {
 *       await requireTier('individual')
 *       // ... rest of command
 *     })
 * }
 * ```
 */
export async function requireTier(minimumTier: LicenseTier): Promise<void> {
  // CI / dev escape hatch — must use bracket notation (TS index-signature rule)
  if (process.env['SKILLSMITH_SKIP_LICENSE_CHECK'] === 'true') {
    return
  }

  const result = await resolveEffectiveTier()

  if (result.transient) {
    throw new Error(
      'Could not verify your subscription tier — the live tier check failed ' +
        '(network error or a transient server issue). Please try again in a moment.'
    )
  }

  const status = result.status

  // Fail-secure (SKILLSMITH_LICENSE_KEY path, unchanged): key present +
  // validation failure → block. Never silently fall back to community when a
  // key was supplied.
  const hasLicenseKey = Boolean(process.env['SKILLSMITH_LICENSE_KEY'])
  if (hasLicenseKey && !status.valid) {
    throw new Error(
      `License validation failed. ` +
        `Please check your SKILLSMITH_LICENSE_KEY or visit https://skillsmith.app/account to manage your license.`
    )
  }

  const currentTier = (status.tier ?? 'community') as LicenseTier
  const currentIndex = TIER_ORDER.indexOf(currentTier)
  const requiredIndex = TIER_ORDER.indexOf(minimumTier)

  if (currentIndex < requiredIndex) {
    const pricing = TIER_PRICING[minimumTier]
    throw new Error(
      `This feature requires ${minimumTier} tier or higher (${pricing}). ` +
        `You are currently on the ${currentTier} tier. ` +
        `Upgrade at https://skillsmith.app/upgrade?tier=${minimumTier}`
    )
  }
}
