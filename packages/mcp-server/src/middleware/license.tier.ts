/**
 * Live subscription-tier resolution for the MCP license middleware.
 *
 * SMI-1953: The MCP server's license middleware historically only resolved a
 * tier from a signed enterprise license blob (`SKILLSMITH_LICENSE_KEY`). A
 * paying Individual/Team customer authenticating with a personal API key
 * (`SKILLSMITH_API_KEY`) but no enterprise key was therefore *always* reported
 * as community tier — the ~6-month silent-degradation bug this module fixes.
 *
 * These helpers are extracted from `license.ts` to keep that file under the
 * 500-line standard (mirrors the earlier `license.gate.ts` extraction). The
 * `getLicenseInfo()` branch that calls `resolveTierViaApiKey` still lives in
 * `license.ts`; only the resolution mechanics live here.
 *
 * @see docs/internal/implementation/smi-1953-mcp-tier-resolution.md
 */

import { getApiBaseUrl } from '@skillsmith/core'
import { FEATURE_TIERS, type FeatureFlag } from './toolFeatureMapping.js'
import type { LicenseInfo, LicenseTier, LicenseMiddlewareContext } from './license.js'

/**
 * Timeout for the `/license-status` request. Matches the 5s precedent used by
 * `@skillsmith/core`'s `checkApiHealth` (client.health.ts).
 */
const LICENSE_STATUS_TIMEOUT_MS = 5000

/**
 * Short cache TTL applied to NON-definitive (transient) outcomes so the next
 * call retries soon instead of serving a doubly-stale value for the full
 * `cacheTtl` window.
 */
const STALE_ERROR_TTL_MS = 30_000

/**
 * Total ordering of tiers: community < individual < team < enterprise.
 *
 * `FEATURE_TIERS` only maps flags to individual/team/enterprise (community has
 * no paid features), so 'community' sits below all of them here and grants
 * nothing.
 */
const TIER_RANK: Record<LicenseTier, number> = {
  community: 0,
  individual: 1,
  team: 2,
  enterprise: 3,
}

/**
 * Response contract from the `/license-status` edge function (SMI-1953).
 *
 * - 200 `{ data: { authenticated: true, tier, rateLimit, userId } }` — resolved.
 * - 200 `{ data: { authenticated: false } }` — definitive "not authenticated"
 *   (bad/expired/revoked/missing key), NOT a network problem.
 * - 429 — the endpoint's OWN internal abuse rate limit (transient), distinct
 *   from quota/tier rate limiting.
 */
interface LicenseStatusResponse {
  data?: {
    authenticated?: boolean
    tier?: LicenseTier
    rateLimit?: number
    userId?: string
  }
}

/**
 * Build the full FLAT feature set granted by a live-resolved subscription tier.
 *
 * Individual/Team tiers are non-a-la-carte in the Skillsmith business model, so
 * a resolved tier grants EVERY feature whose required tier is at or below it:
 * a 'team' result includes all individual- AND team-tier features, but not
 * enterprise features; 'enterprise' includes everything; 'community' grants
 * nothing (empty array).
 *
 * This is deliberately "at or below", not exact-match. An exact-match set would
 * pass `checkFeature()`'s tier-level gate but then FAIL its subsequent
 * `license.features.includes(feature)` check — reproducing the very
 * `license_required` error SMI-1953 eliminates, just with a different-sounding
 * reason.
 *
 * @param tier - The resolved subscription tier.
 * @returns Every FeatureFlag entitled at or below `tier`.
 */
export function featuresForTier(tier: LicenseTier): FeatureFlag[] {
  const ceiling = TIER_RANK[tier]
  return (Object.keys(FEATURE_TIERS) as FeatureFlag[]).filter(
    (flag) => TIER_RANK[FEATURE_TIERS[flag]] <= ceiling
  )
}

/**
 * Build the `/license-status` URL from the configured API base.
 *
 * Mirrors `packages/cli/src/commands/login.ts`'s `functionUrl()`:
 * `getApiBaseUrl()` already ends with `/functions/v1` in production, but this
 * normalizes for other (dev/test) configs that point at a bare base URL.
 */
function licenseStatusUrl(): string {
  const base = getApiBaseUrl()
  return base.endsWith('/functions/v1')
    ? `${base}/license-status`
    : `${base}/functions/v1/license-status`
}

