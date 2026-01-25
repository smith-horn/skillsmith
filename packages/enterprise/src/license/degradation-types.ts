/**
 * SMI-1060: Graceful Degradation Types
 *
 * Type definitions and constants for graceful degradation
 * when features are unavailable due to license restrictions.
 */

import type { FeatureFlag, LicenseTier } from './types.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Base URL for upgrade pages
 */
export const BASE_URL = 'https://skillsmith.app'

/**
 * Pricing information for each tier
 */
export const TIER_PRICING: Readonly<Record<LicenseTier, string>> = {
  individual: '$9.99/month',
  community: '$0/month',
  team: '$25/user/month',
  enterprise: '$55/user/month',
}

/**
 * Human-readable display names for features
 */
export const FEATURE_DISPLAY_NAMES: Readonly<Record<FeatureFlag, string>> = {
  // Individual tier features
  basic_analytics: 'Basic Analytics',
  email_support: 'Email Support',
  // Team tier features
  team_workspaces: 'Team Workspaces',
  private_skills: 'Private Skills',
  usage_analytics: 'Usage Analytics',
  priority_support: 'Priority Support',
  // Enterprise tier features
  sso_saml: 'SSO/SAML Integration',
  rbac: 'Role-Based Access Control',
  audit_logging: 'Audit Logging',
  siem_export: 'SIEM Export',
  compliance_reports: 'Compliance Reports',
  private_registry: 'Private Registry',
  custom_integrations: 'Custom Integrations',
  advanced_analytics: 'Advanced Analytics',
}

/**
 * Brief descriptions of each feature for upgrade prompts
 */
export const FEATURE_DESCRIPTIONS: Readonly<Record<FeatureFlag, string>> = {
  // Individual tier features
  basic_analytics: 'Access to basic usage analytics and reporting dashboard',
  email_support: 'Email-based technical support with 48-hour response time',
  // Team tier features
  team_workspaces: 'Collaborate with your team on shared skill collections',
  private_skills: 'Create and manage private skills for your organization',
  usage_analytics: 'Track skill usage and team productivity metrics',
  priority_support: 'Get faster response times from our support team',
  // Enterprise tier features
  sso_saml: 'Integrate with your identity provider for secure single sign-on',
  rbac: 'Fine-grained access control with custom roles and permissions',
  audit_logging: 'Comprehensive audit trail for compliance and security',
  siem_export: 'Export security events to your SIEM platform',
  compliance_reports: 'Generate reports for SOC2, HIPAA, and other standards',
  private_registry: 'Host your own private skill registry',
  custom_integrations: 'Build custom webhook and API integrations',
  advanced_analytics: 'Deep insights with advanced analytics dashboards',
}

/**
 * Tier display names
 */
export const TIER_DISPLAY_NAMES: Readonly<Record<LicenseTier, string>> = {
  individual: 'Individual',
  community: 'Community',
  team: 'Team',
  enterprise: 'Enterprise',
}

// ============================================================================
// Types
// ============================================================================

/**
 * Result of graceful degradation handling
 */
export interface GracefulDegradationResult {
  /** Whether the feature was allowed */
  allowed: false
  /** The feature that was denied */
  feature: FeatureFlag
  /** The tier required to access the feature */
  requiredTier: LicenseTier
  /** The current user's tier */
  currentTier: LicenseTier
  /** User-friendly upgrade message */
  message: string
  /** Detailed message with feature description */
  detailedMessage: string
  /** URL to upgrade to the required tier */
  upgradeUrl: string
  /** URL to pricing page for comparison */
  pricingUrl: string
  /** Alternative features available at current tier */
  availableAlternatives: FeatureFlag[]
}

/**
 * Options for creating upgrade prompts
 */
export interface UpgradePromptOptions {
  /** Include feature description in message */
  includeDescription?: boolean
  /** Include pricing information */
  includePricing?: boolean
  /** Include available alternatives */
  includeAlternatives?: boolean
  /** Current tier (for alternatives) */
  currentTier?: LicenseTier
}

/**
 * Tier comparison entry
 */
export interface TierComparisonEntry {
  tier: LicenseTier
  displayName: string
  pricing: string
  features: FeatureFlag[]
  featureDescriptions: string[]
}

/**
 * Degradation event for analytics
 */
export interface DegradationEvent {
  timestamp: string
  feature: FeatureFlag
  requiredTier: LicenseTier
  currentTier: LicenseTier
  source: string
}
