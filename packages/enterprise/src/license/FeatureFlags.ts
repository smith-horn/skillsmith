/**
 * Feature flags for enterprise licensing
 *
 * These flags control access to paid features based on license tier.
 */

/**
 * Individual tier feature flags
 */
export type IndividualFeatureFlag = 'basic_analytics' | 'email_support'

/**
 * Team tier feature flags
 */
export type TeamFeatureFlag =
  | 'team_workspaces'
  | 'private_skills'
  | 'usage_analytics'
  | 'priority_support'

/**
 * Enterprise tier feature flags
 */
export type EnterpriseFeatureFlag =
  | 'sso_saml'
  | 'rbac'
  | 'audit_logging'
  | 'siem_export'
  | 'compliance_reports'
  | 'private_registry'
  | 'custom_integrations'
  | 'advanced_analytics'

/**
 * Available feature flags for the licensing system.
 * Each feature is gated by license tier.
 */
export type FeatureFlag = IndividualFeatureFlag | TeamFeatureFlag | EnterpriseFeatureFlag

/**
 * License tiers available in the system.
 * - community: Free tier with no paid features (1,000 API calls/month)
 * - individual: Individual tier for solo developers ($9.99/mo, 10,000 API calls/month)
 * - team: Team tier with collaboration features ($25/user/mo, 100,000 API calls/month)
 * - enterprise: Full enterprise tier with all features ($55/user/mo, unlimited)
 */
export type LicenseTier = 'community' | 'individual' | 'team' | 'enterprise'

/**
 * Individual tier features
 */
export const INDIVIDUAL_FEATURES: readonly IndividualFeatureFlag[] = [
  'basic_analytics',
  'email_support',
] as const

/**
 * Team tier features
 */
export const TEAM_FEATURES: readonly TeamFeatureFlag[] = [
  'team_workspaces',
  'private_skills',
  'usage_analytics',
  'priority_support',
] as const

/**
 * Enterprise-only features
 */
export const ENTERPRISE_ONLY_FEATURES: readonly EnterpriseFeatureFlag[] = [
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
 * All available feature flags as a readonly array.
 * Useful for iteration and validation.
 */
export const ALL_FEATURE_FLAGS: readonly FeatureFlag[] = [
  ...INDIVIDUAL_FEATURES,
  ...TEAM_FEATURES,
  ...ENTERPRISE_ONLY_FEATURES,
] as const

/**
 * All available license tiers as a readonly array.
 * Useful for iteration and validation.
 */
export const ALL_LICENSE_TIERS: readonly LicenseTier[] = [
  'community',
  'individual',
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