/**
 * Create a tier resolver bound to a specific middleware context + cache TTL.
 *
 * The returned `resolveTierViaApiKey` NEVER throws — every path returns a
 * `LicenseInfo` (definitive tier, definitive community, stale-served-on-error,
 * or fresh-community-on-first-error) and writes the appropriate cache TTL.
 *
 * @param context - Shared middleware context (holds the cache).
 * @param cacheTtlMs - Full TTL for DEFINITIVE results.
 * @returns The `resolveTierViaApiKey(apiKey)` function.
 */
export function createTierResolver(
  context: LicenseMiddlewareContext,
  cacheTtlMs: number
): (apiKey: string) => Promise<LicenseInfo> {
  function buildCommunityLicense(): LicenseInfo {
    return { valid: true, tier: 'community', features: [] }
  }

  /**
   * Handle a NON-definitive outcome (network error / timeout / 429 / 5xx /
   * unexpected shape). These are not stable signals, so we never cache them at
   * full TTL: reuse the last-known-good value if any (stale-if-error, even if
   * its `cacheExpiry` has already passed), otherwise fall to community — either
   * way for a short 30s TTL so the next call retries soon.
   */
  function handleTransientFailure(reason: string): LicenseInfo {
    const shortExpiry = Date.now() + STALE_ERROR_TTL_MS
    const stale = context.cachedLicense
    if (stale) {
      context.cacheExpiry = shortExpiry
      console.warn(
        `[skillsmith] SMI-1953 live tier check failed (${reason}); serving stale-cached ` +
          `tier '${stale.tier}', retrying in ${STALE_ERROR_TTL_MS / 1000}s`
      )
      return stale
    }
    const community = buildCommunityLicense()
    context.cachedLicense = community
    context.cacheExpiry = shortExpiry
    console.warn(
      `[skillsmith] SMI-1953 live tier check failed (${reason}) with no prior cache; ` +
        `defaulting to community for ${STALE_ERROR_TTL_MS / 1000}s then retrying`
    )
    return community
  }

  return async function resolveTierViaApiKey(apiKey: string): Promise<LicenseInfo> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), LICENSE_STATUS_TIMEOUT_MS)

    try {
      const response = await fetch(licenseStatusUrl(), {
        headers: { 'X-API-Key': apiKey },
        signal: controller.signal,
      })

      // Transient HTTP failures: the endpoint's own abuse rate limit (429) or a
      // server error (5xx). Neither is a stable tier signal.
      if (response.status === 429 || response.status >= 500) {
        return handleTransientFailure(response.status === 429 ? '429' : `5xx (${response.status})`)
      }

      let body: LicenseStatusResponse | null
      try {
        body = (await response.json()) as LicenseStatusResponse | null
      } catch {
        return handleTransientFailure('malformed-body')
      }
      const data = body?.data

      // DEFINITIVE: authenticated with a resolved subscription tier. Cache full.
      if (response.ok && data?.authenticated === true && data.tier) {
        const tier = data.tier
        const license: LicenseInfo = {
          valid: true,
          tier,
          features: featuresForTier(tier),
          organizationId: data.userId,
        }
        context.cachedLicense = license
        context.cacheExpiry = Date.now() + cacheTtlMs
        console.warn(`[skillsmith] SMI-1953 live tier resolved: '${tier}' (via personal API key)`)
        return license
      }

      // DEFINITIVE: bad/expired/revoked/missing key. Stable "not authenticated".
      if (response.ok && data?.authenticated === false) {
        const community = buildCommunityLicense()
        context.cachedLicense = community
        context.cacheExpiry = Date.now() + cacheTtlMs
        console.warn(
          '[skillsmith] SMI-1953 live tier resolved: community (API key not authenticated)'
        )
        return community
      }

      // Unexpected status/shape (or authenticated without a tier) is NOT
      // definitive — treat as transient so a real customer is never demoted at
      // full TTL by a misconfiguration.
      return handleTransientFailure(`unexpected-response (status ${response.status})`)
    } catch {
      // fetch threw: network error, or AbortError from the timeout.
      return handleTransientFailure(controller.signal.aborted ? 'timeout' : 'network-error')
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
