// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * SMI-1091: Quota Enforcement Middleware for MCP Server
 *
 * Enforces API call quotas based on license tier.
 * Integrates with the license middleware and QuotaEnforcementService.
 *
 * Tier Limits (SMI-5558):
 * - Community: 100 API calls/month (free)
 * - Individual: 1,000 API calls/month ($9.99/mo)
 * - Team: 10,000 API calls/month ($25/user/mo)
 * - Enterprise: Unlimited
 *
 * Unlike the edge function's `quota-enforcer.ts` (which only hard-blocks
 * Community and only when `ENFORCE_COMMUNITY_QUOTA=true`), this middleware
 * has historically hard-blocked ALL non-unlimited tiers unconditionally.
 * `SKILLSMITH_ENFORCE_MCP_QUOTA` (SMI-5558) adds a kill-switch so that behavior can be
 * disabled without a redeploy if the 10x-lower quotas cause unexpected
 * paid-tier disruption. Defaults to enforcing (preserves prior behavior).
 *
 * @see SMI-1055: Add license middleware to MCP server
 * @see packages/enterprise/src/quota/QuotaEnforcementService.ts
 */

import type { LicenseMiddleware, LicenseInfo, LicenseTier } from './license.js'
import { buildQuotaExceededResponse, type MCPErrorResponse } from './errorFormatter.js'

// Import types from quota-types.ts
export type {
  QuotaCheckResult,
  QuotaMetadata,
  QuotaMiddlewareOptions,
  QuotaStorage,
  QuotaMiddleware,
  WarningLevel,
} from './quota-types.js'

import type {
  QuotaCheckResult,
  QuotaMetadata,
  QuotaMiddlewareOptions,
  QuotaMiddleware,
} from './quota-types.js'

// Import helpers from quota-helpers.ts
import {
  InMemoryQuotaStorage,
  getWarningLevel,
  getWarningMessage,
  getCustomerId,
} from './quota-helpers.js'

// ============================================================================
// Configuration
// ============================================================================

/**
 * Tier quota limits (API calls per month)
 * -1 represents unlimited
 * SMI-5558: reduced 10x (community was 1_000, individual was 10_000, team was 100_000).
 */
const TIER_QUOTAS: Record<LicenseTier, number> = {
  community: 100,
  individual: 1_000,
  team: 10_000,
  enterprise: -1, // Unlimited
}

/**
 * Configuration for the upgrade URL
 */
const UPGRADE_URL = 'https://skillsmith.app/upgrade'

/**
 * SMI-5558 kill-switch: whether over-quota requests are actually hard-blocked.
 * Defaults to enforcing (`true`) — matches the pre-existing unconditional
 * hard-block behavior of this middleware. Set `SKILLSMITH_ENFORCE_MCP_QUOTA=false` to
 * disable blocking (usage is still tracked and reported) without a redeploy,
 * e.g. if the reduced quotas cause unexpected paid-tier disruption.
 */
function isQuotaEnforcementEnabled(): boolean {
  return process.env.SKILLSMITH_ENFORCE_MCP_QUOTA !== 'false'
}

// ============================================================================
// Quota Middleware Factory
// ============================================================================

/**
 * Create a quota enforcement middleware
 *
 * @param options - Configuration options
 * @returns Quota middleware instance
 *
 * @example
 * ```typescript
 * import { createQuotaMiddleware } from './middleware/quota.js';
 * import { createLicenseMiddleware } from './middleware/license.js';
 *
 * const licenseMiddleware = createLicenseMiddleware();
 * const quotaMiddleware = createQuotaMiddleware();
 *
 * // In tool handler:
 * async function handleTool(toolName: string, params: unknown) {
 *   const licenseInfo = await licenseMiddleware.getLicenseInfo();
 *   const quotaResult = await quotaMiddleware.checkAndTrack(toolName, licenseInfo);
 *
 *   if (!quotaResult.allowed) {
 *     return quotaMiddleware.buildExceededResponse(quotaResult);
 *   }
 *
 *   // Execute tool...
 *   const result = await executeTool(toolName, params);
 *
 *   // Add quota metadata to response
 *   return {
 *     ...result,
 *     _meta: {
 *       ...result._meta,
 *       quota: quotaMiddleware.buildMetadata(quotaResult),
 *     },
 *   };
 * }
 * ```
 */
