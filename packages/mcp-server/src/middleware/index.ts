/**
 * MCP Server Middleware
 *
 * Exports all middleware for the Skillsmith MCP server.
 */

// CSP middleware
export {
  cspMiddleware,
  buildCspHeader,
  generateNonce,
  validateCspHeader,
  validateCspHeaderDetailed,
  getCspForEnvironment,
  DEFAULT_CSP_DIRECTIVES,
  STRICT_CSP_DIRECTIVES,
  type CspDirectives,
  type CspValidationResult,
} from './csp.js'

// License middleware
export {
  createLicenseMiddleware,
  requireFeature,
  isEnterpriseFeature,
  requiresLicense,
  getRequiredFeature,
  createLicenseErrorResponse,
  type LicenseMiddleware,
  type LicenseMiddlewareContext,
  type LicenseValidationResult,
  type LicenseInfo,
  type FeatureFlag,
  TOOL_FEATURES,
  FEATURE_DISPLAY_NAMES,
  FEATURE_TIERS,
} from './license.js'

// Degradation middleware (SMI-1060)
export {
  createDegradationMiddleware,
  getTierComparisonMessage,
  consoleDegradationLogger,
  type DegradationMiddleware,
  type DegradationMiddlewareOptions,
  type DegradationLogger,
  type DegradationLogEvent,
  type McpToolRequest,
  type McpToolResponse,
  type ToolHandler,
} from './degradation.js'

// MCP Error Formatter (SMI-1061)
export {
  formatLicenseError,
  formatGenericError,
  getUserFriendlyMessage,
  generateUpgradeUrl,
  buildUpgradeRequiredResponse,
  buildLicenseExpiredResponse,
  buildQuotaExceededResponse,
  isLicenseErrorLike,
  safeFormatError,
  type MCPErrorContent,
  type MCPErrorResponse,
  type LicenseErrorDetails as MCPLicenseErrorDetails,
  type LicenseErrorLike,
  type UpgradeUrlConfig,
} from './errorFormatter.js'
