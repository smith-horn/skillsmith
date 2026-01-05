/**
 * SMI-1053: LicenseValidator
 *
 * Validates JWT-based license keys for Skillsmith Enterprise.
 * Uses the jose library for secure JWT verification.
 */

import * as jose from 'jose'

import type {
  FeatureFlag,
  License,
  LicensePayload,
  LicenseTier,
  LicenseValidationResult,
  LicenseValidatorOptions,
} from './types.js'
import { LICENSE_KEY_ENV_VAR, LICENSE_PUBLIC_KEY_ENV_VAR, TIER_FEATURES } from './types.js'

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_OPTIONS: Required<Omit<LicenseValidatorOptions, 'publicKey'>> = {
  issuer: 'skillsmith',
  audience: 'skillsmith-enterprise',
  clockTolerance: 60,
  keyTtlMs: 0,
}

// ============================================================================
// LicenseValidator Class
// ============================================================================

/**
 * Validates JWT-based license keys for Skillsmith Enterprise
 *
 * @example
 * ```typescript
 * const validator = new LicenseValidator({
 *   publicKey: process.env.SKILLSMITH_LICENSE_PUBLIC_KEY
 * });
 *
 * const result = await validator.validate(licenseKey);
 * if (result.valid) {
 *   console.log(`License tier: ${result.license.tier}`);
 * }
 * ```
 *
 * @example Key Rotation Support
 * ```typescript
 * // For environments with key rotation, configure a TTL
 * const validator = new LicenseValidator({
 *   publicKey: process.env.SKILLSMITH_LICENSE_PUBLIC_KEY,
 *   keyTtlMs: 3600000 // Re-import key every hour
 * });
 *
 * // Or manually clear the cache when notified of key rotation
 * validator.clearKeyCache();
 * ```
 */
/**
 * Key type returned by jose import functions (importSPKI, importJWK)
 * Defined locally to avoid jose version compatibility issues
 */
type JoseKeyLike = Awaited<ReturnType<typeof jose.importSPKI>> | Uint8Array

export class LicenseValidator {
  private readonly options: Required<Omit<LicenseValidatorOptions, 'publicKey'>> & {
    publicKey?: string
  }
  private currentLicense: License | null = null
  private publicKeyCache: JoseKeyLike | null = null
  private publicKeyCacheTimestamp: number | null = null

