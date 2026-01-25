/**
 * SMI-1060: Graceful Degradation for License Validation
 *
 * Provides user-friendly upgrade prompts and graceful degradation
 * when features are unavailable due to license restrictions.
 */

import type { FeatureFlag, LicenseTier } from './types.js'
import { getRequiredTier, getFeaturesForTier } from './TierMapping.js'

// Re-export types and constants from extracted modules
export {
  BASE_URL,
  TIER_PRICING,
  FEATURE_DISPLAY_NAMES,
  FEATURE_DESCRIPTIONS,
  TIER_DISPLAY_NAMES,
  type GracefulDegradationResult,
  type UpgradePromptOptions,
  type TierComparisonEntry,
  type DegradationEvent,
} from './degradation-types.js'

export {
  getUpgradeUrl,
  getPricingUrl,
  createUpgradePrompt,
  createDetailedUpgradePrompt,
  createShortUpgradeNotice,
  getTierComparison,
  createTierComparisonMessage,
  createDegradationEvent,
} from './degradation-strategies.js'

// Import for internal use
import { FEATURE_DISPLAY_NAMES, type GracefulDegradationResult } from './degradation-types.js'
import {
  getUpgradeUrl,
  getPricingUrl,
  createUpgradePrompt,
  createDetailedUpgradePrompt,
} from './degradation-strategies.js'

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
    individual: 0,
    community: 1,
    team: 2,
    enterprise: 3,
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
