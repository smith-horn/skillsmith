/**
 * SMI-1060: Graceful Degradation Middleware
 *
 * Middleware that wraps tool handlers with graceful degradation,
 * returning helpful messages instead of hard errors when features
 * are unavailable.
 */

import {
  type LicenseMiddleware,
  type LicenseValidationResult,
  createLicenseMiddleware,
  getRequiredFeature,
} from './license.js'
import {
  TOOL_FEATURES,
  FEATURE_DISPLAY_NAMES,
  FEATURE_TIERS,
  type FeatureFlag,
} from './toolFeatureMapping.js'

// ============================================================================
// Constants
// ============================================================================

const BASE_URL = 'https://skillsmith.app'

/**
 * Pricing information for each tier
 */
const TIER_PRICING: Record<'community' | 'team' | 'enterprise', string> = {
  community: '$0/month',
  team: '$25/user/month',
  enterprise: '$55/user/month',
}

/**
 * Feature descriptions for upgrade prompts
 */
const FEATURE_DESCRIPTIONS: Record<FeatureFlag, string> = {
  // Team tier features
  private_skills: 'Create and manage private skills for your organization',
  team_workspaces: 'Collaborate with your team on shared skill collections',
  usage_analytics: 'Track skill usage and adoption across your organization',
  priority_support: 'Get faster response times from our support team',
  // Enterprise tier features
  sso_saml: 'Integrate with your identity provider for secure single sign-on',
  rbac: 'Fine-grained access control with custom roles and permissions',
  audit_logging: 'Comprehensive audit trail for compliance and security',
  siem_export: 'Export audit logs to your SIEM platform for centralized monitoring',
  compliance_reports: 'Generate compliance reports for SOC2, HIPAA, and other standards',
  private_registry: 'Host a private registry of skills for your organization',
  // Additional features
  custom_integrations: 'Build custom integrations with your tools',
  advanced_analytics: 'In-depth usage analytics and reporting',
}

// ============================================================================
// Types
// ============================================================================

/**
 * MCP tool request structure
 */
export interface McpToolRequest {
  name: string
  arguments: Record<string, unknown>
}

/**
 * MCP tool response structure
 */
export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  _meta?: Record<string, unknown>
}

/**
 * Tool handler function type
 */
export type ToolHandler<T = unknown> = (request: McpToolRequest) => Promise<T>

/**
 * Degradation event for logging
 */
export interface DegradationLogEvent {
  timestamp: string
  toolName: string
  feature: FeatureFlag | null
  tier: 'community' | 'team' | 'enterprise'
  action: 'allowed' | 'degraded' | 'error'
  message?: string
}

/**
 * Degradation logger interface
 */
export interface DegradationLogger {
  log(event: DegradationLogEvent): void
}

/**
 * Degradation middleware options
 */
export interface DegradationMiddlewareOptions {
  /** License middleware instance */
  licenseMiddleware?: LicenseMiddleware
  /** Logger for degradation events */
  logger?: DegradationLogger
  /** Enable verbose logging */
  verbose?: boolean
  /** Custom upgrade URL base */
  upgradeUrlBase?: string
}

// ============================================================================
// Default Logger
// ============================================================================

/**
 * Default no-op logger
 */
const noopLogger: DegradationLogger = {
  log: () => {},
}

/**
 * Console logger for degradation events
 */
export const consoleDegradationLogger: DegradationLogger = {
  log: (event: DegradationLogEvent) => {
    const prefix =
      event.action === 'degraded' ? '[UPGRADE REQUIRED]' : `[${event.action.toUpperCase()}]`
    console.log(`${prefix} ${event.toolName}: ${event.message || 'No message'}`)
  },
}

// ============================================================================
// Upgrade Message Generators
// ============================================================================

/**
 * Create an upgrade prompt for a denied feature
 */
function createUpgradePrompt(
  feature: FeatureFlag,
  _currentTier: 'community' | 'team' | 'enterprise'
): string {
  const displayName = FEATURE_DISPLAY_NAMES[feature]
  const requiredTier = FEATURE_TIERS[feature]
  const pricing = TIER_PRICING[requiredTier]

  return `${displayName} requires ${requiredTier.charAt(0).toUpperCase() + requiredTier.slice(1)} tier (${pricing}). Upgrade at ${BASE_URL}/upgrade?tier=${requiredTier}&feature=${feature}`
}

