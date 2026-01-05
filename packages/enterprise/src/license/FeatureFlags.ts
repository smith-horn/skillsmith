/**
 * Feature flags for enterprise licensing
 *
 * These flags control access to paid features based on license tier.
 */

/**
 * Available feature flags for the licensing system.
 * Each feature is gated by license tier.
 */
export type FeatureFlag =
  | 'team_workspaces'
  | 'private_skills'
  | 'usage_analytics'
  | 'priority_support'
  | 'sso_saml'
  | 'rbac'
  | 'audit_logging'
  | 'siem_export'
  | 'compliance_reports'
  | 'private_registry'
  | 'custom_integrations'
  | 'advanced_analytics'

/**
 * License tiers available in the system.
 * - community: Free tier with no paid features
 * - team: Team tier with collaboration features
 * - enterprise: Full enterprise tier with all features
 */
export type LicenseTier = 'community' | 'team' | 'enterprise'

/**
 * All available feature flags as a readonly array.
 * Useful for iteration and validation.
 */
export const ALL_FEATURE_FLAGS: readonly FeatureFlag[] = [
  'team_workspaces',
  'private_skills',
  'usage_analytics',
  'priority_support',
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
 * All available license tiers as a readonly array.
 * Useful for iteration and validation.
 */
export const ALL_LICENSE_TIERS: readonly LicenseTier[] = [
  'community',
  'team',
  'enterprise',
] as const

/**
 * Type guard to check if a string is a valid FeatureFlag
 */
export function isFeatureFlag(value: string): value is FeatureFlag {
  return ALL_FEATURE_FLAGS.includes(value as FeatureFlag)
}

/**
 * Type guard to check if a string is a valid LicenseTier
 */
export function isLicenseTier(value: string): value is LicenseTier {
  return ALL_LICENSE_TIERS.includes(value as LicenseTier)
}
