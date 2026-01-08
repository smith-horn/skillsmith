/**
 * SMI-1060: Graceful Degradation for License Validation
 *
 * Provides user-friendly upgrade prompts and graceful degradation
 * when features are unavailable due to license restrictions.
 */

import type { FeatureFlag, LicenseTier } from './types.js'
import { getRequiredTier, getFeaturesForTier } from './TierMapping.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Base URL for upgrade pages
 */
const BASE_URL = 'https://skillsmith.app'

/**
 * Pricing information for each tier
 */
export const TIER_PRICING: Readonly<Record<LicenseTier, string>> = {
  community: '$0/month',
  team: '$25/user/month',
  enterprise: '$55/user/month',
}

/**
 * Human-readable display names for features
 */
export const FEATURE_DISPLAY_NAMES: Readonly<Record<FeatureFlag, string>> = {
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

// ============================================================================
// URL Generation
// ============================================================================

/**
 * Get the URL to upgrade to a specific tier
 *
 * @param tier - The target tier
 * @param options - Optional query parameters
 * @returns The upgrade URL
 */
export function getUpgradeUrl(
  tier: LicenseTier,
  options?: { feature?: FeatureFlag; source?: string }
): string {
  const params = new URLSearchParams()

  if (tier !== 'community') {
    params.set('tier', tier)
  }

  if (options?.feature) {
    params.set('feature', options.feature)
  }

  if (options?.source) {
    params.set('source', options.source)
  }

  const queryString = params.toString()
  return `${BASE_URL}/upgrade${queryString ? `?${queryString}` : ''}`
}

/**
 * Get the URL to the pricing page
 *
 * @param options - Optional query parameters
 * @returns The pricing URL
 */
export function getPricingUrl(options?: {
  feature?: FeatureFlag
  currentTier?: LicenseTier
}): string {
  const params = new URLSearchParams()

  if (options?.feature) {
    params.set('highlight', options.feature)
  }

  if (options?.currentTier) {
    params.set('current', options.currentTier)
  }

  const queryString = params.toString()
  return `${BASE_URL}/pricing${queryString ? `?${queryString}` : ''}`
}

// ============================================================================
// Upgrade Prompt Generation
// ============================================================================

/**
 * Create an upgrade prompt message for a specific feature
 *
 * @param feature - The feature that requires upgrade
 * @param options - Options for customizing the message
 * @returns The upgrade prompt message
 *
 * @example
 * ```typescript
 * createUpgradePrompt('sso_saml');
 * // "SSO/SAML Integration requires Enterprise tier ($55/user/month). Upgrade at https://skillsmith.app/upgrade?tier=enterprise&feature=sso_saml"
 * ```
 */
export function createUpgradePrompt(feature: FeatureFlag, options?: UpgradePromptOptions): string {
  const requiredTier = getRequiredTier(feature)
  const displayName = FEATURE_DISPLAY_NAMES[feature]
  const tierDisplayName = TIER_DISPLAY_NAMES[requiredTier]

  let message = `${displayName} requires ${tierDisplayName} tier`

  if (options?.includePricing !== false) {
    message += ` (${TIER_PRICING[requiredTier]})`
  }

  message += `. Upgrade at ${getUpgradeUrl(requiredTier, { feature })}`

  if (options?.includeDescription) {
    message += `\n\n${FEATURE_DESCRIPTIONS[feature]}`
  }

  if (options?.includeAlternatives && options?.currentTier) {
    const alternatives = getFeaturesForTier(options.currentTier)
    if (alternatives.length > 0) {
      const alternativeNames = alternatives.slice(0, 3).map((f) => FEATURE_DISPLAY_NAMES[f])
      message += `\n\nFeatures available in your current tier: ${alternativeNames.join(', ')}`
    }
  }

  return message
}

/**
 * Create a detailed upgrade prompt with full context
 *
 * @param feature - The feature that requires upgrade
 * @param currentTier - The user's current tier
 * @returns Detailed upgrade message
 */
export function createDetailedUpgradePrompt(
  feature: FeatureFlag,
  currentTier: LicenseTier
): string {
  const requiredTier = getRequiredTier(feature)
  const displayName = FEATURE_DISPLAY_NAMES[feature]
  const description = FEATURE_DESCRIPTIONS[feature]
  const tierDisplayName = TIER_DISPLAY_NAMES[requiredTier]
  const currentTierDisplayName = TIER_DISPLAY_NAMES[currentTier]

  const lines = [
    `Feature Unavailable: ${displayName}`,
    '',
    description,
    '',
    `Current tier: ${currentTierDisplayName} (${TIER_PRICING[currentTier]})`,
    `Required tier: ${tierDisplayName} (${TIER_PRICING[requiredTier]})`,
    '',
    `Upgrade to unlock: ${getUpgradeUrl(requiredTier, { feature, source: 'graceful-degradation' })}`,
    `Compare plans: ${getPricingUrl({ feature, currentTier })}`,
  ]

  return lines.join('\n')
}

// ============================================================================
// Tier Comparison
// ============================================================================

/**
 * Create a tier comparison message showing what each tier offers
 *
 * @returns Formatted tier comparison message
 *
 * @example
 * ```typescript
 * const comparison = createTierComparisonMessage();
 * // Returns multi-line string with tier features
 * ```
 */
export function createTierComparisonMessage(): string {
  const comparison = getTierComparison()

  const lines = ['Skillsmith Pricing Tiers', '========================', '']

  for (const entry of comparison) {
    lines.push(`${entry.displayName} (${entry.pricing})`)
    lines.push('-'.repeat(40))

    if (entry.features.length === 0) {
      lines.push('  - Core features: search, install, recommend, validate, compare')
    } else {
      for (const feature of entry.features) {
        lines.push(`  - ${FEATURE_DISPLAY_NAMES[feature]}`)
      }
    }
    lines.push('')
  }

  lines.push(`Learn more: ${BASE_URL}/pricing`)

  return lines.join('\n')
}

/**
 * Get tier comparison data as structured entries
 *
 * @returns Array of tier comparison entries
 */
export function getTierComparison(): TierComparisonEntry[] {
  const tiers: LicenseTier[] = ['community', 'team', 'enterprise']

  return tiers.map((tier) => {
    const features = getFeaturesForTier(tier)
    return {
      tier,
      displayName: TIER_DISPLAY_NAMES[tier],
      pricing: TIER_PRICING[tier],
      features,
      featureDescriptions: features.map((f) => FEATURE_DESCRIPTIONS[f]),
    }
  })
}

// ============================================================================
// Graceful Degradation Handler
// ============================================================================

/**
 * Handle a denied feature access gracefully
 *
 * This function provides a comprehensive response when a feature is not
 * available, including helpful messages and upgrade information.
 *
 * @param feature - The feature that was denied
 * @param currentTier - The user's current license tier
 * @returns Graceful degradation result with upgrade information
 *
 * @example
 * ```typescript
 * const result = handleFeatureDenied('audit_logging', 'team');
 * console.log(result.message);
 * // "Audit Logging requires Enterprise tier ($55/user/month). Upgrade at https://skillsmith.app/upgrade?tier=enterprise&feature=audit_logging"
 * ```
 */
export function handleFeatureDenied(
  feature: FeatureFlag,
  currentTier: LicenseTier
): GracefulDegradationResult {
  const requiredTier = getRequiredTier(feature)
  const availableAlternatives = getFeaturesForTier(currentTier)

  return {
    allowed: false,
    feature,
    requiredTier,
    currentTier,
    message: createUpgradePrompt(feature),
    detailedMessage: createDetailedUpgradePrompt(feature, currentTier),
    upgradeUrl: getUpgradeUrl(requiredTier, { feature, source: 'feature-denied' }),
    pricingUrl: getPricingUrl({ feature, currentTier }),
    availableAlternatives,
  }
}

/**
 * Check if a feature is available for a tier and handle gracefully if not
 *
 * @param feature - The feature to check
 * @param currentTier - The user's current tier
 * @returns Degradation result if denied, null if allowed
 */
export function checkFeatureGracefully(
  feature: FeatureFlag,
  currentTier: LicenseTier
): GracefulDegradationResult | null {
  const requiredTier = getRequiredTier(feature)

  // Check if the feature is available in the current tier
  const availableFeatures = getFeaturesForTier(currentTier)
  if (availableFeatures.includes(feature)) {
    return null // Feature is available
  }

  // Check tier hierarchy (enterprise includes all, team includes team features)
  const tierHierarchy: Record<LicenseTier, number> = {
    community: 0,
    team: 1,
    enterprise: 2,
  }

  if (tierHierarchy[currentTier] >= tierHierarchy[requiredTier]) {
    return null // Current tier is sufficient
  }

  return handleFeatureDenied(feature, currentTier)
}

// ============================================================================
// MCP Response Formatters
// ============================================================================

/**
 * Format a graceful degradation result as an MCP tool response
 *
 * @param result - The degradation result
 * @returns MCP-formatted response
 */
export function formatAsMcpResponse(result: GracefulDegradationResult): {
  content: Array<{ type: 'text'; text: string }>
  isError: false
  _meta: {
    upgradeRequired: true
    feature: FeatureFlag
    requiredTier: LicenseTier
    upgradeUrl: string
    pricingUrl: string
  }
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            status: 'upgrade_required',
            message: result.message,
            feature: result.feature,
            requiredTier: result.requiredTier,
            currentTier: result.currentTier,
            upgradeUrl: result.upgradeUrl,
            pricingUrl: result.pricingUrl,
            availableFeatures: result.availableAlternatives.map((f) => ({
              id: f,
              name: FEATURE_DISPLAY_NAMES[f],
            })),
          },
          null,
          2
        ),
      },
    ],
    isError: false,
    _meta: {
      upgradeRequired: true,
      feature: result.feature,
      requiredTier: result.requiredTier,
      upgradeUrl: result.upgradeUrl,
      pricingUrl: result.pricingUrl,
    },
  }
}

/**
 * Create a short, console-friendly upgrade notice
 *
 * @param feature - The feature requiring upgrade
 * @returns Short upgrade notice
 */
export function createShortUpgradeNotice(feature: FeatureFlag): string {
  const requiredTier = getRequiredTier(feature)
  const displayName = FEATURE_DISPLAY_NAMES[feature]
  return `${displayName} is a ${TIER_DISPLAY_NAMES[requiredTier]} feature. See ${BASE_URL}/pricing for details.`
}

// ============================================================================
// Logging Helpers
// ============================================================================

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

/**
 * Create a degradation event for logging/analytics
 *
 * @param feature - The feature that was denied
 * @param currentTier - The user's current tier
 * @param source - The source/context of the degradation
 * @returns Degradation event object
 */
export function createDegradationEvent(
  feature: FeatureFlag,
  currentTier: LicenseTier,
  source: string
): DegradationEvent {
  const requiredTier = getRequiredTier(feature)
  return {
    timestamp: new Date().toISOString(),
    feature,
    requiredTier,
    currentTier,
    source,
  }
}
