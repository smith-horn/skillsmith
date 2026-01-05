/**
 * SMI-1059: Feature Required Error
 *
 * Error thrown when a required feature is not available
 * in the current license tier.
 */

import type { FeatureFlag, LicenseTier } from './types.js'

/**
 * Error thrown when attempting to use a feature that is not
 * available in the current license tier.
 *
 * @example
 * ```typescript
 * throw new FeatureRequiredError('sso_saml', 'enterprise', 'team');
 * // Error: Feature 'sso_saml' requires 'enterprise' tier, but current tier is 'team'
 * ```
 */
export class FeatureRequiredError extends Error {
  /**
   * The feature that was required but not available
   */
  public readonly feature: FeatureFlag

  /**
   * The minimum tier required to access the feature
   */
  public readonly requiredTier: LicenseTier

  /**
   * The current license tier
   */
  public readonly currentTier: LicenseTier

  /**
   * Create a new FeatureRequiredError
   *
   * @param feature - The feature flag that was required
   * @param requiredTier - The minimum tier required for the feature
   * @param currentTier - The current license tier
   */
  constructor(feature: FeatureFlag, requiredTier: LicenseTier, currentTier: LicenseTier) {
    const message = `Feature '${feature}' requires '${requiredTier}' tier, but current tier is '${currentTier}'`
    super(message)

    this.name = 'FeatureRequiredError'
    this.feature = feature
    this.requiredTier = requiredTier
    this.currentTier = currentTier

    // Maintains proper stack trace for where error was thrown (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FeatureRequiredError)
    }
  }
}
