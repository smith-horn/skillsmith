/**
 * SMI-1060: Graceful Degradation Strategies
 *
 * URL generation, upgrade prompt creation, and tier comparison
 * utilities for graceful degradation handling.
 */

import type { FeatureFlag, LicenseTier } from './types.js'
import { getRequiredTier, getFeaturesForTier } from './TierMapping.js'
import {
  BASE_URL,
  TIER_PRICING,
  FEATURE_DISPLAY_NAMES,
  FEATURE_DESCRIPTIONS,
  TIER_DISPLAY_NAMES,
  type UpgradePromptOptions,
  type TierComparisonEntry,
  type DegradationEvent,
} from './degradation-types.js'

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
// Tier Comparison
// ============================================================================

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

// ============================================================================
// Logging Helpers
// ============================================================================

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
