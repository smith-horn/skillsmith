/**
 * @fileoverview Error Formatter Type Definitions
 * @module @skillsmith/mcp-server/middleware/errorFormatter.types
 * @see SMI-1061: MCP Error Formatter for License Errors
 * @see SMI-2741: Split from errorFormatter.ts to meet 500-line standard
 */

// ============================================================================
// Core Error Response Types
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
// Upgrade URL Types
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

/**
 * Default configuration for upgrade URL generation
 */
export const DEFAULT_UPGRADE_URL_CONFIG: UpgradeUrlConfig = {
  baseUrl: 'https://skillsmith.app/upgrade',
  includeFeature: true,
  includeTiers: true,
  includeSource: true,
}

// ============================================================================
// API Authentication Error Types
// ============================================================================

/**
 * Details from a 401 API authentication error
 */
export interface ApiAuthErrorDetails {
  reason?: string
  signupUrl?: string
  docsUrl?: string
  hint?: string
  trialUsed?: number
  trialLimit?: number
}

// ============================================================================
// Error Code Constants
// ============================================================================

/**
 * Map internal license error codes to user-friendly messages
 */
export const ERROR_MESSAGES: Record<string, string> = {
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