/**
 * Create a detailed upgrade message with feature description
 */
function createDetailedUpgradeMessage(
  feature: FeatureFlag,
  currentTier: 'community' | 'team' | 'enterprise'
): string {
  const displayName = FEATURE_DISPLAY_NAMES[feature]
  const description = FEATURE_DESCRIPTIONS[feature]
  const requiredTier = FEATURE_TIERS[feature]
  const pricing = TIER_PRICING[requiredTier]
  const currentPricing = TIER_PRICING[currentTier]

  return [
    `Feature Unavailable: ${displayName}`,
    '',
    description,
    '',
    `Current tier: ${currentTier.charAt(0).toUpperCase() + currentTier.slice(1)} (${currentPricing})`,
    `Required tier: ${requiredTier.charAt(0).toUpperCase() + requiredTier.slice(1)} (${pricing})`,
    '',
    `Upgrade to unlock: ${BASE_URL}/upgrade?tier=${requiredTier}&feature=${feature}`,
    `Compare plans: ${BASE_URL}/pricing?highlight=${feature}&current=${currentTier}`,
  ].join('\n')
}

/**
 * Get tier comparison message
 */
export function getTierComparisonMessage(): string {
  return [
    'Skillsmith Pricing Tiers',
    '========================',
    '',
    'Community ($0/month)',
    '----------------------------------------',
    '  - Core features: search, install, recommend, validate, compare',
    '',
    'Team ($25/user/month)',
    '----------------------------------------',
    '  - Private Skills',
    '  - Team Workspaces',
    '  - Priority Support',
    '',
    'Enterprise ($55/user/month)',
    '----------------------------------------',
    '  - SSO/SAML Integration',
    '  - Role-Based Access Control',
    '  - Audit Logging',
    '  - Custom Integrations',
    '  - Advanced Analytics',
    '',
    `Learn more: ${BASE_URL}/pricing`,
  ].join('\n')
}

// ============================================================================
// Graceful Degradation Response
// ============================================================================

/**
 * Create a graceful degradation response for an unavailable feature
 */
function createGracefulDegradationResponse(
  toolName: string,
  feature: FeatureFlag,
  currentTier: 'community' | 'team' | 'enterprise',
  _validationResult: LicenseValidationResult
): McpToolResponse {
  const requiredTier = FEATURE_TIERS[feature]
  const displayName = FEATURE_DISPLAY_NAMES[feature]

  const response = {
    status: 'upgrade_required',
    feature: {
      id: feature,
      name: displayName,
      description: FEATURE_DESCRIPTIONS[feature],
    },
    tiers: {
      current: {
        id: currentTier,
        pricing: TIER_PRICING[currentTier],
      },
      required: {
        id: requiredTier,
        pricing: TIER_PRICING[requiredTier],
      },
    },
    upgrade: {
      message: createUpgradePrompt(feature, currentTier),
      detailedMessage: createDetailedUpgradeMessage(feature, currentTier),
      url: `${BASE_URL}/upgrade?tier=${requiredTier}&feature=${feature}&tool=${toolName}`,
      pricingUrl: `${BASE_URL}/pricing?highlight=${feature}&current=${currentTier}`,
    },
    alternatives: getCommunityAlternatives(toolName),
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response, null, 2),
      },
    ],
    isError: false,
    _meta: {
      upgradeRequired: true,
      feature,
      requiredTier,
      upgradeUrl: response.upgrade.url,
    },
  }
}

/**
 * Get community-tier alternatives for a premium tool
 */
