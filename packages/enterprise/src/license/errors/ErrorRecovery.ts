/**
 * SMI-1061: License Error Recovery Strategies
 *
 * Provides recovery suggestions and automatic recovery attempts
 * for license-related errors.
 */

import type { LicenseTier } from '../types.js'
import {
  LicenseError,
  LicenseInvalidError,
  FeatureNotAvailableError,
  LicenseQuotaExceededError,
  LICENSE_ERROR_CODES,
  type LicenseErrorCode,
} from './index.js'

// ============================================================================
// Recovery Types
// ============================================================================

/**
 * Actions that can be suggested for recovery
 */
export type RecoveryAction =
  | 'renew_license'
  | 'upgrade_tier'
  | 'contact_support'
  | 'set_license_key'
  | 'refresh_license'
  | 'reduce_usage'
  | 'clear_cache'
  | 'verify_key_format'

/**
 * Priority levels for recovery suggestions
 */
export type RecoveryPriority = 'immediate' | 'recommended' | 'optional'

/**
 * A single recovery suggestion
 */
export interface RecoverySuggestion {
  /** The recovery action to take */
  action: RecoveryAction
  /** Priority of this suggestion */
  priority: RecoveryPriority
  /** Human-readable description of the recovery step */
  description: string
  /** URL for more information or to take action */
  actionUrl?: string
  /** Whether this recovery can be attempted automatically */
  autoRecoverable: boolean
  /** Estimated time to complete this action */
  estimatedTime?: string
}

/**
 * Result of an automatic recovery attempt
 */
export interface RecoveryResult {
  /** Whether the recovery was successful */
  success: boolean
  /** The action that was attempted */
  action: RecoveryAction
  /** Message describing the result */
  message: string
  /** New license tier after recovery (if applicable) */
  newTier?: LicenseTier
  /** Any error that occurred during recovery */
  error?: Error
}

/**
 * Configuration for recovery attempts
 */
export interface RecoveryConfig {
  /** Maximum number of automatic recovery attempts */
  maxRetries: number
  /** Delay between retries in milliseconds */
  retryDelayMs: number
  /** Whether to enable automatic recovery */
  enableAutoRecovery: boolean
  /** Callback for license refresh (for automatic recovery) */
  onLicenseRefresh?: () => Promise<boolean>
  /** Callback for cache clearing (for automatic recovery) */
  onClearCache?: () => Promise<boolean>
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  enableAutoRecovery: true,
}

// ============================================================================
// Recovery Suggestions by Error Type
// ============================================================================

const RECOVERY_SUGGESTIONS_MAP: Record<LicenseErrorCode, RecoverySuggestion[]> = {
  [LICENSE_ERROR_CODES.LICENSE_EXPIRED]: [
    {
      action: 'renew_license',
      priority: 'immediate',
      description: 'Your license has expired. Renew to continue using premium features.',
      actionUrl: 'https://skillsmith.app/renew',
      autoRecoverable: false,
      estimatedTime: '2-5 minutes',
    },
    {
      action: 'contact_support',
      priority: 'optional',
      description: 'Contact support if you believe this is an error.',
      actionUrl: 'https://skillsmith.app/support',
      autoRecoverable: false,
    },
  ],

  [LICENSE_ERROR_CODES.LICENSE_INVALID]: [
    {
      action: 'verify_key_format',
      priority: 'immediate',
      description: 'Verify that your license key is correctly formatted.',
      autoRecoverable: false,
      estimatedTime: '1-2 minutes',
    },
    {
      action: 'refresh_license',
      priority: 'recommended',
      description: 'Try refreshing your license from the server.',
      autoRecoverable: true,
      estimatedTime: '< 1 minute',
    },
    {
      action: 'contact_support',
      priority: 'optional',
      description: 'Contact support if the issue persists.',
      actionUrl: 'https://skillsmith.app/support',
      autoRecoverable: false,
    },
  ],

  [LICENSE_ERROR_CODES.LICENSE_NOT_FOUND]: [
    {
      action: 'set_license_key',
      priority: 'immediate',
      description: 'Set the SKILLSMITH_LICENSE_KEY environment variable with your license key.',
      autoRecoverable: false,
      estimatedTime: '1-2 minutes',
    },
    {
      action: 'upgrade_tier',
      priority: 'recommended',
      description: 'Purchase a license to access premium features.',
      actionUrl: 'https://skillsmith.app/pricing',
      autoRecoverable: false,
      estimatedTime: '5-10 minutes',
    },
  ],

  [LICENSE_ERROR_CODES.FEATURE_NOT_AVAILABLE]: [
    {
      action: 'upgrade_tier',
      priority: 'immediate',
      description: 'Upgrade your license tier to access this feature.',
      actionUrl: 'https://skillsmith.app/upgrade',
      autoRecoverable: false,
      estimatedTime: '5-10 minutes',
    },
    {
      action: 'contact_support',
      priority: 'optional',
      description: 'Contact sales for enterprise pricing.',
      actionUrl: 'https://skillsmith.app/contact-sales',
      autoRecoverable: false,
    },
  ],

  [LICENSE_ERROR_CODES.QUOTA_EXCEEDED]: [
    {
      action: 'reduce_usage',
      priority: 'immediate',
      description: 'Reduce usage to within your quota limits.',
      autoRecoverable: false,
      estimatedTime: 'Varies',
    },
    {
      action: 'upgrade_tier',
      priority: 'recommended',
      description: 'Upgrade to increase your quota limits.',
      actionUrl: 'https://skillsmith.app/upgrade',
      autoRecoverable: false,
      estimatedTime: '5-10 minutes',
    },
    {
      action: 'contact_support',
      priority: 'optional',
      description: 'Contact sales for custom quota limits.',
      actionUrl: 'https://skillsmith.app/contact-sales',
      autoRecoverable: false,
    },
  ],
}

