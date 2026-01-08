/**
 * SMI-1061: MCP Error Formatter for License Errors
 *
 * Formats license errors into MCP protocol-compliant error responses
 * with actionable information for clients.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * MCP-formatted error response content
 */
export interface MCPErrorContent {
  type: 'text'
  text: string
}

/**
 * MCP-formatted error response
 */
export interface MCPErrorResponse {
  content: MCPErrorContent[]
  isError: true
  _meta?: {
    upgradeUrl?: string
    errorCode?: string
    recoverable?: boolean
  }
}

/**
 * License error details structure (mirrors the enterprise package)
 */
export interface LicenseErrorDetails {
  code: string
  message: string
  feature?: string
  currentTier?: string
  requiredTier?: string
  upgradeUrl?: string
  context?: Record<string, unknown>
  timestamp?: string
}

/**
 * Interface for license errors (duck-typed for optional enterprise package)
 */
export interface LicenseErrorLike {
  code?: string
  message: string
  feature?: string
  currentTier?: string
  requiredTier?: string
  upgradeUrl?: string
  context?: Record<string, unknown>
  timestamp?: Date
  toJSON?: () => Record<string, unknown>
}

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
 * Map internal license error codes to user-friendly messages
 */
const ERROR_MESSAGES: Record<string, string> = {
  E001: 'Your license has expired. Please renew to continue using premium features.',
  E002: 'Your license key is invalid. Please verify the key format or contact support.',
  E003: 'No license key found. Set SKILLSMITH_LICENSE_KEY environment variable.',
  E004: 'This feature is not available in your current license tier.',
  E005: 'You have exceeded your license quota. Please upgrade or reduce usage.',
  LICENSE_EXPIRED: 'Your license has expired. Please renew to continue using premium features.',
  LICENSE_INVALID: 'Your license key is invalid. Please verify the key format or contact support.',
  LICENSE_NOT_FOUND: 'No license key found. Set SKILLSMITH_LICENSE_KEY environment variable.',
  FEATURE_NOT_AVAILABLE: 'This feature is not available in your current license tier.',
  QUOTA_EXCEEDED: 'You have exceeded your license quota. Please upgrade or reduce usage.',
}

/**
 * Get a user-friendly message for an error code
 */
export function getUserFriendlyMessage(code: string): string {
  return ERROR_MESSAGES[code] || 'An error occurred with your license. Please contact support.'
}

// ============================================================================
// Upgrade URL Generation
// ============================================================================

/**
 * Configuration for upgrade URLs
 */
export interface UpgradeUrlConfig {
  baseUrl?: string
  includeFeature?: boolean
  includeTiers?: boolean
  includeSource?: boolean
}

const DEFAULT_UPGRADE_URL_CONFIG: UpgradeUrlConfig = {
  baseUrl: 'https://skillsmith.app/upgrade',
  includeFeature: true,
  includeTiers: true,
  includeSource: true,
}

/**
 * Generate a customized upgrade URL with tracking parameters
 */
export function generateUpgradeUrl(
  error: LicenseErrorLike,
  config: Partial<UpgradeUrlConfig> = {}
): string {
  const fullConfig = { ...DEFAULT_UPGRADE_URL_CONFIG, ...config }
  const params = new URLSearchParams()

  if (fullConfig.includeFeature && error.feature) {
    params.set('feature', error.feature)
  }

  if (fullConfig.includeTiers) {
    if (error.currentTier) {
      params.set('from', error.currentTier)
    }
    if (error.requiredTier) {
      params.set('to', error.requiredTier)
    }
  }

  if (fullConfig.includeSource) {
    params.set('source', 'mcp-error')
    if (error.code) {
      params.set('error_code', error.code)
    }
  }

  const queryString = params.toString()
  return queryString ? `${fullConfig.baseUrl}?${queryString}` : fullConfig.baseUrl || ''
}

// ============================================================================
// Response Builders
// ============================================================================

/**
 * Build an upgrade required response
 *
 * Use this when a feature requires an upgrade but isn't a full error.
 */
export function buildUpgradeRequiredResponse(
  feature: string,
  currentTier: string,
  requiredTier: string
): MCPErrorResponse {
  const upgradeUrl = `https://skillsmith.app/upgrade?feature=${feature}&from=${currentTier}&to=${requiredTier}`

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: {
              code: 'E004',
              message: `${feature} requires ${requiredTier} tier`,
              details: {
                feature,
                currentTier,
                requiredTier,
                upgradeUrl,
              },
            },
          },
          null,
          2
        ),
      },
    ],
    isError: true,
    _meta: {
      upgradeUrl,
      errorCode: 'E004',
      recoverable: false,
    },
  }
}

/**
 * Build a license expired response with renewal URL
 */
export function buildLicenseExpiredResponse(expiredAt?: Date): MCPErrorResponse {
  const renewUrl = 'https://skillsmith.app/renew'

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: {
              code: 'E001',
              message: 'Your license has expired',
              details: {
                expiredAt: expiredAt?.toISOString(),
                renewUrl,
              },
            },
          },
          null,
          2
        ),
      },
    ],
    isError: true,
    _meta: {
      upgradeUrl: renewUrl,
      errorCode: 'E001',
      recoverable: false,
    },
  }
}

/**
 * Build a quota exceeded response
 */
export function buildQuotaExceededResponse(
  quotaType: string,
  current: number,
  max: number
): MCPErrorResponse {
  const upgradeUrl = `https://skillsmith.app/upgrade?quota=${quotaType}`

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: {
              code: 'E005',
              message: `${quotaType} quota exceeded`,
              details: {
                quotaType,
                current,
                max,
                upgradeUrl,
              },
            },
          },
          null,
          2
        ),
      },
    ],
    isError: true,
    _meta: {
      upgradeUrl,
      errorCode: 'E005',
      recoverable: false,
    },
  }
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
