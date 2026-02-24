/**
 * @fileoverview Error Response Builder Functions
 * @module @skillsmith/mcp-server/middleware/errorFormatter.builders
 * @see SMI-1061: MCP Error Formatter for License Errors
 * @see SMI-2741: Split from errorFormatter.ts to meet 500-line standard
 *
 * Pre-built MCP error response factories for common license error scenarios:
 * - Upgrade required (feature tier mismatch)
 * - License expired (renewal needed)
 * - Quota exceeded (usage limit hit)
 * - API authentication errors (401 handling)
 */

import type {
  MCPErrorResponse,
  LicenseErrorLike,
  ApiAuthErrorDetails,
} from './errorFormatter.types.js'
import { DEFAULT_UPGRADE_URL_CONFIG } from './errorFormatter.types.js'
import type { UpgradeUrlConfig } from './errorFormatter.types.js'

// ============================================================================
// Upgrade URL Generation
// ============================================================================

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
// API Authentication Error Formatting (SMI-XXXX)
// ============================================================================

/**
 * Format a 401 authentication error for MCP display
 * Provides user-friendly instructions for getting an API key
 *
 * @param details - Error details from the API response
 * @returns MCP-formatted error response with signup instructions
 */
export function formatAuthenticationError(details: ApiAuthErrorDetails = {}): MCPErrorResponse {
  const signupUrl = details.signupUrl || 'https://skillsmith.app/signup'
  const docsUrl = details.docsUrl || 'https://skillsmith.app/docs/getting-started#api-key'
  const trialInfo =
    details.trialUsed !== undefined && details.trialLimit !== undefined
      ? `\n\n📊 **Trial Usage**: ${details.trialUsed}/${details.trialLimit} free requests used`
      : ''

  const message = `🔐 **Authentication Required**

${details.reason || 'API key required for this request.'}

**Get Started (Free - 1,000 requests/month):**
1. Create account: ${signupUrl}
2. Your API key will be generated automatically
3. Add to your Claude settings:

\`\`\`json
{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_API_KEY": "your_key_here"
      }
    }
  }
}
\`\`\`${trialInfo}

[Documentation](${docsUrl})
`

  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
    _meta: {
      errorCode: 'AUTHENTICATION_REQUIRED',
      recoverable: true,
      upgradeUrl: signupUrl,
    },
  }
}

/**
 * Check if an API error is an authentication error (401)
 */
export function isAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const e = error as Record<string, unknown>

  // Check for status code
  if (e.statusCode === 401 || e.status === 401) {
    return true
  }

  // Check for error message patterns
  if (typeof e.message === 'string') {
    const msg = e.message.toLowerCase()
    if (msg.includes('authentication required') || msg.includes('free trial exhausted')) {
      return true
    }
  }

  // Check for error field
  if (typeof e.error === 'string') {
    const err = e.error.toLowerCase()
    if (err.includes('authentication required')) {
      return true
    }
  }

  return false
}

/**
 * Extract authentication error details from an API error response
 */
export function extractAuthErrorDetails(error: unknown): ApiAuthErrorDetails {
  if (!error || typeof error !== 'object') {
    return {}
  }

  const e = error as Record<string, unknown>

  // Check for details object
  if (e.details && typeof e.details === 'object') {
    return e.details as ApiAuthErrorDetails
  }

  return {}
}