export function createQuotaMiddleware(options: QuotaMiddlewareOptions = {}): QuotaMiddleware {
  const { defaultCost = 1, trackUnlimited = false, storage = new InMemoryQuotaStorage() } = options

  async function checkAndTrack(
    toolName: string,
    licenseInfo: LicenseInfo | null,
    customerId?: string
  ): Promise<QuotaCheckResult> {
    const tier = licenseInfo?.tier ?? 'community'
    const limit = TIER_QUOTAS[tier]
    const effectiveCustomerId = getCustomerId(licenseInfo, customerId)

    // Enterprise tier has unlimited quota
    if (limit === -1) {
      if (trackUnlimited) {
        await storage.incrementUsage(effectiveCustomerId, defaultCost)
      }
      return {
        allowed: true,
        remaining: -1,
        limit: -1,
        percentUsed: 0,
        warningLevel: 0,
        resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      }
    }

    // Get current usage
    const usage = await storage.getUsage(effectiveCustomerId)
    const currentUsed = usage.used
    const newUsed = currentUsed + defaultCost

    // Check if quota would be exceeded
    if (newUsed > limit) {
      const enforced = isQuotaEnforcementEnabled()
      // Kill-switch disabled: still track usage and report over-quota status,
      // but let the call through instead of hard-blocking (SMI-5558).
      if (!enforced) {
        await storage.incrementUsage(effectiveCustomerId, defaultCost)
        const percentUsed = (newUsed / limit) * 100
        return {
          allowed: true,
          remaining: Math.max(0, limit - newUsed),
          limit,
          percentUsed,
          warningLevel: 100,
          resetAt: usage.periodEnd,
          message: getWarningMessage(100, newUsed, limit, tier),
          upgradeUrl: `${UPGRADE_URL}?reason=quota_exceeded&tier=${tier}`,
        }
      }
      const percentUsed = (currentUsed / limit) * 100
      return {
        allowed: false,
        remaining: Math.max(0, limit - currentUsed),
        limit,
        percentUsed,
        warningLevel: 100,
        resetAt: usage.periodEnd,
        message: getWarningMessage(100, currentUsed, limit, tier),
        upgradeUrl: `${UPGRADE_URL}?reason=quota_exceeded&tier=${tier}`,
      }
    }

    // Increment usage
    await storage.incrementUsage(effectiveCustomerId, defaultCost)

    // Calculate warning level
    const percentUsed = (newUsed / limit) * 100
    const warningLevel = getWarningLevel(percentUsed)

    return {
      allowed: true,
      remaining: limit - newUsed,
      limit,
      percentUsed,
      warningLevel,
      resetAt: usage.periodEnd,
      message: getWarningMessage(warningLevel, newUsed, limit, tier),
      upgradeUrl:
        warningLevel >= 90 ? `${UPGRADE_URL}?reason=quota_warning&tier=${tier}` : undefined,
    }
  }

  async function getStatus(
    licenseInfo: LicenseInfo | null,
    customerId?: string
  ): Promise<QuotaCheckResult> {
    const tier = licenseInfo?.tier ?? 'community'
    const limit = TIER_QUOTAS[tier]
    const effectiveCustomerId = getCustomerId(licenseInfo, customerId)

    // Enterprise tier has unlimited quota
    if (limit === -1) {
      return {
        allowed: true,
        remaining: -1,
        limit: -1,
        percentUsed: 0,
        warningLevel: 0,
        resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }
    }

    // Get current usage without incrementing
    const usage = await storage.getUsage(effectiveCustomerId)
    const percentUsed = (usage.used / limit) * 100
    const warningLevel = getWarningLevel(percentUsed)

    return {
      // SMI-5558: kill-switch disabled → report allowed even over quota,
      // mirroring checkAndTrack's enforcement decision.
      allowed: usage.used < limit || !isQuotaEnforcementEnabled(),
      remaining: Math.max(0, limit - usage.used),
      limit,
      percentUsed,
      warningLevel,
      resetAt: usage.periodEnd,
      message: getWarningMessage(warningLevel, usage.used, limit, tier),
      upgradeUrl:
        warningLevel >= 90 ? `${UPGRADE_URL}?reason=quota_warning&tier=${tier}` : undefined,
    }
  }

  function buildMetadata(result: QuotaCheckResult): QuotaMetadata {
    return {
      remaining: result.remaining,
      limit: result.limit,
      resetAt: result.resetAt.toISOString(),
      warning: result.message,
    }
  }

  function buildExceededResponse(result: QuotaCheckResult): MCPErrorResponse {
    const used = result.limit - result.remaining
    return buildQuotaExceededResponse('API calls', used, result.limit)
  }

  return {
    checkAndTrack,
    getStatus,
    buildMetadata,
    buildExceededResponse,
  }
}

// ============================================================================
// Higher-Order Function for Tool Wrapping
// ============================================================================

/**
 * Wrap a tool handler with quota enforcement
 *
 * @param handler - The original tool handler
 * @param licenseMiddleware - License middleware instance
 * @param quotaMiddleware - Quota middleware instance
 * @returns Wrapped handler with quota enforcement
 *
 * @example
 * ```typescript
 * const searchHandler = withQuotaEnforcement(
 *   originalSearchHandler,
 *   licenseMiddleware,
 *   quotaMiddleware
 * );
 * ```
 */
export function withQuotaEnforcement<TParams, TResult>(
  handler: (params: TParams) => Promise<TResult>,
  licenseMiddleware: LicenseMiddleware,
  quotaMiddleware: QuotaMiddleware
): (toolName: string, params: TParams) => Promise<TResult | MCPErrorResponse> {
  return async (toolName: string, params: TParams) => {
    const licenseInfo = await licenseMiddleware.getLicenseInfo()
    const quotaResult = await quotaMiddleware.checkAndTrack(toolName, licenseInfo)

    if (!quotaResult.allowed) {
      return quotaMiddleware.buildExceededResponse(quotaResult)
    }

    // Execute the original handler
    const result = await handler(params)

    // Note: In a real implementation, you would add quota metadata to the result
    // This requires knowing the result structure, which varies by tool
    return result
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a tier has unlimited quota
 */
export function isUnlimitedTier(tier: LicenseTier): boolean {
  return TIER_QUOTAS[tier] === -1
}

/**
 * Get the quota limit for a tier
 */
export function getQuotaLimit(tier: LicenseTier): number {
  return TIER_QUOTAS[tier]
}

/**
 * Format quota remaining for display
 */
export function formatQuotaRemaining(remaining: number, limit: number): string {
  if (limit === -1) {
    return 'Unlimited'
  }
  return `${remaining.toLocaleString()} / ${limit.toLocaleString()}`
}
