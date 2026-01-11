/**
 * SMI-1053: License Validation Types
 *
 * TypeScript types for JWT-based license validation including:
 * - Feature flags by tier (Team, Enterprise)
 * - License payload structure
 * - Validation results
 */

// ============================================================================
// Feature Flags
// ============================================================================

/**
 * Individual tier feature flags
 */
export type IndividualFeatureFlag = 'basic_analytics' | 'email_support'

/**
 * Team tier feature flags
 */
export type TeamFeatureFlag =
  | 'team_workspaces'
  | 'private_skills'
  | 'usage_analytics'
  | 'priority_support'

/**
 * Enterprise tier feature flags (includes all Team features)
 */
export type EnterpriseFeatureFlag =
  | 'sso_saml'
  | 'rbac'
  | 'audit_logging'
  | 'siem_export'
  | 'compliance_reports'
  | 'private_registry'
  | 'custom_integrations'
  | 'advanced_analytics'

/**
 * All available feature flags
 */
export type FeatureFlag = IndividualFeatureFlag | TeamFeatureFlag | EnterpriseFeatureFlag

/**
 * Feature flags grouped by tier
 */
export const INDIVIDUAL_FEATURES: readonly IndividualFeatureFlag[] = [
  'basic_analytics',
  'email_support',
] as const

export const TEAM_FEATURES: readonly TeamFeatureFlag[] = [
  'team_workspaces',
  'private_skills',
  'usage_analytics',
  'priority_support',
] as const

export const ENTERPRISE_FEATURES: readonly EnterpriseFeatureFlag[] = [
  'sso_saml',
  'rbac',
  'audit_logging',
  'siem_export',
  'compliance_reports',
  'private_registry',
  'custom_integrations',
  'advanced_analytics',
] as const

// ============================================================================
// License Tiers
// ============================================================================

/**
 * Available license tiers
 * - community: Free tier (1,000 API calls/month)
 * - individual: Solo developers ($9.99/mo, 10,000 API calls/month)
 * - team: Teams ($25/user/mo, 100,000 API calls/month)
 * - enterprise: Full enterprise ($55/user/mo, unlimited)
 */
export type LicenseTier = 'community' | 'individual' | 'team' | 'enterprise'

/**
 * Default features for each tier
 */
export const TIER_FEATURES: Record<LicenseTier, readonly FeatureFlag[]> = {
  community: [],
  individual: INDIVIDUAL_FEATURES,
  team: [...INDIVIDUAL_FEATURES, ...TEAM_FEATURES],
  enterprise: [...INDIVIDUAL_FEATURES, ...TEAM_FEATURES, ...ENTERPRISE_FEATURES],
} as const

// ============================================================================
// JWT Payload
// ============================================================================

/**
 * Quota limits for license tiers
 */
export interface LicenseQuotas {
  /** API calls allowed per month (-1 for unlimited) */
  apiCallsPerMonth: number
}

/**
 * JWT license payload structure
 */
export interface LicensePayload {
  /** License tier */
  tier: LicenseTier
  /** Features included in the license */
  features: FeatureFlag[]
  /** Customer identifier */
  customerId: string
  /** Unix timestamp when the license was issued */
  issuedAt: number
  /** Unix timestamp when the license expires */
  expiresAt: number
  /** Optional quota limits (defaults to tier limits if not specified) */
  quotas?: LicenseQuotas
}

// ============================================================================
// License Object
// ============================================================================

/**
 * Validated license object with parsed JWT claims
 */
export interface License {
  /** License tier */
  tier: LicenseTier
  /** Features included in the license */
  features: FeatureFlag[]
  /** Customer identifier */
  customerId: string
  /** Date when the license was issued */
  issuedAt: Date
  /** Date when the license expires */
  expiresAt: Date
  /** Raw JWT token */
  rawToken: string
}

// ============================================================================
// Validation Results
// ============================================================================

/**
 * License validation error codes
 */
export type LicenseValidationErrorCode =
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_NOT_YET_VALID'
  | 'INVALID_SIGNATURE'
  | 'MISSING_CLAIMS'
  | 'INVALID_TIER'
  | 'INVALID_FEATURES'
  | 'UNKNOWN_ERROR'

/**
 * License validation error
 */
export interface LicenseValidationError {
  /** Error code for programmatic handling */
  code: LicenseValidationErrorCode
  /** Human-readable error message */
  message: string
  /** Additional error details */
  details?: Record<string, unknown>
}

/**
 * License validation result
 */
export interface LicenseValidationResult {
  /** Whether the license is valid */
  valid: boolean
  /** Validated license (only present if valid) */
  license?: License
  /** Validation error (only present if invalid) */
  error?: LicenseValidationError
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * License validator configuration options
 */
export interface LicenseValidatorOptions {
  /**
   * Public key for JWT verification (PEM format or JWK)
   * If not provided, the validator will use the SKILLSMITH_LICENSE_PUBLIC_KEY env var
   */
  publicKey?: string

  /**
   * Expected JWT issuer claim
   * @default 'skillsmith'
   */
  issuer?: string

  /**
   * Expected JWT audience claim
   * @default 'skillsmith-enterprise'
   */
  audience?: string

  /**
   * Clock tolerance in seconds for expiration checks
   * @default 60
   */
  clockTolerance?: number

  /**
   * Time-to-live for the cached public key in milliseconds.
   * When the TTL expires, the key will be re-imported on the next validation.
   * Use this for key rotation scenarios where the public key may change.
   * @default 0 (no expiration, key is cached indefinitely)
   */
  keyTtlMs?: number
}

// ============================================================================
// Environment Variable
// ============================================================================

/**
 * Environment variable name for the license key
 */
export const LICENSE_KEY_ENV_VAR = 'SKILLSMITH_LICENSE_KEY'

/**
 * Environment variable name for the public key used to verify license signatures
 */
export const LICENSE_PUBLIC_KEY_ENV_VAR = 'SKILLSMITH_LICENSE_PUBLIC_KEY'
