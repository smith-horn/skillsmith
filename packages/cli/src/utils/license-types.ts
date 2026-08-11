/**
 * License Types for Skillsmith CLI
 *
 * Type definitions for license validation and display.
 *
 * @module @skillsmith/cli/utils/license-types
 */

/**
 * Available license tiers (SMI-5558)
 * - community: Free tier (100 API calls/month)
 * - individual: Solo developers ($9.99/mo, 1,000 API calls/month)
 * - team: Teams ($25/user/mo, 10,000 API calls/month)
 * - enterprise: Full enterprise ($55/user/mo, unlimited)
 */
export type LicenseTier = 'community' | 'individual' | 'team' | 'enterprise'

/**
 * Quota information for display
 */
export interface QuotaInfo {
  /** API calls used this period */
  used: number
  /** API call limit (-1 for unlimited) */
  limit: number
  /** Percentage used */
  percentUsed: number
  /** When the quota resets */
  resetAt: Date
}

/**
 * License status information returned by license check
 */
export interface LicenseStatus {
  /** Whether the license is valid */
  valid: boolean
  /** License tier level */
  tier: LicenseTier
  /** Expiration date for paid tiers */
  expiresAt?: Date
  /** List of enabled features for this tier */
  features: string[]
  /** Error message if license validation failed */
  error?: string
  /** Optional quota information */
  quota?: QuotaInfo
}

/**
 * License key payload structure (decoded from license key)
 * @deprecated Used only for fallback when enterprise package unavailable
 */
export interface LicensePayload {
  tier: LicenseTier
  expiresAt: string
  features: string[]
}

/**
 * Interface for enterprise LicenseValidator
 * @see packages/enterprise/src/license/LicenseValidator.ts
 */
export interface EnterpriseLicenseValidator {
  validate(key: string): Promise<{
    valid: boolean
    license?: {
      tier: LicenseTier
      features: string[]
      expiresAt: Date
    }
    error?: {
      code: string
      message: string
    }
  }>
}

/**
 * Default features by tier
 *
 * Note: Community tier uses CLI-specific display names for UI purposes.
 * Individual, Team and Enterprise tiers use canonical feature names from @smith-horn/enterprise.
 *
 * @see packages/enterprise/src/license/types.ts for canonical feature definitions
 */
export const TIER_FEATURES: Record<LicenseTier, string[]> = {
  community: ['basic_search', 'skill_install', 'local_validation'],
  individual: [
    'basic_analytics',
    'email_support',
    // SMI-5949: pre-existing drift fix — version_tracking is part of
    // INDIVIDUAL_FEATURES in the canonical @smith-horn/enterprise package
    // (packages/enterprise/src/license/FeatureFlags.ts) and was silently
    // missing here (this file has no compiler backstop, unlike the
    // Record<FeatureFlag, ...> mirrors in toolFeatureMapping.ts). Caught by
    // the new TIER_FEATURES.enterprise parity regression test.
    'version_tracking',
  ],
  team: [
    // Individual features (inherited)
    'basic_analytics',
    'email_support',
    'version_tracking',
    // Team features
    'team_workspaces',
    'private_skills',
    'usage_analytics',
    'priority_support',
    // SMI-5949: pre-existing drift fix — skill_security_audit is part of
    // TEAM_FEATURES in the canonical package and was silently missing here.
    'skill_security_audit',
    // SMI-3140: expanded to Team + Enterprise (2026-07-14)
    'compliance_reports',
  ],
  enterprise: [
    // Individual features (inherited)
    'basic_analytics',
    'email_support',
    'version_tracking',
    // Team features (inherited)
    'team_workspaces',
    'private_skills',
    'usage_analytics',
    'priority_support',
    'skill_security_audit',
    'compliance_reports',
    // Enterprise-only features (canonical names from enterprise package)
    'sso_saml',
    'rbac',
    'audit_logging',
    'siem_export',
    'private_registry',
    'custom_integrations',
    'advanced_analytics',
    // SMI-5949: separately-flagged approval gate for private_registry_publish (D-11)
    'registry_approval',
  ],
}

/**
 * API call limits per tier (per month)
 * Note: These are reference values matching the enterprise package quotas.
 * Actual quota enforcement happens in the MCP server via QuotaEnforcementService.
 */
export const TIER_QUOTAS: Record<LicenseTier, number> = {
  community: 100,
  individual: 1_000,
  team: 10_000,
  enterprise: -1, // Unlimited
}
