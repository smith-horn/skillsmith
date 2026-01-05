/**
 * License validation middleware for MCP server
 *
 * Validates that the user has the required license features for enterprise tools.
 * Gracefully degrades if @skillsmith/enterprise is not installed.
 *
 * @see SMI-1055: Add license middleware to MCP server
 */

import {
  TOOL_FEATURES,
  FEATURE_DISPLAY_NAMES,
  FEATURE_TIERS,
  type FeatureFlag,
} from './toolFeatureMapping.js'

/**
 * Configuration for the upgrade URL
 */
const UPGRADE_URL = 'https://skillsmith.io/pricing'

/**
 * License validation result
 */
export interface LicenseValidationResult {
  valid: boolean
  feature?: FeatureFlag
  message?: string
  upgradeUrl?: string
  warning?: string
}

/**
 * License information interface (mirrors @skillsmith/enterprise LicenseInfo)
 */
export interface LicenseInfo {
  valid: boolean
  tier: 'community' | 'team' | 'enterprise'
  features: FeatureFlag[]
  expiresAt?: Date
  organizationId?: string
}

/**
 * License from enterprise package validation
 */
interface EnterpriseLicense {
  tier: 'community' | 'team' | 'enterprise'
  features: FeatureFlag[]
  customerId: string
  issuedAt: Date
  expiresAt: Date
}

/**
 * Validation result from enterprise package
 */
interface EnterpriseValidationResult {
  valid: boolean
  license?: EnterpriseLicense
  error?: {
    code: string
    message: string
  }
}

/**
 * License validator instance type from enterprise package
 * Uses duck typing to avoid interface drift with the actual implementation
 */
type EnterpriseValidator = {
  validate(licenseKey: string): Promise<EnterpriseValidationResult>
}

/**
 * Type guard to validate enterprise module structure
 */
function isEnterpriseModule(
  mod: unknown
): mod is { LicenseValidator: new () => EnterpriseValidator } {
  return (
    typeof mod === 'object' &&
    mod !== null &&
    'LicenseValidator' in mod &&
    typeof (mod as Record<string, unknown>)['LicenseValidator'] === 'function'
  )
}

/**
 * Attempt to load the enterprise license validator
 * Returns null if the package is not installed
 */
async function tryLoadEnterpriseValidator(): Promise<EnterpriseValidator | null> {
  try {
    // Dynamic import with variable to prevent TypeScript from resolving at compile time
    // This is an optional peer dependency that may not be installed
    const packageName = '@skillsmith/enterprise'
    const enterprise = await import(/* webpackIgnore: true */ packageName)
    if (isEnterpriseModule(enterprise)) {
      return new enterprise.LicenseValidator()
    }
    return null
  } catch {
    // Enterprise package not installed - this is expected for community users
    return null
  }
}

/**
 * Check if a tool name corresponds to an enterprise feature
 *
 * @param toolName - The name of the MCP tool
 * @returns true if the tool requires an enterprise license
 */
export function isEnterpriseFeature(toolName: string): boolean {
  const feature = TOOL_FEATURES[toolName]
  if (feature == null) {
    return false
  }
  return FEATURE_TIERS[feature] === 'enterprise'
}

/**
 * Check if a tool name requires any license (team or enterprise)
 *
 * @param toolName - The name of the MCP tool
 * @returns true if the tool requires any license
 */
export function requiresLicense(toolName: string): boolean {
  return TOOL_FEATURES[toolName] !== null && TOOL_FEATURES[toolName] !== undefined
}

/**
 * Get the required feature for a tool
 *
 * @param toolName - The name of the MCP tool
 * @returns The feature flag required, or null if community tool
 */
export function getRequiredFeature(toolName: string): FeatureFlag | null {
  return TOOL_FEATURES[toolName] ?? null
}

/**
 * Check if license is expiring soon (within 30 days)
 */
