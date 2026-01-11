// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * SMI-XXXX: Quota Enforcement Service
 *
 * Enforces API call quotas for each license tier with:
 * - Real-time usage tracking
 * - Warning thresholds at 80%, 90%, 100%
 * - Hard block at 100% usage
 * - Per-billing-period quota management
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import type { LicenseTier } from '../license/FeatureFlags.js'
import {
  TIER_QUOTAS,
  getWarningLevel,
  getWarningConfig,
  isUnlimited,
  buildUpgradeUrl,
  type WarningThreshold,
} from '../license/quotas.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a quota check
 */
export interface QuotaCheckResult {
  /** Whether the API call is allowed */
  allowed: boolean
  /** Remaining API calls in the billing period */
  remaining: number
  /** Total limit for the billing period (-1 for unlimited) */
  limit: number
  /** Percentage of quota used (0-100+) */
  percentUsed: number
  /** Warning level (0, 80, 90, or 100) */
  warningLevel: 0 | WarningThreshold
  /** When the quota resets */
  resetAt: Date
  /** Optional message for the user */
  message?: string
  /** Upgrade URL if quota is low or exceeded */
  upgradeUrl?: string
}

/**
 * Usage summary for a customer
 */
export interface UsageSummary {
  /** Customer ID */
  customerId: string
  /** License tier */
  tier: LicenseTier
  /** API calls used this period */
  used: number
  /** API call limit (-1 for unlimited) */
  limit: number
  /** Percentage used */
  percentUsed: number
  /** Billing period start */
  periodStart: Date
  /** Billing period end / reset date */
  periodEnd: Date
  /** Whether unlimited */
  isUnlimited: boolean
}

/**
 * Quota record from database
 */
interface QuotaRecord {
  id: string
  customer_id: string
  license_tier: string
  billing_period_start: string
  billing_period_end: string
  api_calls_limit: number
  api_calls_used: number
  last_warning_threshold: number
  last_warning_sent_at: string | null
  created_at: string
  updated_at: string
}

// ============================================================================
// Service
// ============================================================================

/**
 * QuotaEnforcementService manages API call quotas for each license tier.
 *
 * @example
 * ```typescript
 * const service = new QuotaEnforcementService(db)
 *
 * // Check if an API call is allowed
 * const result = await service.checkAndTrackUsage('customer-123', 'search', 'team')
 * if (!result.allowed) {
 *   throw new QuotaExceededError(result.message)
 * }
 *
 * // Display warning if approaching limit
 * if (result.warningLevel >= 80) {
 *   console.warn(result.message)
 * }
 * ```
 */
export class QuotaEnforcementService {
  private db: DatabaseType

  constructor(db: DatabaseType) {
    this.db = db
  }

  /**
   * Check if an API call is allowed and track usage.
   * This is the main entry point for quota enforcement.
   *
   * @param customerId - Customer identifier
   * @param toolName - Name of the MCP tool being called
   * @param tier - Customer's license tier
   * @param cost - Number of quota units to consume (default: 1)
   * @returns Quota check result with allow/deny decision
   */
  async checkAndTrackUsage(
    customerId: string,
    toolName: string,
    tier: LicenseTier,
    cost: number = 1
  ): Promise<QuotaCheckResult> {
    // Enterprise tier has unlimited quota
    if (isUnlimited(tier)) {
      await this.recordApiCall(customerId, toolName, cost, true)
      return {
        allowed: true,
        remaining: -1,
        limit: -1,
        percentUsed: 0,
        warningLevel: 0,
        resetAt: this.getNextBillingPeriodEnd(),
      }
    }

    // Get or create quota record for current billing period
    const quota = await this.getOrCreateQuota(customerId, tier)
    const limit = quota.api_calls_limit
    const used = quota.api_calls_used
    const percentUsed = (used / limit) * 100
    const _warningLevel = getWarningLevel(percentUsed) // Calculated but used after early return
    const resetAt = new Date(quota.billing_period_end)

    // Check if quota exceeded
    if (used >= limit) {
      return {
        allowed: false,
        remaining: 0,
        limit,
        percentUsed: 100,
        warningLevel: 100,
        resetAt,
        message: `Monthly API quota exceeded (${used.toLocaleString()}/${limit.toLocaleString()}). Upgrade to continue or wait until ${resetAt.toLocaleDateString()}.`,
        upgradeUrl: buildUpgradeUrl(tier, 'quota_exceeded'),
      }
    }

    // Record the API call
    await this.recordApiCall(customerId, toolName, cost, true)
    await this.incrementUsage(quota.id, cost)

    // Calculate new usage after this call
    const newUsed = used + cost
    const newPercentUsed = (newUsed / limit) * 100
    const newWarningLevel = getWarningLevel(newPercentUsed)

    // Build result
    const result: QuotaCheckResult = {
      allowed: true,
      remaining: limit - newUsed,
      limit,
      percentUsed: newPercentUsed,
      warningLevel: newWarningLevel,
      resetAt,
    }

    // Add warning message if approaching limit
    if (newWarningLevel >= 80) {
      const config = getWarningConfig(newPercentUsed)
      result.message = `${config?.message}. ${newPercentUsed.toFixed(0)}% used (${newUsed.toLocaleString()}/${limit.toLocaleString()}). ${result.remaining.toLocaleString()} calls remaining.`
      result.upgradeUrl = buildUpgradeUrl(tier, 'quota_warning')

      // Update warning threshold if crossed a new level
      if (newWarningLevel > quota.last_warning_threshold) {
        await this.updateWarningThreshold(quota.id, newWarningLevel)
      }
    }

    return result
  }