function getCommunityAlternatives(toolName: string): string[] {
  // Map of premium tools to their community alternatives
  const alternatives: Record<string, string[]> = {
    publish_private: ['search', 'get_skill', 'install_skill'],
    team_workspace: ['search', 'install_skill'],
    share_skill: ['search', 'skill_compare'],
    configure_sso: ['search'],
    audit_export: ['search'],
    audit_query: ['search'],
    rbac_manage: ['search'],
    rbac_assign_role: ['search'],
    rbac_create_policy: ['search'],
    analytics_dashboard: ['search', 'skill_recommend'],
    usage_report: ['search'],
    webhook_configure: ['search'],
    api_key_manage: ['search'],
  }

  return alternatives[toolName] || ['search', 'get_skill', 'install_skill']
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Create the degradation middleware
 *
 * This middleware wraps tool handlers to provide graceful degradation
 * when features are unavailable due to license restrictions.
 *
 * @param options - Middleware configuration options
 * @returns Middleware wrapper function
 *
 * @example
 * ```typescript
 * const middleware = createDegradationMiddleware({
 *   logger: consoleDegradationLogger,
 *   verbose: true,
 * });
 *
 * const wrappedHandler = middleware.wrapHandler('audit_query', originalHandler);
 * ```
 */
export function createDegradationMiddleware(options: DegradationMiddlewareOptions = {}) {
  const licenseMiddleware = options.licenseMiddleware ?? createLicenseMiddleware()
  const logger = options.logger ?? noopLogger

  /**
   * Wrap a tool handler with graceful degradation
   */
  async function wrapHandler<T>(
    toolName: string,
    handler: ToolHandler<T>,
    request: McpToolRequest
  ): Promise<T | McpToolResponse> {
    // Check if tool requires a license
    const requiredFeature = getRequiredFeature(toolName)

    // Community tools always pass through
    if (requiredFeature === null) {
      logger.log({
        timestamp: new Date().toISOString(),
        toolName,
        feature: null,
        tier: 'community',
        action: 'allowed',
        message: 'Community tool - no license required',
      })
      return handler(request)
    }

    // Check license for the required feature
    const validationResult = await licenseMiddleware.checkFeature(requiredFeature)

    if (validationResult.valid) {
      const licenseInfo = await licenseMiddleware.getLicenseInfo()
      logger.log({
        timestamp: new Date().toISOString(),
        toolName,
        feature: requiredFeature,
        tier: licenseInfo?.tier ?? 'community',
        action: 'allowed',
        message: 'Feature available in license',
      })
      return handler(request)
    }

    // Feature not available - return graceful degradation response
    const licenseInfo = await licenseMiddleware.getLicenseInfo()
    const currentTier = licenseInfo?.tier ?? 'community'

    logger.log({
      timestamp: new Date().toISOString(),
      toolName,
      feature: requiredFeature,
      tier: currentTier,
      action: 'degraded',
      message: `Feature ${requiredFeature} requires upgrade`,
    })

    return createGracefulDegradationResponse(
      toolName,
      requiredFeature,
      currentTier,
      validationResult
    )
  }

  /**
   * Create a wrapped handler function
   */
  function createWrappedHandler<T>(
    toolName: string,
    handler: ToolHandler<T>
  ): (request: McpToolRequest) => Promise<T | McpToolResponse> {
    return async (request: McpToolRequest) => {
      return wrapHandler(toolName, handler, request)
    }
  }

  /**
   * Check if a tool would be degraded for the current license
   */
  async function wouldDegrade(toolName: string): Promise<boolean> {
    const requiredFeature = getRequiredFeature(toolName)
    if (requiredFeature === null) {
      return false
    }
    const validationResult = await licenseMiddleware.checkFeature(requiredFeature)
    return !validationResult.valid
  }

  /**
   * Get degradation status for all tools
   */
  async function getDegradationStatus(): Promise<Map<string, boolean>> {
    const status = new Map<string, boolean>()

    for (const toolName of Object.keys(TOOL_FEATURES)) {
      status.set(toolName, await wouldDegrade(toolName))
    }

    return status
  }

  /**
   * Get upgrade prompt for a tool
   */
  async function getUpgradePrompt(toolName: string): Promise<string | null> {
    const requiredFeature = getRequiredFeature(toolName)
    if (requiredFeature === null) {
      return null
    }

    const licenseInfo = await licenseMiddleware.getLicenseInfo()
    const currentTier = licenseInfo?.tier ?? 'community'

    return createUpgradePrompt(requiredFeature, currentTier)
  }

  return {
    wrapHandler,
    createWrappedHandler,
    wouldDegrade,
    getDegradationStatus,
    getUpgradePrompt,
    getTierComparisonMessage,
    licenseMiddleware,
  }
}

// ============================================================================
// Type Exports
// ============================================================================

export type DegradationMiddleware = ReturnType<typeof createDegradationMiddleware>
