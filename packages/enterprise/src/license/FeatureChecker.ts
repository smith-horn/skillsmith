/**
 * SMI-1059: Feature Flag Checking Utilities
 *
 * Provides utilities for checking feature availability based on
 * the current license tier. Wraps LicenseValidator for convenient
 * feature gating.
 */

import type { FeatureFlag, LicenseTier } from './types.js'
import { TIER_FEATURES } from './types.js'
import { LicenseValidator } from './LicenseValidator.js'
import { getRequiredTier } from './TierMapping.js'
import { FeatureRequiredError } from './FeatureRequiredError.js'

/**
 * Feature checker that wraps LicenseValidator to provide
 * convenient feature availability checking utilities.
 *
 * @example
 * ```typescript
 * const validator = new LicenseValidator({ publicKey: '...' });
 * await validator.validate(licenseKey);
 *
 * const checker = new FeatureChecker(validator);
 *
 * // Check single feature
 * if (checker.checkFeature('sso_saml')) {
 *   // Feature is available
 * }
 *
 * // Assert feature (throws if unavailable)
 * checker.assertFeature('rbac');
 *
 * // Get all available features
 * const features = checker.getAvailableFeatures();
 * ```
 */
export class FeatureChecker {
  private readonly validator: LicenseValidator

  /**
   * Create a new FeatureChecker
   *
   * @param validator - The LicenseValidator instance to wrap
   */
  constructor(validator: LicenseValidator) {
    this.validator = validator
  }

  /**
   * Check if a specific feature is available in the current license
   *
   * @param feature - The feature flag to check
   * @returns true if the feature is available, false otherwise
   *
   * @example
   * ```typescript
   * if (checker.checkFeature('team_workspaces')) {
   *   // Enable team workspace UI
   * }
   * ```
   */
  checkFeature(feature: FeatureFlag): boolean {
    return this.validator.hasFeature(feature)
  }

  /**
   * Check multiple features at once
   *
   * @param features - Array of feature flags to check
   * @returns Map of feature flags to their availability status
   *
   * @example
   * ```typescript
   * const results = checker.checkFeatures(['sso_saml', 'rbac', 'audit_logging']);
   * // Map { 'sso_saml' => true, 'rbac' => true, 'audit_logging' => false }
   * ```
   */
  checkFeatures(features: FeatureFlag[]): Map<FeatureFlag, boolean> {
    const results = new Map<FeatureFlag, boolean>()

    for (const feature of features) {
      results.set(feature, this.checkFeature(feature))
    }

    return results
  }

  /**
   * Get all features available for the current license
   *
   * @returns Array of available feature flags
   *
   * @example
   * ```typescript
   * const available = checker.getAvailableFeatures();
   * // For team tier: ['team_workspaces', 'private_skills', ...]
   * ```
   */
  getAvailableFeatures(): FeatureFlag[] {
    const tier = this.validator.getTier()
    const license = this.validator.getLicense()

    // Get features from the tier's default features
    const tierFeatures = [...TIER_FEATURES[tier]]

    // If there's a license with explicit features, merge them
    if (license?.features) {
      for (const feature of license.features) {
        if (!tierFeatures.includes(feature)) {
          tierFeatures.push(feature)
        }
      }
    }

    return tierFeatures
  }

  /**
   * Get the features from a required list that are not available
   *
   * @param required - Array of required feature flags
   * @returns Array of feature flags that are missing (not available)
   *
   * @example
   * ```typescript
   * const missing = checker.getMissingFeatures(['sso_saml', 'rbac', 'team_workspaces']);
   * // For team tier: ['sso_saml', 'rbac']
   * ```
   */
  getMissingFeatures(required: FeatureFlag[]): FeatureFlag[] {
    return required.filter((feature) => !this.checkFeature(feature))
  }

  /**
   * Assert that a feature is available, throwing if it is not
   *
   * @param feature - The feature flag to assert
   * @throws {FeatureRequiredError} If the feature is not available
   *
   * @example
   * ```typescript
   * try {
   *   checker.assertFeature('sso_saml');
   *   // Feature is available, proceed
   * } catch (error) {
   *   if (error instanceof FeatureRequiredError) {
   *     console.log(`Upgrade to ${error.requiredTier} to access ${error.feature}`);
   *   }
   * }
   * ```
   */
  assertFeature(feature: FeatureFlag): void {
    if (!this.checkFeature(feature)) {
      const requiredTier = getRequiredTier(feature)
      const currentTier = this.validator.getTier()
      throw new FeatureRequiredError(feature, requiredTier, currentTier)
    }
  }

  /**
   * Get the underlying LicenseValidator
   *
   * @returns The LicenseValidator instance
   */
  getValidator(): LicenseValidator {
    return this.validator
  }

  /**
   * Get the current license tier
   *
   * @returns The current license tier
   */
  getTier(): LicenseTier {
    return this.validator.getTier()
  }
}

// ============================================================================
// Function Helpers
// ============================================================================

/**
 * Wrap a function with a feature check, executing fallback if feature is unavailable
 *
 * @param checker - The FeatureChecker instance
 * @param feature - The feature flag required for the function
 * @param fallback - Optional fallback function if feature is unavailable
 * @returns A function wrapper that performs the feature check
 *
 * @example
 * ```typescript
 * const getSSOConfig = withFeatureCheck(
 *   checker,
 *   'sso_saml',
 *   () => ({ enabled: false }) // fallback
 * )(
 *   () => loadSSOConfiguration() // main function
 * );
 *
 * const config = getSSOConfig(); // Returns fallback if no SSO feature
 * ```
 */
export function withFeatureCheck<T>(
  checker: FeatureChecker,
  feature: FeatureFlag,
  fallback?: () => T
): (fn: () => T) => () => T {
  return (fn: () => T) => {
    return () => {
      if (checker.checkFeature(feature)) {
        return fn()
      }

      if (fallback) {
        return fallback()
      }

      // If no fallback provided, throw FeatureRequiredError
      const requiredTier = getRequiredTier(feature)
      const currentTier = checker.getTier()
      throw new FeatureRequiredError(feature, requiredTier, currentTier)
    }
  }
}

/**
 * Assert that a feature is available using a FeatureChecker
 *
 * Convenience function for asserting features outside of a FeatureChecker instance.
 *
 * @param checker - The FeatureChecker instance
 * @param feature - The feature flag to assert
 * @throws {FeatureRequiredError} If the feature is not available
 *
 * @example
 * ```typescript
 * assertFeature(checker, 'audit_logging');
 * // Throws FeatureRequiredError if not available
 * ```
 */
export function assertFeature(checker: FeatureChecker, feature: FeatureFlag): void {
  checker.assertFeature(feature)
}
