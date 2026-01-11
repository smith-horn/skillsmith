// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * SMI-1091: Quota Enforcement Middleware for MCP Server
 *
 * Enforces API call quotas based on license tier.
 * Integrates with the license middleware and QuotaEnforcementService.
 *
 * Tier Limits:
 * - Community: 1,000 API calls/month (free)
 * - Individual: 10,000 API calls/month ($9.99/mo)
 * - Team: 100,000 API calls/month ($25/user/mo)
 * - Enterprise: Unlimited
 *
 * @see SMI-1055: Add license middleware to MCP server
 * @see packages/enterprise/src/quota/QuotaEnforcementService.ts
 */

import type { LicenseMiddleware, LicenseInfo, LicenseTier } from './license.js'
import { buildQuotaExceededResponse, type MCPErrorResponse } from './errorFormatter.js'

// ============================================================================
// Configuration
// ============================================================================

/**
 * Tier quota limits (API calls per month)
 * -1 represents unlimited
 */
const TIER_QUOTAS: Record<LicenseTier, number> = {
  community: 1_000,
  individual: 10_000,
  team: 100_000,
  enterprise: -1, // Unlimited
}

/**
 * Warning threshold type for quota levels
 */
type WarningLevel = 0 | 80 | 90 | 100

/**
 * Configuration for the upgrade URL
 */
const UPGRADE_URL = 'https://skillsmith.app/upgrade'

// ============================================================================
// Types
// ============================================================================

/**
 * Quota check result returned after validating usage
 */
export interface QuotaCheckResult {
  /** Whether the tool call is allowed */
  allowed: boolean
  /** Remaining API calls in the current period */
  remaining: number
  /** Total limit for the current tier (-1 for unlimited) */
  limit: number
  /** Percentage of quota used (0-100+) */
  percentUsed: number
  /** Current warning level (0, 80, 90, or 100) */
  warningLevel: WarningLevel
  /** When the quota resets (start of next billing period) */
  resetAt: Date
  /** Warning or error message if applicable */
  message?: string
  /** Upgrade URL if quota is exceeded or near limit */
  upgradeUrl?: string
}

/**
 * Quota information to include in response metadata
 */
export interface QuotaMetadata {
  /** Remaining API calls */
  remaining: number
  /** Total limit (-1 for unlimited) */
  limit: number
  /** When the quota resets */
  resetAt: string
  /** Warning message if approaching limit */
  warning?: string
}

/**
 * Quota middleware configuration options
 */
export interface QuotaMiddlewareOptions {
  /**
   * Cost of each API call (default: 1)
   * Can be customized per tool if some tools are more expensive
   */
  defaultCost?: number

  /**
   * Whether to track usage even for unlimited tiers (enterprise)
   * Useful for analytics purposes
   */
  trackUnlimited?: boolean

  /**
   * Custom storage adapter for quota tracking
   * If not provided, uses in-memory storage (resets on restart)
   */
  storage?: QuotaStorage
}

/**
 * Interface for quota storage adapters
 */
export interface QuotaStorage {
  /** Get current usage for a customer in the current period */
  getUsage(customerId: string): Promise<{ used: number; periodStart: Date; periodEnd: Date }>
  /** Increment usage count */
  incrementUsage(customerId: string, cost: number): Promise<void>
  /** Initialize quota for a new billing period */
  initializePeriod(customerId: string, limit: number): Promise<void>
}

/**
 * Quota middleware instance
 */
export interface QuotaMiddleware {
  /**
   * Check if a tool call is allowed and track usage
   * Call this BEFORE executing the tool
   */
  checkAndTrack(
    toolName: string,
    licenseInfo: LicenseInfo | null,
    customerId?: string
  ): Promise<QuotaCheckResult>

  /**
   * Get current quota status without incrementing
   */
  getStatus(licenseInfo: LicenseInfo | null, customerId?: string): Promise<QuotaCheckResult>

  /**
   * Build quota metadata for response _meta field
   */
  buildMetadata(result: QuotaCheckResult): QuotaMetadata

  /**
   * Build error response for quota exceeded
   */
  buildExceededResponse(result: QuotaCheckResult): MCPErrorResponse
}

// ============================================================================
// In-Memory Storage (Default)
// ============================================================================

/**
 * Simple in-memory storage for quota tracking
 * Note: This resets on server restart. Use a database-backed storage
 * in production via the storage option.
 */
class InMemoryQuotaStorage implements QuotaStorage {
  private usage: Map<
    string,
    {
      used: number
      periodStart: Date
      periodEnd: Date
    }
  > = new Map()

  async getUsage(
    customerId: string
  ): Promise<{ used: number; periodStart: Date; periodEnd: Date }> {
    const now = new Date()
    const existing = this.usage.get(customerId)

    // If we have existing data and it's still in the current period, return it
    if (existing && existing.periodEnd > now) {
      return existing
    }

    // Otherwise, create a new period
    const periodStart = this.getMonthStart(now)
    const periodEnd = this.getMonthEnd(now)
    const newUsage = { used: 0, periodStart, periodEnd }
    this.usage.set(customerId, newUsage)
    return newUsage
  }

  async incrementUsage(customerId: string, cost: number): Promise<void> {
    const usage = await this.getUsage(customerId)
    usage.used += cost
  }

  async initializePeriod(customerId: string, _limit: number): Promise<void> {
    const now = new Date()
    this.usage.set(customerId, {
      used: 0,
      periodStart: this.getMonthStart(now),
      periodEnd: this.getMonthEnd(now),
    })
  }

  private getMonthStart(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1)
  }

  private getMonthEnd(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth() + 1, 1)
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the warning level based on percentage used
 */
function getWarningLevel(percentUsed: number): WarningLevel {
  if (percentUsed >= 100) return 100
  if (percentUsed >= 90) return 90
  if (percentUsed >= 80) return 80
  return 0
}

/**
 * Get warning message based on level and current usage
 */
function getWarningMessage(
  warningLevel: WarningLevel,
  used: number,
  limit: number,
  _tier: LicenseTier
): string | undefined {
  if (warningLevel === 0) return undefined

  const remaining = Math.max(0, limit - used)

  switch (warningLevel) {
    case 100:
      return `API quota exceeded (${used.toLocaleString()}/${limit.toLocaleString()} calls). Upgrade to continue.`
    case 90:
      return `Warning: 90% of API quota used (${remaining.toLocaleString()} calls remaining). Consider upgrading.`
    case 80:
      return `Notice: 80% of API quota used (${remaining.toLocaleString()} calls remaining).`
    default:
      return undefined
  }
}

/**
 * Generate a customer ID from license info
 * Falls back to 'anonymous' for community users without an organization ID
 */
function getCustomerId(licenseInfo: LicenseInfo | null, providedId?: string): string {
  if (providedId) return providedId
  if (licenseInfo?.organizationId) return licenseInfo.organizationId
  return 'anonymous'
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
      allowed: usage.used < limit,
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
