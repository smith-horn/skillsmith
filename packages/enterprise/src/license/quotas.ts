// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * SMI-XXXX: Quota Constants and Configuration
 *
 * Defines API call quotas for each license tier and warning thresholds.
 */

import type { LicenseTier } from './FeatureFlags.js'

// ============================================================================
// Quota Configuration
// ============================================================================

/**
 * Quota configuration for a license tier
 */
export interface TierQuotaConfig {
  /** API calls allowed per month (-1 for unlimited) */
  apiCallsPerMonth: number
  /** Price in USD per month */
  price: number
  /** Whether pricing is per-user (for team/enterprise) */
  perUser?: boolean
  /** Description of the tier */
  description: string
}

/**
 * Quota limits for each license tier.
 *
 * These values are enforced by the QuotaEnforcementService and
 * displayed in CLI/MCP responses.
 */
export const TIER_QUOTAS: Readonly<Record<LicenseTier, TierQuotaConfig>> = {
  community: {
    apiCallsPerMonth: 1_000,
    price: 0,
    description: 'Free tier for evaluation',
  },
  individual: {
    apiCallsPerMonth: 10_000,
    price: 9.99,
    description: 'For solo developers',
  },
  team: {
    apiCallsPerMonth: 100_000,
    price: 25,
    perUser: true,
    description: 'For development teams',
  },
  enterprise: {
    apiCallsPerMonth: -1, // Unlimited
    price: 55,
    perUser: true,
    description: 'Full enterprise features with unlimited usage',
  },
} as const

// ============================================================================
// Warning Thresholds
// ============================================================================

/**
 * Warning threshold percentages for quota usage.
 * Users are notified when usage reaches these levels.
 */
export const WARNING_THRESHOLDS = [80, 90, 100] as const

/**
 * Warning threshold type
 */
export type WarningThreshold = (typeof WARNING_THRESHOLDS)[number]

/**
 * Warning configuration for each threshold
 */
export interface WarningConfig {
  /** Percentage of quota used */
  threshold: WarningThreshold
  /** Severity level */
  severity: 'info' | 'warning' | 'error'
  /** Display message template */
  message: string
  /** Whether to send email notification */
  sendEmail: boolean
}

/**
 * Warning configuration for each threshold level
 */
export const WARNING_CONFIG: readonly WarningConfig[] = [
  {
    threshold: 80,
    severity: 'info',
    message: 'Approaching quota limit',
    sendEmail: false,
  },
  {
    threshold: 90,
    severity: 'warning',
    message: 'Quota nearly exhausted',
    sendEmail: true,
  },
  {
    threshold: 100,
    severity: 'error',
    message: 'Quota exceeded',
    sendEmail: true,
  },
] as const

// ============================================================================
// Dormant Account Policy
// ============================================================================

/**
 * Number of days of inactivity before a free tier account is considered dormant
 */
export const DORMANT_ACCOUNT_DAYS = 90

/**
 * Billing period length in days
 */
export const BILLING_PERIOD_DAYS = 30

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the quota limit for a tier
 *
 * @param tier - License tier
 * @returns API calls per month (-1 for unlimited)
 */
export function getQuotaLimit(tier: LicenseTier): number {
  return TIER_QUOTAS[tier].apiCallsPerMonth
}

/**
 * Check if a tier has unlimited quota
 *
 * @param tier - License tier
 * @returns true if unlimited
 */
export function isUnlimited(tier: LicenseTier): boolean {
  return TIER_QUOTAS[tier].apiCallsPerMonth === -1
}

/**
 * Get the warning level for a given usage percentage
 *
 * @param percentUsed - Percentage of quota used (0-100+)
 * @returns Warning threshold level or 0 if below all thresholds
 */
export function getWarningLevel(percentUsed: number): 0 | WarningThreshold {
  if (percentUsed >= 100) return 100
  if (percentUsed >= 90) return 90
  if (percentUsed >= 80) return 80
  return 0
}

/**
 * Get the warning configuration for a given usage percentage
 *
 * @param percentUsed - Percentage of quota used
 * @returns Warning configuration or undefined if below all thresholds
 */
export function getWarningConfig(percentUsed: number): WarningConfig | undefined {
  const level = getWarningLevel(percentUsed)
  if (level === 0) return undefined
  return WARNING_CONFIG.find((config) => config.threshold === level)
}

/**
 * Get the tier price display string
 *
 * @param tier - License tier
 * @returns Formatted price string (e.g., "$9.99/mo" or "$25/user/mo")
 */
export function getTierPriceDisplay(tier: LicenseTier): string {
  const config = TIER_QUOTAS[tier]
  if (config.price === 0) return 'Free'
  const suffix = config.perUser ? '/user/mo' : '/mo'
  return `$${config.price}${suffix}`
}

/**
 * Get the quota display string
 *
 * @param tier - License tier
 * @returns Formatted quota string (e.g., "10,000 calls/mo" or "Unlimited")
 */
export function getQuotaDisplay(tier: LicenseTier): string {
  const limit = TIER_QUOTAS[tier].apiCallsPerMonth
  if (limit === -1) return 'Unlimited'
  return `${limit.toLocaleString()} calls/mo`
}

/**
 * Get upgrade recommendation for a tier
 *
 * @param currentTier - Current license tier
 * @returns Recommended tier to upgrade to, or null if already at highest
 */
export function getUpgradeRecommendation(currentTier: LicenseTier): LicenseTier | null {
  switch (currentTier) {
    case 'community':
      return 'individual'
    case 'individual':
      return 'team'
    case 'team':
      return 'enterprise'
    case 'enterprise':
      return null
  }
}

/**
 * Build upgrade URL with tracking parameters
 *
 * @param currentTier - Current tier
 * @param reason - Reason for upgrade prompt
 * @returns Full upgrade URL with UTM parameters
 */
export function buildUpgradeUrl(
  currentTier: LicenseTier,
  reason: 'quota_exceeded' | 'quota_warning' | 'feature_required'
): string {
  const recommendedTier = getUpgradeRecommendation(currentTier)
  const baseUrl = 'https://skillsmith.app/upgrade'
  const params = new URLSearchParams({
    from: currentTier,
    to: recommendedTier || 'enterprise',
    reason,
    utm_source: 'cli',
    utm_medium: 'quota_warning',
    utm_campaign: 'upgrade_prompt',
  })
  return `${baseUrl}?${params.toString()}`
}
