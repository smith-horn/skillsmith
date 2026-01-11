/**
 * Tier-to-feature mapping for enterprise licensing
 *
 * Maps license tiers to their available features based on the
 * go-to-market analysis document.
 */

import type { FeatureFlag, LicenseTier } from './FeatureFlags.js'
import {
  INDIVIDUAL_FEATURES,
  TEAM_FEATURES as TEAM_FEATURE_FLAGS,
  ENTERPRISE_ONLY_FEATURES,
} from './FeatureFlags.js'

/**
 * Features available in the Individual tier
 */
const INDIVIDUAL_TIER_FEATURES: readonly FeatureFlag[] = [...INDIVIDUAL_FEATURES] as const

/**
 * Features available in the Team tier (includes Individual features)
 */
const TEAM_FEATURES: readonly FeatureFlag[] = [
  ...INDIVIDUAL_FEATURES,
  ...TEAM_FEATURE_FLAGS,
] as const

/**
 * All Enterprise features (Individual + Team + Enterprise-only features)
 */
const ENTERPRISE_FEATURES: readonly FeatureFlag[] = [
  ...INDIVIDUAL_FEATURES,
  ...TEAM_FEATURE_FLAGS,
  ...ENTERPRISE_ONLY_FEATURES,
] as const

/**
 * Mapping of each feature to the tiers that include it.
 * Used for permission checking and feature gating.
 */
export const FEATURE_TIERS: Readonly<Record<FeatureFlag, readonly LicenseTier[]>> = {
  // Individual tier features (available in individual, team, and enterprise)
  basic_analytics: ['individual', 'team', 'enterprise'],
  email_support: ['individual', 'team', 'enterprise'],

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
  individual: INDIVIDUAL_TIER_FEATURES,
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
 * getRequiredTier('basic_analytics'); // 'individual'
 * getRequiredTier('team_workspaces'); // 'team'
 * getRequiredTier('sso_saml'); // 'enterprise'
 * ```
 */
export function getRequiredTier(feature: FeatureFlag): LicenseTier {
  const allowedTiers = FEATURE_TIERS[feature]

  // Return the first (lowest) tier that has this feature
  if (allowedTiers.includes('individual')) {
    return 'individual'
  }

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
 * getFeaturesForTier('individual'); // ['basic_analytics', 'email_support']
 * getFeaturesForTier('team'); // ['basic_analytics', 'email_support', 'team_workspaces', ...]
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
 * tierIncludes('individual', 'basic_analytics'); // true
 * tierIncludes('team', 'team_workspaces'); // true
 * tierIncludes('team', 'sso_saml'); // false
 * tierIncludes('enterprise', 'sso_saml'); // true
 * tierIncludes('community', 'basic_analytics'); // false
 * ```
 */
export function tierIncludes(tier: LicenseTier, feature: FeatureFlag): boolean {
  return FEATURE_TIERS[feature].includes(tier)
}
