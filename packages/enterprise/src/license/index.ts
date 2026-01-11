/**
 * SMI-1053: License Validation Module
 * SMI-1054: License Key Generation Module
 * SMI-1059: Feature Flag Checking Utilities
 * SMI-1061: Comprehensive License Error Handling
 *
 * Exports for JWT-based license validation and generation.
 */

// Main validator class
export { LicenseValidator } from './LicenseValidator.js'

// License key generator (SMI-1054)
export { LicenseKeyGenerator } from './LicenseKeyGenerator.js'
export type { KeyPair, LicenseKeyGeneratorOptions } from './LicenseKeyGenerator.js'

// Feature checker (SMI-1059)
export { FeatureChecker, withFeatureCheck, assertFeature } from './FeatureChecker.js'
export { FeatureRequiredError } from './FeatureRequiredError.js'

// Tier mapping utilities
export { getRequiredTier, getFeaturesForTier, tierIncludes, FEATURE_TIERS } from './TierMapping.js'

// Graceful degradation (SMI-1060)
export {
  createUpgradePrompt,
  createDetailedUpgradePrompt,
  createTierComparisonMessage,
  handleFeatureDenied,
  checkFeatureGracefully,
  getUpgradeUrl,
  getPricingUrl,
  getTierComparison,
  formatAsMcpResponse,
  createShortUpgradeNotice,
  createDegradationEvent,
  TIER_PRICING,
  FEATURE_DISPLAY_NAMES,
  FEATURE_DESCRIPTIONS,
  TIER_DISPLAY_NAMES,
} from './GracefulDegradation.js'
export type {
  GracefulDegradationResult,
  UpgradePromptOptions,
  TierComparisonEntry,
  DegradationEvent,
} from './GracefulDegradation.js'

// License errors (SMI-1061)
export {
  // Error classes
  LicenseError,
  LicenseExpiredError,
  LicenseInvalidError,
  LicenseNotFoundError,
  FeatureNotAvailableError,
  LicenseQuotaExceededError,
  // Error codes
  LICENSE_ERROR_CODES,
  // Type guards
  isLicenseError,
  isLicenseExpiredError,
  isLicenseInvalidError,
  isLicenseNotFoundError,
  isFeatureNotAvailableError,
  isLicenseQuotaExceededError,
  // Factory
  createLicenseError,
} from './errors/index.js'

export type { LicenseErrorCode, LicenseErrorDetails } from './errors/index.js'

// Error recovery (SMI-1061)
export {
  suggestRecovery,
  canAutoRecover,
  attemptRecovery,
  getErrorLogLevel,
  formatErrorForLogging,
  sanitizeErrorForLogging,
} from './errors/ErrorRecovery.js'

export type {
  RecoveryAction,
  RecoveryPriority,
  RecoverySuggestion,
  RecoveryResult,
  RecoveryConfig,
  LogLevel,
} from './errors/ErrorRecovery.js'

// Types
export type {
  EnterpriseFeatureFlag,
  FeatureFlag,
  IndividualFeatureFlag,
  License,
  LicensePayload,
  LicenseQuotas,
  LicenseTier,
  LicenseValidationError,
  LicenseValidationErrorCode,
  LicenseValidationResult,
  LicenseValidatorOptions,
  TeamFeatureFlag,
} from './types.js'

// Constants
export {
  ENTERPRISE_FEATURES,
  INDIVIDUAL_FEATURES,
  LICENSE_KEY_ENV_VAR,
  LICENSE_PUBLIC_KEY_ENV_VAR,
  TEAM_FEATURES,
  TIER_FEATURES,
} from './types.js'

// Quota configuration and utilities
export {
  TIER_QUOTAS,
  WARNING_THRESHOLDS,
  WARNING_CONFIG,
  DORMANT_ACCOUNT_DAYS,
  BILLING_PERIOD_DAYS,
  getQuotaLimit,
  isUnlimited,
  getWarningLevel,
  getWarningConfig,
  getTierPriceDisplay,
  getQuotaDisplay,
  getUpgradeRecommendation,
  buildUpgradeUrl,
  type TierQuotaConfig,
  type WarningThreshold,
  type WarningConfig,
} from './quotas.js'