  /**
   * Create a new LicenseValidator
   *
   * @param options - Configuration options
   */
  constructor(options: LicenseValidatorOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Validate a JWT license key
   *
   * @param key - The JWT license key to validate
   * @returns Validation result with license details or error
   */
  async validate(key: string): Promise<LicenseValidationResult> {
    try {
      // Get the public key for verification
      const publicKey = await this.getPublicKey()
      if (!publicKey) {
        return {
          valid: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'No public key configured for license verification',
          },
        }
      }

      // Verify and decode the JWT
      const { payload } = await jose.jwtVerify(key, publicKey, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        clockTolerance: this.options.clockTolerance,
      })

      // Validate the payload structure
      const validationResult = this.validatePayload(payload)
      if (!validationResult.valid) {
        return validationResult
      }

      // Extract license data
      const licensePayload = payload as unknown as LicensePayload

      // Create the license object
      const license: License = {
        tier: licensePayload.tier,
        features: licensePayload.features,
        customerId: licensePayload.customerId,
        issuedAt: new Date(licensePayload.issuedAt * 1000),
        expiresAt: new Date(licensePayload.expiresAt * 1000),
        rawToken: key,
      }

      // Store the validated license
      this.currentLicense = license

      return {
        valid: true,
        license,
      }
    } catch (error) {
      return this.handleValidationError(error)
    }
  }

  /**
   * Check if the current license has a specific feature
   *
   * @param feature - The feature flag to check
   * @returns true if the license has the feature, false otherwise
   */
  hasFeature(feature: FeatureFlag): boolean {
    if (!this.currentLicense) {
      return false
    }

    // Check if feature is explicitly in the license features
    if (this.currentLicense.features.includes(feature)) {
      return true
    }

    // Check if feature is included in the tier's default features
    const tierFeatures = TIER_FEATURES[this.currentLicense.tier]
    return tierFeatures.includes(feature)
  }

  /**
   * Get the currently validated license
   *
   * @returns The current license or null if no valid license is loaded
   */
  getLicense(): License | null {
    return this.currentLicense
  }

  /**
   * Get the current license tier
   *
   * @returns The license tier or 'community' if no valid license is loaded
   */
  getTier(): LicenseTier {
    return this.currentLicense?.tier ?? 'community'
  }

  /**
   * Clear the current license (useful for testing or logout scenarios)
   */
  clearLicense(): void {
    this.currentLicense = null
  }

  /**
   * Clear the cached public key.
   * Call this method when you know the public key has been rotated
   * and you need to force a re-import on the next validation.
   *
   * @example
   * ```typescript
   * // When notified of key rotation
   * validator.clearKeyCache();
   * // Next validate() call will re-import the public key
   * ```
   */
  clearKeyCache(): void {
    this.publicKeyCache = null
    this.publicKeyCacheTimestamp = null
  }

  /**
   * Validate license from the environment variable
   *
   * @returns Validation result
   */
  async validateFromEnvironment(): Promise<LicenseValidationResult> {
    const key = process.env[LICENSE_KEY_ENV_VAR]

    if (!key) {
      return {
        valid: false,
        error: {
          code: 'MISSING_CLAIMS',
          message: `No license key found in environment variable ${LICENSE_KEY_ENV_VAR}`,
        },
      }
    }

    return this.validate(key)
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Get the public key for JWT verification.
   * Returns cached key if available and not expired (based on keyTtlMs).
   */
  private async getPublicKey(): Promise<JoseKeyLike | null> {
    // Check if cached key is still valid
    if (this.publicKeyCache && this.publicKeyCacheTimestamp !== null) {
      const ttl = this.options.keyTtlMs
      // If TTL is 0 (default), cache never expires
      if (ttl === 0) {
        return this.publicKeyCache
      }
      // Check if cache has expired
      const elapsed = Date.now() - this.publicKeyCacheTimestamp
      if (elapsed < ttl) {
        return this.publicKeyCache
      }
      // Cache expired, clear it
      this.publicKeyCache = null
      this.publicKeyCacheTimestamp = null
    }

    // Get key from options or environment
    const keyData = this.options.publicKey ?? process.env[LICENSE_PUBLIC_KEY_ENV_VAR]

    if (!keyData) {
      return null
    }

    try {
      // Try to import as SPKI (PEM format)
      if (keyData.includes('-----BEGIN')) {
        this.publicKeyCache = await jose.importSPKI(keyData, 'RS256')
        this.publicKeyCacheTimestamp = Date.now()
        return this.publicKeyCache
      }

      // Try to import as JWK
      const jwk = JSON.parse(keyData) as jose.JWK
      this.publicKeyCache = await jose.importJWK(jwk, 'RS256')
      this.publicKeyCacheTimestamp = Date.now()
      return this.publicKeyCache
    } catch {
      // If parsing as JWK fails, try as raw key
      try {
        this.publicKeyCache = await jose.importSPKI(keyData, 'RS256')
        this.publicKeyCacheTimestamp = Date.now()
        return this.publicKeyCache
      } catch {
        return null
      }
    }
  }

  /**
   * Validate the JWT payload structure
   */
  private validatePayload(payload: jose.JWTPayload): LicenseValidationResult {
    // Check required claims
    const requiredClaims = ['tier', 'features', 'customerId', 'issuedAt', 'expiresAt'] as const
    const missingClaims = requiredClaims.filter((claim) => !(claim in payload))

    if (missingClaims.length > 0) {
      return {
        valid: false,
        error: {
          code: 'MISSING_CLAIMS',
          message: `Missing required claims: ${missingClaims.join(', ')}`,
          details: { missingClaims },
        },
      }
    }

    // Validate tier
    const validTiers: LicenseTier[] = ['community', 'team', 'enterprise']
    const tier = payload['tier'] as string

    if (!validTiers.includes(tier as LicenseTier)) {
      return {
        valid: false,
        error: {
          code: 'INVALID_TIER',
          message: `Invalid license tier: ${tier}`,
          details: { tier, validTiers },
        },
      }
    }

    // Validate features array
    const features = payload['features'] as unknown
    if (!Array.isArray(features)) {
      return {
        valid: false,
        error: {
          code: 'INVALID_FEATURES',
          message: 'Features must be an array',
          details: { features },
        },
      }
    }

    // Validate each feature is a string
    const invalidFeatures = features.filter((f) => typeof f !== 'string')
    if (invalidFeatures.length > 0) {
      return {
        valid: false,
        error: {
          code: 'INVALID_FEATURES',
          message: 'All features must be strings',
          details: { invalidFeatures },
        },
      }
    }

    // Validate timestamps
    const issuedAt = payload['issuedAt'] as number
    const expiresAt = payload['expiresAt'] as number

    if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number') {
      return {
        valid: false,
        error: {
          code: 'MISSING_CLAIMS',
          message: 'issuedAt and expiresAt must be numeric timestamps',
        },
      }
    }

    // Validate customerId
    const customerId = payload['customerId'] as string
    if (typeof customerId !== 'string' || customerId.length === 0) {
      return {
        valid: false,
        error: {
          code: 'MISSING_CLAIMS',
          message: 'customerId must be a non-empty string',
        },
      }
    }

    return { valid: true }
  }

  /**
   * Handle validation errors and map to appropriate error codes
   */
  private handleValidationError(error: unknown): LicenseValidationResult {
    if (error instanceof jose.errors.JWTExpired) {
      return {
        valid: false,
        error: {
          code: 'TOKEN_EXPIRED',
          message: 'License has expired',
          details: { expiredAt: error.claim },
        },
      }
    }

    if (error instanceof jose.errors.JWTClaimValidationFailed) {
      if (error.claim === 'nbf') {
        return {
          valid: false,
          error: {
            code: 'TOKEN_NOT_YET_VALID',
            message: 'License is not yet valid',
            details: { notBefore: error.claim },
          },
        }
      }

      return {
        valid: false,
        error: {
          code: 'INVALID_TOKEN',
          message: `JWT claim validation failed: ${error.message}`,
          details: { claim: error.claim },
        },
      }
    }

    if (error instanceof jose.errors.JWSSignatureVerificationFailed) {
      return {
        valid: false,
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'Invalid license signature',
        },
      }
    }

    if (error instanceof jose.errors.JWTInvalid) {
      // Check if it's a signature-related error (malformed signature, base64 decode error)
      const message = error.message.toLowerCase()
      if (message.includes('signature') || message.includes('jws')) {
        return {
          valid: false,
          error: {
            code: 'INVALID_SIGNATURE',
            message: 'Invalid license signature',
          },
        }
      }
      return {
        valid: false,
        error: {
          code: 'INVALID_TOKEN',
          message: `Invalid JWT: ${error.message}`,
        },
      }
    }

    // Check for generic errors that indicate signature issues
    if (error instanceof Error) {
      const message = error.message.toLowerCase()
      if (message.includes('signature') || message.includes('jws') || message.includes('decod')) {
        return {
          valid: false,
          error: {
            code: 'INVALID_SIGNATURE',
            message: 'Invalid license signature',
          },
        }
      }
    }

    // Generic error handling
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      valid: false,
      error: {
        code: 'UNKNOWN_ERROR',
        message: `License validation failed: ${message}`,
      },
    }
  }
}
