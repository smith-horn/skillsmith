// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * SMI-1091: Quota Helpers - Storage and utility functions for quota enforcement
 *
 * Extracted from quota.ts to reduce file size.
 *
 * @see quota.ts for main middleware implementation
 */

import type { LicenseInfo, LicenseTier } from './license.js'
import type { QuotaStorage, WarningLevel } from './quota-types.js'

// ============================================================================
// In-Memory Storage (Default)
// ============================================================================

/**
 * Simple in-memory storage for quota tracking
 * Note: This resets on server restart. Use a database-backed storage
 * in production via the storage option.
 */
export class InMemoryQuotaStorage implements QuotaStorage {
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
export function getWarningLevel(percentUsed: number): WarningLevel {
  if (percentUsed >= 100) return 100
  if (percentUsed >= 90) return 90
  if (percentUsed >= 80) return 80
  return 0
}

/**
 * Get warning message based on level and current usage
 */
export function getWarningMessage(
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
export function getCustomerId(licenseInfo: LicenseInfo | null, providedId?: string): string {
  if (providedId) return providedId
  if (licenseInfo?.organizationId) return licenseInfo.organizationId
  return 'anonymous'
}
