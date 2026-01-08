/**
 * SMI-1061: Comprehensive License Error Handling
 *
 * Error classes for all license-related failures with proper error codes,
 * tier information, and actionable upgrade URLs.
 */

import type { FeatureFlag, LicenseTier } from '../types.js'

// ============================================================================
// Error Codes
// ============================================================================

/**
 * License error codes for programmatic handling
 */
export const LICENSE_ERROR_CODES = {
  LICENSE_EXPIRED: 'E001',
  LICENSE_INVALID: 'E002',
  LICENSE_NOT_FOUND: 'E003',
  FEATURE_NOT_AVAILABLE: 'E004',
  QUOTA_EXCEEDED: 'E005',
} as const

export type LicenseErrorCode = (typeof LICENSE_ERROR_CODES)[keyof typeof LICENSE_ERROR_CODES]

// ============================================================================
// Base License Error
// ============================================================================

/**
 * Error details interface for license errors
 */
export interface LicenseErrorDetails {
  /** Error code for programmatic handling */
  code: LicenseErrorCode
  /** Current license tier (if known) */
  currentTier?: LicenseTier
  /** Required tier for the operation */
  requiredTier?: LicenseTier
  /** Feature that triggered the error (if applicable) */
  feature?: FeatureFlag | string
  /** URL to upgrade the license */
  upgradeUrl?: string
  /** Additional context-specific details */
  context?: Record<string, unknown>
}

/**
 * Base class for all license-related errors
 *
 * @example
 * ```typescript
 * try {
 *   await validateLicense();
 * } catch (error) {
 *   if (error instanceof LicenseError) {
 *     console.log(`Error ${error.code}: ${error.message}`);
 *     console.log(`Upgrade at: ${error.upgradeUrl}`);
 *   }
 * }
 * ```
 */
export class LicenseError extends Error {
  /** Error code for programmatic handling */
  public readonly code: LicenseErrorCode

  /** Current license tier */
  public readonly currentTier?: LicenseTier

  /** Required tier for the operation */
  public readonly requiredTier?: LicenseTier

  /** Feature that triggered the error */
  public readonly feature?: FeatureFlag | string

  /** URL to upgrade the license */
  public readonly upgradeUrl: string

  /** Additional context */
  public readonly context?: Record<string, unknown>

  /** Timestamp when the error occurred */
  public readonly timestamp: Date

  constructor(message: string, details: LicenseErrorDetails) {
    super(message)
    this.name = 'LicenseError'
    this.code = details.code
    if (details.currentTier !== undefined) this.currentTier = details.currentTier
    if (details.requiredTier !== undefined) this.requiredTier = details.requiredTier
    if (details.feature !== undefined) this.feature = details.feature
    this.upgradeUrl = details.upgradeUrl ?? 'https://skillsmith.app/upgrade'
    if (details.context !== undefined) this.context = details.context
    this.timestamp = new Date()

    // Maintains proper stack trace for where error was thrown (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  /**
   * Convert error to a plain object for serialization
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      currentTier: this.currentTier,
      requiredTier: this.requiredTier,
      feature: this.feature,
      upgradeUrl: this.upgradeUrl,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
    }
  }
}

// ============================================================================
// Specific License Errors
// ============================================================================

/**
 * Error thrown when a license has expired
 *
 * @example
 * ```typescript
 * throw new LicenseExpiredError(new Date('2024-01-01'), 'enterprise');
 * ```
 */
export class LicenseExpiredError extends LicenseError {
  /** Date when the license expired */
  public readonly expiredAt: Date

  constructor(expiredAt: Date, currentTier?: LicenseTier) {
    const message = `License expired on ${expiredAt.toISOString()}`
    const details: LicenseErrorDetails = {
      code: LICENSE_ERROR_CODES.LICENSE_EXPIRED,
      upgradeUrl: 'https://skillsmith.app/renew',
      context: { expiredAt: expiredAt.toISOString() },
    }
    if (currentTier !== undefined) details.currentTier = currentTier
    super(message, details)
    this.name = 'LicenseExpiredError'
    this.expiredAt = expiredAt
  }
}

/**
 * Error thrown when a license format or signature is invalid
 *
 * @example
 * ```typescript
 * throw new LicenseInvalidError('Invalid JWT signature');
 * ```
 */
export class LicenseInvalidError extends LicenseError {
  /** Specific reason for invalidity */
  public readonly reason: string

  constructor(reason: string, context?: Record<string, unknown>) {
    const message = `Invalid license: ${reason}`
    super(message, {
      code: LICENSE_ERROR_CODES.LICENSE_INVALID,
      upgradeUrl: 'https://skillsmith.app/support',
      context: { reason, ...context },
    })
    this.name = 'LicenseInvalidError'
    this.reason = reason
  }
}

/**
 * Error thrown when no license key is provided
 *
 * @example
 * ```typescript
 * throw new LicenseNotFoundError();
 * ```
 */
