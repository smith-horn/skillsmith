/**
 * License Validation Helpers for Skillsmith CLI
 *
 * Handles license key decoding, validation, and enterprise package loading.
 *
 * @module @skillsmith/cli/utils/license-validation
 */

import type { LicensePayload, LicenseStatus, EnterpriseLicenseValidator } from './license-types.js'
import { TIER_FEATURES } from './license-types.js'

// Cache for the enterprise validator to avoid repeated dynamic imports
let enterpriseValidatorCache: EnterpriseLicenseValidator | null | undefined = undefined

/**
 * Attempt to load the enterprise license validator
 * Returns null if the package is not installed (expected for community users)
 *
 * @returns Enterprise validator or null if not available
 */
export async function tryLoadEnterpriseValidator(): Promise<EnterpriseLicenseValidator | null> {
  // Return cached result if already loaded
  if (enterpriseValidatorCache !== undefined) {
    return enterpriseValidatorCache
  }

  try {
    // Dynamic import with variable to prevent TypeScript from resolving at compile time
    // This is an optional peer dependency that may not be installed
    const packageName = '@skillsmith/enterprise'
    const enterprise = (await import(/* webpackIgnore: true */ packageName)) as Record<
      string,
      unknown
    >

    if (enterprise['LicenseValidator']) {
      const ValidatorClass = enterprise['LicenseValidator'] as new () => EnterpriseLicenseValidator
      enterpriseValidatorCache = new ValidatorClass()
      return enterpriseValidatorCache
    }

    enterpriseValidatorCache = null
    return null
  } catch {
    // Enterprise package not installed - this is expected for community users
    enterpriseValidatorCache = null
    return null
  }
}

/**
 * Reset the enterprise validator cache (for testing purposes)
 * @internal
 */
export function _resetEnterpriseValidatorCache(): void {
  enterpriseValidatorCache = undefined
}

/**
 * Decode and validate a license key using simple base64 JSON decoding
 *
 * @deprecated This function is used only when @skillsmith/enterprise is not available.
 * For paid tiers, enterprise package with proper RS256 JWT validation should be used.
 * Community users without a license key don't need validation.
 *
 * @param licenseKey - The license key to decode
 * @returns Decoded payload or null if invalid
 */
export function decodeLicenseKey(licenseKey: string): LicensePayload | null {
  try {
    // License key format: base64 encoded JSON
    // In production, this would include cryptographic signature verification
    const decoded = Buffer.from(licenseKey, 'base64').toString('utf-8')
    const payload = JSON.parse(decoded) as LicensePayload

    // Validate required fields
    if (!payload.tier || !['team', 'enterprise'].includes(payload.tier)) {
      return null
    }

    if (!payload.expiresAt || isNaN(Date.parse(payload.expiresAt))) {
      return null
    }

    return payload
  } catch {
    return null
  }
}

/**
 * Check if a license has expired
 *
 * @param expiresAt - Expiration date
 * @returns True if expired
 */
export function isExpired(expiresAt: Date): boolean {
  return expiresAt < new Date()
}

/**
 * Get the current license status using legacy base64 decoding
 *
 * @deprecated Use getLicenseStatus() which properly uses enterprise JWT validation.
 * This function is preserved only for backwards compatibility in tests.
 *
 * @returns Promise resolving to license status
 */
export async function getLicenseStatusLegacy(): Promise<LicenseStatus> {
  const licenseKey = process.env['SKILLSMITH_LICENSE_KEY']

  // No license key = community tier (free, not an error)
  if (!licenseKey) {
    return {
      valid: true,
      tier: 'community',
      features: TIER_FEATURES.community,
    }
  }

  // Decode the license key
  const payload = decodeLicenseKey(licenseKey)

  if (!payload) {
    return {
      valid: false,
      tier: 'community',
      features: TIER_FEATURES.community,
      error: 'Invalid license key format',
    }
  }

  const expiresAt = new Date(payload.expiresAt)

  // Check expiration
  if (isExpired(expiresAt)) {
    return {
      valid: false,
      tier: 'community',
      expiresAt,
      features: TIER_FEATURES.community,
      error: `License expired on ${expiresAt.toISOString().split('T')[0]}`,
    }
  }

  // Valid paid license
  return {
    valid: true,
    tier: payload.tier,
    expiresAt,
    features: payload.features || TIER_FEATURES[payload.tier],
  }
}

/**
 * Get the current license status
 *
 * Reads the license key from SKILLSMITH_LICENSE_KEY environment variable.
 * If no key is set, returns community tier (not an error).
 * If key is invalid or expired, returns status with error but continues.
 *
 * When @skillsmith/enterprise is available, uses proper RS256 JWT validation.
 * Otherwise, falls back to simple base64 JSON decoding (for development/testing only).
 *
 * @returns Promise resolving to license status
 */
export async function getLicenseStatus(): Promise<LicenseStatus> {
  const licenseKey = process.env['SKILLSMITH_LICENSE_KEY']

  // No license key = community tier (free, not an error)
  if (!licenseKey) {
    return {
      valid: true,
      tier: 'community',
      features: TIER_FEATURES.community,
    }
  }

  // Try to use enterprise validator for proper JWT verification
  const validator = await tryLoadEnterpriseValidator()

  if (validator) {
    // Enterprise package available - use proper RS256 JWT validation
    try {
      const result = await validator.validate(licenseKey)

      if (result.valid && result.license) {
        return {
          valid: true,
          tier: result.license.tier,
          expiresAt: result.license.expiresAt,
          features:
            result.license.features.length > 0
              ? result.license.features
              : TIER_FEATURES[result.license.tier],
        }
      }

      // Invalid license - return error with community fallback
      return {
        valid: false,
        tier: 'community',
        features: TIER_FEATURES.community,
        error: result.error?.message || 'Invalid license key',
      }
    } catch {
      // Validation threw an error - treat as invalid
      return {
        valid: false,
        tier: 'community',
        features: TIER_FEATURES.community,
        error: 'License validation failed',
      }
    }
  }

  // Enterprise package not available - fall back to community tier
  // Note: We don't attempt base64 decoding for paid tiers without proper validation
  // This ensures security by requiring the enterprise package for paid features
  return {
    valid: true,
    tier: 'community',
    features: TIER_FEATURES.community,
  }
}