function getExpirationWarning(expiresAt?: Date): string | undefined {
  if (!expiresAt) return undefined
  const daysUntilExpiry = Math.floor((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
    return `Your license expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}. Please renew to avoid service interruption.`
  }
  return undefined
}

/**
 * License middleware context
 */
export interface LicenseMiddlewareContext {
  validator: EnterpriseValidator | null
  licenseKey: string | undefined
  cachedLicense: LicenseInfo | null
  cacheExpiry: number
}

/**
 * License middleware instance
 */
export interface LicenseMiddleware {
  /**
   * Check if a specific feature is available
   */
  checkFeature(feature: FeatureFlag): Promise<LicenseValidationResult>

  /**
   * Check if a tool can be executed
   */
  checkTool(toolName: string): Promise<LicenseValidationResult>

  /**
   * Get the current license info
   */
  getLicenseInfo(): Promise<LicenseInfo | null>

  /**
   * Invalidate the cached license
   */
  invalidateCache(): void
}

/**
 * Create a license middleware factory
 *
 * This middleware reads the license key from environment variables and
 * validates tool access based on the license features.
 *
 * @param options - Optional configuration
 * @returns License middleware instance
 */
export function createLicenseMiddleware(options?: {
  licenseKeyEnvVar?: string
  cacheTtlMs?: number
}): LicenseMiddleware {
  const envVar = options?.licenseKeyEnvVar ?? 'SKILLSMITH_LICENSE_KEY'
  const cacheTtl = options?.cacheTtlMs ?? 5 * 60 * 1000 // 5 minutes default

  const context: LicenseMiddlewareContext = {
    validator: null,
    licenseKey: process.env[envVar],
    cachedLicense: null,
    cacheExpiry: 0,
  }

  // Initialize validator lazily
  let validatorPromise: Promise<EnterpriseValidator | null> | null = null

  async function getValidator(): Promise<EnterpriseValidator | null> {
    if (!validatorPromise) {
      validatorPromise = tryLoadEnterpriseValidator()
    }
    if (context.validator === null) {
      context.validator = await validatorPromise
    }
    return context.validator
  }

  async function getLicenseInfo(): Promise<LicenseInfo | null> {
    // Check cache first
    if (context.cachedLicense && Date.now() < context.cacheExpiry) {
      return context.cachedLicense
    }

    // No license key = community user
    if (!context.licenseKey) {
      const communityLicense: LicenseInfo = {
        valid: true,
        tier: 'community',
        features: [],
      }
      context.cachedLicense = communityLicense
      context.cacheExpiry = Date.now() + cacheTtl
      return communityLicense
    }

    // Try to validate with enterprise package
    const validator = await getValidator()
    if (!validator) {
      // Enterprise package not installed but license key provided
      // Security-conscious decision: Return null to indicate validation failure
      // rather than silently degrading to community tier. This ensures paying
      // customers get feedback that their license couldn't be validated.
      // See SMI-1130 for rationale.
      return null
    }

    try {
      const result = await validator.validate(context.licenseKey)

      // Check if validation was successful
      if (!result.valid || !result.license) {
        // Invalid license - return null to indicate validation failure
        return null
      }

      // Convert enterprise License to middleware LicenseInfo
      const license: LicenseInfo = {
        valid: true,
        tier: result.license.tier,
        features: result.license.features,
        expiresAt: result.license.expiresAt,
        organizationId: result.license.customerId,
      }

      context.cachedLicense = license
      context.cacheExpiry = Date.now() + cacheTtl
      return license
    } catch {
      // Validation threw an exception - treat as invalid license
      return null
    }
  }

  async function checkFeature(feature: FeatureFlag): Promise<LicenseValidationResult> {
    const license = await getLicenseInfo()

    // No valid license
    if (!license || !license.valid) {
      const tier = FEATURE_TIERS[feature]
      const displayName = FEATURE_DISPLAY_NAMES[feature]
      return {
        valid: false,
        feature,
        message: `The "${displayName}" feature requires a ${tier} license. Your license could not be validated.`,
        upgradeUrl: `${UPGRADE_URL}?feature=${feature}`,
      }
    }

    // Community tier - no paid features
    if (license.tier === 'community') {
      const tier = FEATURE_TIERS[feature]
      const displayName = FEATURE_DISPLAY_NAMES[feature]
      return {
        valid: false,
        feature,
        message: `The "${displayName}" feature requires a ${tier} license. You are currently on the community tier.`,
        upgradeUrl: `${UPGRADE_URL}?feature=${feature}&current=community`,
      }
    }

    // Team tier - only team features
    if (license.tier === 'team' && FEATURE_TIERS[feature] === 'enterprise') {
      const displayName = FEATURE_DISPLAY_NAMES[feature]
      return {
        valid: false,
        feature,
        message: `The "${displayName}" feature requires an enterprise license. You are currently on the team tier.`,
        upgradeUrl: `${UPGRADE_URL}?feature=${feature}&current=team`,
      }
    }

    // Check if feature is in the license
    if (!license.features.includes(feature)) {
      const displayName = FEATURE_DISPLAY_NAMES[feature]
      const tier = FEATURE_TIERS[feature]
      return {
        valid: false,
        feature,
        message: `The "${displayName}" feature is not included in your license. Please upgrade to access this ${tier} feature.`,
        upgradeUrl: `${UPGRADE_URL}?feature=${feature}&upgrade=true`,
      }
    }

    const warning = getExpirationWarning(license.expiresAt)
    return { valid: true, warning }
  }

  async function checkTool(toolName: string): Promise<LicenseValidationResult> {
    const requiredFeature = getRequiredFeature(toolName)

    // Community tool - no license required
    if (requiredFeature === null) {
      return { valid: true }
    }

    return checkFeature(requiredFeature)
  }

  function invalidateCache(): void {
    context.cachedLicense = null
    context.cacheExpiry = 0
  }

  return {
    checkFeature,
    checkTool,
    getLicenseInfo,
    invalidateCache,
  }
}

/**
 * Higher-order function to create feature requirement middleware
 *
 * Use this to wrap tool handlers that require specific features.
 *
 * @param feature - The feature flag required
 * @returns Middleware function that checks the feature
 *
 * @example
 * ```typescript
 * const middleware = createLicenseMiddleware();
 * const requireAudit = requireFeature('audit_logging');
 *
 * // In tool handler:
 * const validation = await requireAudit(middleware);
 * if (!validation.valid) {
 *   return { error: validation.message, upgradeUrl: validation.upgradeUrl };
 * }
 * ```
 */
export function requireFeature(
  feature: FeatureFlag
): (middleware: LicenseMiddleware) => Promise<LicenseValidationResult> {
  return async (middleware: LicenseMiddleware) => {
    return middleware.checkFeature(feature)
  }
}

/**
 * Create an error response for license validation failures
 *
 * @param result - The license validation result
 * @returns MCP-formatted error response
 */
export function createLicenseErrorResponse(result: LicenseValidationResult): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
  _meta?: { upgradeUrl: string }
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: 'license_required',
            message: result.message,
            feature: result.feature,
            upgradeUrl: result.upgradeUrl,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
    _meta: result.upgradeUrl ? { upgradeUrl: result.upgradeUrl } : undefined,
  }
}

// Re-export types from toolFeatureMapping
export type { FeatureFlag } from './toolFeatureMapping.js'
export { TOOL_FEATURES, FEATURE_DISPLAY_NAMES, FEATURE_TIERS } from './toolFeatureMapping.js'