  /**
   * Get usage summary for a customer
   */
  async getUsageSummary(customerId: string, tier: LicenseTier): Promise<UsageSummary> {
    const quota = await this.getOrCreateQuota(customerId, tier)

    const limit = quota.api_calls_limit
    const used = quota.api_calls_used
    const unlimited = limit === -1

    return {
      customerId,
      tier: tier,
      used,
      limit,
      percentUsed: unlimited ? 0 : (used / limit) * 100,
      periodStart: new Date(quota.billing_period_start),
      periodEnd: new Date(quota.billing_period_end),
      isUnlimited: unlimited,
    }
  }

  /**
   * Get remaining API calls for a customer
   */
  async getRemainingCalls(customerId: string, tier: LicenseTier): Promise<number> {
    if (isUnlimited(tier)) {
      return -1
    }

    const quota = await this.getOrCreateQuota(customerId, tier)
    return Math.max(0, quota.api_calls_limit - quota.api_calls_used)
  }

  /**
   * Initialize quota for a new billing period
   */
  async initializeQuotaForPeriod(
    customerId: string,
    tier: LicenseTier,
    periodStart?: Date,
    periodEnd?: Date
  ): Promise<void> {
    const start = periodStart || this.getCurrentBillingPeriodStart()
    const end = periodEnd || this.getNextBillingPeriodEnd()
    const limit = TIER_QUOTAS[tier].apiCallsPerMonth

    const id = this.generateId()
    const stmt = this.db.prepare(`
      INSERT INTO usage_quotas (
        id, customer_id, license_tier, billing_period_start, billing_period_end,
        api_calls_limit, api_calls_used, last_warning_threshold
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0)
    `)

    stmt.run(id, customerId, tier, start.toISOString(), end.toISOString(), limit)
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async getOrCreateQuota(customerId: string, tier: LicenseTier): Promise<QuotaRecord> {
    const periodStart = this.getCurrentBillingPeriodStart()
    const periodEnd = this.getNextBillingPeriodEnd()

    // Try to get existing quota
    const stmt = this.db.prepare(`
      SELECT * FROM usage_quotas
      WHERE customer_id = ?
        AND billing_period_start <= ?
        AND billing_period_end >= ?
      ORDER BY billing_period_start DESC
      LIMIT 1
    `)

    const now = new Date().toISOString()
    const existing = stmt.get(customerId, now, now) as QuotaRecord | undefined

    if (existing) {
      // Check if tier changed - if so, update the limit
      if (existing.license_tier !== tier) {
        const newLimit = TIER_QUOTAS[tier].apiCallsPerMonth
        const updateStmt = this.db.prepare(`
          UPDATE usage_quotas
          SET license_tier = ?, api_calls_limit = ?, updated_at = datetime('now')
          WHERE id = ?
        `)
        updateStmt.run(tier, newLimit, existing.id)
        existing.license_tier = tier
        existing.api_calls_limit = newLimit
      }
      return existing
    }

    // Create new quota for this period
    await this.initializeQuotaForPeriod(customerId, tier, periodStart, periodEnd)

    // Fetch the newly created record
    const newQuota = stmt.get(customerId, now, now) as QuotaRecord
    return newQuota
  }

  private async recordApiCall(
    customerId: string,
    toolName: string,
    cost: number,
    success: boolean
  ): Promise<void> {
    const id = this.generateId()
    const stmt = this.db.prepare(`
      INSERT INTO api_call_events (
        id, customer_id, tool_name, cost, success, timestamp
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    `)

    stmt.run(id, customerId, toolName, cost, success ? 1 : 0)
  }

  private async incrementUsage(quotaId: string, amount: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE usage_quotas
      SET api_calls_used = api_calls_used + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `)

    stmt.run(amount, quotaId)
  }

  private async updateWarningThreshold(quotaId: string, threshold: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE usage_quotas
      SET last_warning_threshold = ?,
          last_warning_sent_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `)

    stmt.run(threshold, quotaId)
  }

  private getCurrentBillingPeriodStart(): Date {
    const now = new Date()
    // Start of current month
    return new Date(now.getFullYear(), now.getMonth(), 1)
  }

  private getNextBillingPeriodEnd(): Date {
    const now = new Date()
    // End of current month (start of next month)
    return new Date(now.getFullYear(), now.getMonth() + 1, 1)
  }

  private generateId(): string {
    return `quota_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a QuotaEnforcementService instance
 */
export function createQuotaEnforcementService(db: DatabaseType): QuotaEnforcementService {
  return new QuotaEnforcementService(db)
}