// ============================================================================
// Recovery Functions
// ============================================================================

/**
 * Get recovery suggestions for a license error
 *
 * @param error - The license error to get suggestions for
 * @returns Array of recovery suggestions sorted by priority
 *
 * @example
 * ```typescript
 * try {
 *   await validateLicense();
 * } catch (error) {
 *   if (error instanceof LicenseError) {
 *     const suggestions = suggestRecovery(error);
 *     suggestions.forEach(s => console.log(`${s.priority}: ${s.description}`));
 *   }
 * }
 * ```
 */
export function suggestRecovery(error: LicenseError): RecoverySuggestion[] {
  const baseSuggestions = RECOVERY_SUGGESTIONS_MAP[error.code] || []

  // Clone suggestions to avoid mutation
  const suggestions = baseSuggestions.map((s) => ({ ...s }))

  // Customize suggestions based on error context
  if (error instanceof FeatureNotAvailableError && error.requiredTier) {
    const upgradeIdx = suggestions.findIndex((s) => s.action === 'upgrade_tier')
    if (upgradeIdx >= 0) {
      const suggestion = suggestions[upgradeIdx]
      if (suggestion) {
        suggestion.actionUrl = error.upgradeUrl
        suggestion.description = `Upgrade to ${error.requiredTier} tier to access the '${error.feature}' feature.`
      }
    }
  }

  if (error instanceof LicenseQuotaExceededError) {
    const reduceIdx = suggestions.findIndex((s) => s.action === 'reduce_usage')
    if (reduceIdx >= 0) {
      const suggestion = suggestions[reduceIdx]
      if (suggestion) {
        suggestion.description = `Reduce ${error.quotaType} usage from ${error.currentUsage} to under ${error.maxQuota}.`
      }
    }
  }

  // Sort by priority
  const priorityOrder: Record<RecoveryPriority, number> = {
    immediate: 0,
    recommended: 1,
    optional: 2,
  }

  return suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
}

/**
 * Check if a license error can potentially be auto-recovered
 *
 * @param error - The license error to check
 * @returns true if automatic recovery may be possible
 *
 * @example
 * ```typescript
 * if (canAutoRecover(error)) {
 *   const result = await attemptRecovery(error, config);
 * }
 * ```
 */
export function canAutoRecover(error: LicenseError): boolean {
  // Only certain error types can be auto-recovered
  if (error instanceof LicenseInvalidError) {
    // Invalid tokens might be recoverable by refreshing
    return true
  }

  // Check if any suggestions are auto-recoverable
  const suggestions = suggestRecovery(error)
  return suggestions.some((s) => s.autoRecoverable)
}

/**
 * Attempt automatic recovery from a license error
 *
 * @param error - The license error to recover from
 * @param config - Recovery configuration
 * @returns Result of the recovery attempt
 *
 * @example
 * ```typescript
 * const result = await attemptRecovery(error, {
 *   maxRetries: 3,
 *   onLicenseRefresh: async () => {
 *     await licenseValidator.validateFromEnvironment();
 *     return true;
 *   }
 * });
 *
 * if (result.success) {
 *   console.log('License recovered successfully');
 * }
 * ```
 */