export class LicenseNotFoundError extends LicenseError {
  constructor(context?: Record<string, unknown>) {
    const message = 'No license key found. Set SKILLSMITH_LICENSE_KEY environment variable.'
    const details: LicenseErrorDetails = {
      code: LICENSE_ERROR_CODES.LICENSE_NOT_FOUND,
      currentTier: 'community',
      upgradeUrl: 'https://skillsmith.app/pricing',
    }
    if (context !== undefined) details.context = context
    super(message, details)
    this.name = 'LicenseNotFoundError'
  }
}

/**
 * Error thrown when a feature is not available in the current tier
 *
 * This is an enhanced version of FeatureRequiredError with additional
 * details for error recovery and upgrade messaging.
 *
 * @example
 * ```typescript
 * throw new FeatureNotAvailableError('audit_logging', 'team', 'enterprise');
 * ```
 */
export class FeatureNotAvailableError extends LicenseError {
  constructor(
    feature: FeatureFlag | string,
    currentTier: LicenseTier,
    requiredTier: LicenseTier,
    context?: Record<string, unknown>
  ) {
    const message = `Feature '${feature}' requires '${requiredTier}' tier, but current tier is '${currentTier}'`
    const details: LicenseErrorDetails = {
      code: LICENSE_ERROR_CODES.FEATURE_NOT_AVAILABLE,
      feature,
      currentTier,
      requiredTier,
      upgradeUrl: `https://skillsmith.app/upgrade?feature=${feature}&from=${currentTier}&to=${requiredTier}`,
    }
    if (context !== undefined) details.context = context
    super(message, details)
    this.name = 'FeatureNotAvailableError'
  }
}

/**
 * Error thrown when a license quota is exceeded (e.g., seat-based billing)
 *
 * @example
 * ```typescript
 * throw new LicenseQuotaExceededError('seats', 10, 15, 'enterprise');
 * ```
 */
export class LicenseQuotaExceededError extends LicenseError {
  /** Type of quota exceeded */
  public readonly quotaType: string

  /** Maximum allowed quota */
  public readonly maxQuota: number

  /** Current usage */
  public readonly currentUsage: number

  constructor(
    quotaType: string,
    maxQuota: number,
    currentUsage: number,
    currentTier?: LicenseTier,
    context?: Record<string, unknown>
  ) {
    const message = `${quotaType} quota exceeded: using ${currentUsage} of ${maxQuota} allowed`
    const details: LicenseErrorDetails = {
      code: LICENSE_ERROR_CODES.QUOTA_EXCEEDED,
      upgradeUrl: `https://skillsmith.app/upgrade?quota=${quotaType}`,
      context: { quotaType, maxQuota, currentUsage, ...context },
    }
    if (currentTier !== undefined) details.currentTier = currentTier
    super(message, details)
    this.name = 'LicenseQuotaExceededError'
    this.quotaType = quotaType
    this.maxQuota = maxQuota
    this.currentUsage = currentUsage
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if an error is a LicenseError
 */
export function isLicenseError(error: unknown): error is LicenseError {
  return error instanceof LicenseError
}

/**
 * Type guard to check if an error is a LicenseExpiredError
 */
export function isLicenseExpiredError(error: unknown): error is LicenseExpiredError {
  return error instanceof LicenseExpiredError
}

/**
 * Type guard to check if an error is a LicenseInvalidError
 */
export function isLicenseInvalidError(error: unknown): error is LicenseInvalidError {
  return error instanceof LicenseInvalidError
}

/**
 * Type guard to check if an error is a LicenseNotFoundError
 */
export function isLicenseNotFoundError(error: unknown): error is LicenseNotFoundError {
  return error instanceof LicenseNotFoundError
}

/**
 * Type guard to check if an error is a FeatureNotAvailableError
 */
export function isFeatureNotAvailableError(error: unknown): error is FeatureNotAvailableError {
  return error instanceof FeatureNotAvailableError
}

/**
 * Type guard to check if an error is a LicenseQuotaExceededError
 */
export function isLicenseQuotaExceededError(error: unknown): error is LicenseQuotaExceededError {
  return error instanceof LicenseQuotaExceededError
}

// ============================================================================
// Error Factory
// ============================================================================

/**
 * Create a license error from a validation error code
 */
export function createLicenseError(
  validationCode: string,
  details: Partial<LicenseErrorDetails> = {}
): LicenseError {
  const context = details.context
  switch (validationCode) {
    case 'TOKEN_EXPIRED':
      return new LicenseExpiredError(
        context?.['expiredAt'] ? new Date(context['expiredAt'] as string) : new Date(),
        details.currentTier
      )

    case 'INVALID_TOKEN':
    case 'INVALID_SIGNATURE':
    case 'INVALID_TIER':
    case 'INVALID_FEATURES':
      return new LicenseInvalidError(
        (context?.['reason'] as string) || `License validation failed: ${validationCode}`,
        context
      )

    case 'MISSING_CLAIMS':
      if (context?.['missingClaims']) {
        return new LicenseInvalidError(
          `Missing required claims: ${(context['missingClaims'] as string[]).join(', ')}`,
          context
        )
      }
      return new LicenseNotFoundError(context)

    default:
      return new LicenseError(`License error: ${validationCode}`, {
        code: LICENSE_ERROR_CODES.LICENSE_INVALID,
        ...details,
      })
  }
}
