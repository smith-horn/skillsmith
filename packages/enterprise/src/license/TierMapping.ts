/**
 * Tier-to-feature mapping for enterprise licensing
 *
 * Maps license tiers to their available features based on the
 * go-to-market analysis document.
 */

import type { FeatureFlag, LicenseTier } from './FeatureFlags.js'

/**
 * Features available in the Team tier
 */
const TEAM_FEATURES: readonly FeatureFlag[] = [
  'team_workspaces',
  'private_skills',
  'usage_analytics',
  'priority_support',
] as const

/**
 * Additional features available only in the Enterprise tier
 */
const ENTERPRISE_ONLY_FEATURES: readonly FeatureFlag[] = [
  'sso_saml',
  'rbac',
  'audit_logging',
  'siem_export',
  'compliance_reports',
  'private_registry',
  'custom_integrations',
  'advanced_analytics',
] as const

/**
 * All Enterprise features (Team features + Enterprise-only features)
 */
const ENTERPRISE_FEATURES: readonly FeatureFlag[] = [
  ...TEAM_FEATURES,
  ...ENTERPRISE_ONLY_FEATURES,
] as const

/**
 * Mapping of each feature to the tiers that include it.
 * Used for permission checking and feature gating.
 */
export const FEATURE_TIERS: Readonly<Record<FeatureFlag, readonly LicenseTier[]>> = {
  // Team tier features (available in team and enterprise)
  team_workspaces: ['team', 'enterprise'],
  private_skills: ['team', 'enterprise'],
  usage_analytics: ['team', 'enterprise'],
  priority_support: ['team', 'enterprise'],

  // Enterprise-only features
  sso_saml: ['enterprise'],
  rbac: ['enterprise'],
  audit_logging: ['enterprise'],
  siem_export: ['enterprise'],
  compliance_reports: ['enterprise'],
  private_registry: ['enterprise'],
  custom_integrations: ['enterprise'],
  advanced_analytics: ['enterprise'],
} as const

/**
 * Mapping of tiers to their available features.
 * Used for listing features available to a tier.
 */
const TIER_FEATURES: Readonly<Record<LicenseTier, readonly FeatureFlag[]>> = {
  community: [],
  team: TEAM_FEATURES,
  enterprise: ENTERPRISE_FEATURES,
} as const

/**
 * Get the minimum required tier for a feature.
 *
 * @param feature - The feature flag to check
 * @returns The minimum tier required to access the feature
 *
 * @example
 * ```typescript
 * getRequiredTier('team_workspaces'); // 'team'
 * getRequiredTier('sso_saml'); // 'enterprise'
 * ```
 */
export function getRequiredTier(feature: FeatureFlag): LicenseTier {
  const allowedTiers = FEATURE_TIERS[feature]

  // Return the first (lowest) tier that has this feature
  if (allowedTiers.includes('team')) {
    return 'team'
  }

  return 'enterprise'
}

/**
 * Get all features available for a given tier.
 *
 * @param tier - The license tier
 * @returns Array of feature flags available for the tier
 *
 * @example
 * ```typescript
 * getFeaturesForTier('community'); // []
 * getFeaturesForTier('team'); // ['team_workspaces', 'private_skills', ...]
 * getFeaturesForTier('enterprise'); // All features
 * ```
 */
export function getFeaturesForTier(tier: LicenseTier): FeatureFlag[] {
  return [...TIER_FEATURES[tier]]
}

/**
 * Check if a tier includes access to a specific feature.
 *
 * @param tier - The license tier to check
 * @param feature - The feature flag to check access for
 * @returns true if the tier includes the feature, false otherwise
 *
 * @example
 * ```typescript
 * tierIncludes('team', 'team_workspaces'); // true
 * tierIncludes('team', 'sso_saml'); // false
 * tierIncludes('enterprise', 'sso_saml'); // true
 * tierIncludes('community', 'team_workspaces'); // false
 * ```
 */
export function tierIncludes(tier: LicenseTier, feature: FeatureFlag): boolean {
  return FEATURE_TIERS[feature].includes(tier)
}