export async function attemptRecovery(
  error: LicenseError,
  config: Partial<RecoveryConfig> = {}
): Promise<RecoveryResult> {
  const fullConfig = { ...DEFAULT_RECOVERY_CONFIG, ...config }

  if (!fullConfig.enableAutoRecovery) {
    return {
      success: false,
      action: 'refresh_license',
      message: 'Automatic recovery is disabled',
    }
  }

  if (!canAutoRecover(error)) {
    return {
      success: false,
      action: 'contact_support',
      message: 'This error type cannot be automatically recovered',
    }
  }

  // Try refresh first for invalid license errors
  if (error instanceof LicenseInvalidError && fullConfig.onLicenseRefresh) {
    for (let attempt = 1; attempt <= fullConfig.maxRetries; attempt++) {
      try {
        const refreshed = await fullConfig.onLicenseRefresh()
        if (refreshed) {
          return {
            success: true,
            action: 'refresh_license',
            message: 'License refreshed successfully',
          }
        }
      } catch (refreshError) {
        if (attempt === fullConfig.maxRetries) {
          return {
            success: false,
            action: 'refresh_license',
            message: `Failed to refresh license after ${fullConfig.maxRetries} attempts`,
            error: refreshError instanceof Error ? refreshError : new Error(String(refreshError)),
          }
        }
        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, fullConfig.retryDelayMs))
      }
    }
  }

  // Try clearing cache
  if (fullConfig.onClearCache) {
    try {
      const cleared = await fullConfig.onClearCache()
      if (cleared) {
        return {
          success: true,
          action: 'clear_cache',
          message: 'Cache cleared successfully, please retry the operation',
        }
      }
    } catch (cacheError) {
      return {
        success: false,
        action: 'clear_cache',
        message: 'Failed to clear cache',
        error: cacheError instanceof Error ? cacheError : new Error(String(cacheError)),
      }
    }
  }

  return {
    success: false,
    action: 'contact_support',
    message: 'Automatic recovery was not possible',
  }
}

// ============================================================================
// Logging Utilities
// ============================================================================

/**
 * Log level for license errors
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Get the appropriate log level for a license error
 */
export function getErrorLogLevel(error: LicenseError): LogLevel {
  switch (error.code) {
    case LICENSE_ERROR_CODES.LICENSE_EXPIRED:
      return 'warn'
    case LICENSE_ERROR_CODES.LICENSE_INVALID:
      return 'error'
    case LICENSE_ERROR_CODES.LICENSE_NOT_FOUND:
      return 'info'
    case LICENSE_ERROR_CODES.FEATURE_NOT_AVAILABLE:
      return 'info'
    case LICENSE_ERROR_CODES.QUOTA_EXCEEDED:
      return 'warn'
    default:
      return 'error'
  }
}

/**
 * Format a license error for logging
 *
 * @param error - The license error to format
 * @param includeStack - Whether to include the stack trace
 * @returns Formatted log message
 */
export function formatErrorForLogging(error: LicenseError, includeStack = false): string {
  const parts: string[] = [
    `[${error.code}] ${error.name}: ${error.message}`,
    `  Tier: ${error.currentTier ?? 'unknown'} -> ${error.requiredTier ?? 'N/A'}`,
  ]

  if (error.feature) {
    parts.push(`  Feature: ${error.feature}`)
  }

  parts.push(`  Upgrade: ${error.upgradeUrl}`)
  parts.push(`  Time: ${error.timestamp.toISOString()}`)

  if (error.context && Object.keys(error.context).length > 0) {
    parts.push(`  Context: ${JSON.stringify(error.context)}`)
  }

  if (includeStack && error.stack) {
    parts.push(`  Stack: ${error.stack}`)
  }

  return parts.join('\n')
}

/**
 * Create a sanitized error object safe for external logging
 * (removes potentially sensitive data)
 */
export function sanitizeErrorForLogging(
  error: LicenseError
): Record<string, string | number | boolean | undefined> {
  return {
    code: error.code,
    name: error.name,
    message: error.message,
    currentTier: error.currentTier,
    requiredTier: error.requiredTier,
    feature: error.feature,
    timestamp: error.timestamp.toISOString(),
    // Intentionally omit: context (may contain sensitive data), upgradeUrl (contains tier info)
  }
}
