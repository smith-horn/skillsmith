/**
 * SMI-1061: MCP Error Formatter for License Errors
 * @see SMI-2741: Types split to errorFormatter.types.ts, builders to errorFormatter.builders.ts
 *
 * Formats license errors into MCP protocol-compliant error responses
 * with actionable information for clients.
 */

// Re-export types from companion file
export type {
  MCPErrorContent,
  MCPErrorResponse,
  LicenseErrorDetails,
  LicenseErrorLike,
  UpgradeUrlConfig,
  ApiAuthErrorDetails,
} from './errorFormatter.types.js'
export { ERROR_MESSAGES, DEFAULT_UPGRADE_URL_CONFIG } from './errorFormatter.types.js'

// Re-export builders from companion file
export {
  generateUpgradeUrl,
  buildUpgradeRequiredResponse,
  buildLicenseExpiredResponse,
  buildQuotaExceededResponse,
  formatAuthenticationError,
  isAuthenticationError,
  extractAuthErrorDetails,
} from './errorFormatter.builders.js'

// Internal imports for functions defined in this file
import type {
  MCPErrorResponse,
  LicenseErrorLike,
  LicenseErrorDetails,
} from './errorFormatter.types.js'

// ============================================================================
// Error Formatting
// ============================================================================

/**
 * Format a license error into an MCP-compliant error response
 *
 * @param error - The license error to format
 * @returns MCP-formatted error response
 *
 * @example
 * ```typescript
 * import { formatLicenseError } from './middleware/errorFormatter.js';
 *
 * try {
 *   await checkFeature('audit_logging');
 * } catch (error) {
 *   if (isLicenseError(error)) {
 *     return formatLicenseError(error);
 *   }
 *   throw error;
 * }
 * ```
 */
export function formatLicenseError(error: LicenseErrorLike): MCPErrorResponse {
  const errorDetails: LicenseErrorDetails = {
    code: error.code || 'LICENSE_ERROR',
    message: error.message,
    feature: error.feature,
    currentTier: error.currentTier,
    requiredTier: error.requiredTier,
    upgradeUrl: error.upgradeUrl || 'https://skillsmith.app/upgrade',
    timestamp: error.timestamp?.toISOString(),
  }

  // Build the error response structure matching MCP protocol
  const errorBody: Record<string, unknown> = {
    error: {
      code: errorDetails.code,
      message: errorDetails.message,
      details: {} as Record<string, unknown>,
    },
  }

  // Add details if present
  const details = errorBody.error as { details: Record<string, unknown> }
  if (errorDetails.feature) {
    details.details.feature = errorDetails.feature
  }
  if (errorDetails.currentTier) {
    details.details.currentTier = errorDetails.currentTier
  }
  if (errorDetails.requiredTier) {
    details.details.requiredTier = errorDetails.requiredTier
  }
  if (errorDetails.upgradeUrl) {
    details.details.upgradeUrl = errorDetails.upgradeUrl
  }

  // Remove empty details object
  if (Object.keys(details.details).length === 0) {
    delete (errorBody.error as Record<string, unknown>).details
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(errorBody, null, 2),
      },
    ],
    isError: true,
    _meta: {
      upgradeUrl: errorDetails.upgradeUrl,
      errorCode: errorDetails.code,
      recoverable: isRecoverableError(errorDetails.code),
    },
  }
}

/**
 * Check if an error code represents a recoverable error
 */
function isRecoverableError(code: string): boolean {
  // License not found and invalid are potentially recoverable
  // (by setting the license key or refreshing)
  const recoverableCodes = ['E002', 'E003', 'LICENSE_INVALID', 'LICENSE_NOT_FOUND']
  return recoverableCodes.includes(code)
}

/**
 * Format a generic error for MCP response
 *
 * Use this for non-license errors that still need MCP formatting.
 */
export function formatGenericError(error: Error, code = 'INTERNAL_ERROR'): MCPErrorResponse {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: {
              code,
              message: error.message,
            },
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  }
}

// ============================================================================
// Error Code Mapping
// ============================================================================

/**
 * Get a user-friendly message for an error code
 */
export function getUserFriendlyMessage(code: string): string {
  const ERROR_MESSAGES: Record<string, string> = {
    E001: 'Your license has expired. Please renew to continue using premium features.',
    E002: 'Your license key is invalid. Please verify the key format or contact support.',
    E003: 'No license key found. Set SKILLSMITH_LICENSE_KEY environment variable.',
    E004: 'This feature is not available in your current license tier.',
    E005: 'You have exceeded your license quota. Please upgrade or reduce usage.',
    LICENSE_EXPIRED: 'Your license has expired. Please renew to continue using premium features.',
    LICENSE_INVALID:
      'Your license key is invalid. Please verify the key format or contact support.',
    LICENSE_NOT_FOUND: 'No license key found. Set SKILLSMITH_LICENSE_KEY environment variable.',
    FEATURE_NOT_AVAILABLE: 'This feature is not available in your current license tier.',
    QUOTA_EXCEEDED: 'You have exceeded your license quota. Please upgrade or reduce usage.',
  }
  return ERROR_MESSAGES[code] || 'An error occurred with your license. Please contact support.'
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Check if an object looks like a license error
 */
export function isLicenseErrorLike(error: unknown): error is LicenseErrorLike {
  if (!error || typeof error !== 'object') {
    return false
  }

  const e = error as Record<string, unknown>

  // Must have a message
  if (typeof e.message !== 'string') {
    return false
  }

  // Should have license-specific properties
  const hasLicenseProps =
    'code' in e || 'feature' in e || 'currentTier' in e || 'requiredTier' in e || 'upgradeUrl' in e

  return hasLicenseProps
}

/**
 * Safely convert any error to MCP format
 */
export function safeFormatError(error: unknown): MCPErrorResponse {
  if (isLicenseErrorLike(error)) {
    return formatLicenseError(error)
  }

  if (error instanceof Error) {
    return formatGenericError(error)
  }

  return formatGenericError(new Error(String(error)))
}
