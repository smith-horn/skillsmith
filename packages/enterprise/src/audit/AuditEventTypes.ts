/**
 * SMI-964: SSO/RBAC Event Types
 *
 * TypeScript interfaces and Zod schemas for enterprise audit events:
 * - SSO Events: Login attempts, successes, failures, logout, session refresh, provider errors
 * - RBAC Events: Permission checks, denials, role assignments, revocations, policy updates
 * - License Events: Validation, expiration, feature checks, seat limits
 *
 * All events extend a base AuditEvent interface and include comprehensive
 * Zod validation schemas for runtime type checking.
 */

import { z } from 'zod'

// ============================================================================
// Base Types
// ============================================================================

/**
 * SSO identity providers
 */
export type SSOProvider = 'okta' | 'azure_ad' | 'google' | 'saml' | 'oidc'

/**
 * SSO event types
 */
export type SSOEventType =
  | 'sso_login_attempt'
  | 'sso_login_success'
  | 'sso_login_failure'
  | 'sso_logout'
  | 'sso_session_refresh'
  | 'sso_provider_error'

/**
 * RBAC event types
 */
export type RBACEventType =
  | 'rbac_permission_check'
  | 'rbac_permission_denied'
  | 'rbac_role_assigned'
  | 'rbac_role_revoked'
  | 'rbac_policy_updated'

/**
 * License event types
 */
export type LicenseEventType =
  | 'license_validated'
  | 'license_expired'
  | 'license_feature_check'
  | 'license_seats_exceeded'

/**
 * All audit event types
 */
export type AuditEventType = SSOEventType | RBACEventType | LicenseEventType

/**
 * Severity levels for audit events
 */
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical'

// ============================================================================
// Base Audit Event
// ============================================================================

/**
 * Base SSO/RBAC/License audit event interface - all events extend this
 * Note: Named differently from AuditEvent in AuditLogger.ts to avoid conflicts
 */
export interface BaseAuditEvent {
  /** Unique event identifier */
  id: string
  /** ISO 8601 timestamp */
  timestamp: string
  /** Event type identifier */
  event_type: AuditEventType
  /** Actor who triggered the event (user ID or system identifier) */
  actor: string
  /** IP address of the request origin */
  ip_address: string
  /** User agent string from the request */
  user_agent: string
  /** Optional additional metadata */
  metadata?: Record<string, unknown>
}

// ============================================================================
// SSO Events
// ============================================================================

/**
 * SSO login failure reason
 */
export type SSOFailureReason =
  | 'invalid_credentials'
  | 'account_disabled'
  | 'account_locked'
  | 'mfa_required'
  | 'mfa_failed'
  | 'session_expired'
  | 'token_invalid'
  | 'token_expired'
  | 'provider_unavailable'
  | 'unknown'

/**
 * Base SSO audit event
 */
export interface SSOAuditEvent extends BaseAuditEvent {
  event_type: SSOEventType
  /** SSO provider used */
  provider: SSOProvider
  /** Session ID (if available) */
  session_id?: string
  /** Email address associated with the SSO attempt */
  email?: string
}

/**
 * SSO login attempt event
 */
export interface SSOLoginAttemptEvent extends SSOAuditEvent {
  event_type: 'sso_login_attempt'
  /** Email being used for login attempt */
  email: string
}

/**
 * SSO login success event
 */
export interface SSOLoginSuccessEvent extends SSOAuditEvent {
  event_type: 'sso_login_success'
  /** Session ID created */
  session_id: string
  /** Email of the authenticated user */
  email: string
  /** Session expiration timestamp */
  session_expires_at: string
  /** MFA was used */
  mfa_used?: boolean
}

/**
 * SSO login failure event
 */
export interface SSOLoginFailureEvent extends SSOAuditEvent {
  event_type: 'sso_login_failure'
  /** Reason for failure */
  failure_reason: SSOFailureReason
  /** Email of the failed attempt */
  email?: string
  /** Number of failed attempts for this user */
  attempt_count?: number
}

/**
 * SSO logout event
 */
export interface SSOLogoutEvent extends SSOAuditEvent {
  event_type: 'sso_logout'
  /** Session ID being terminated */
  session_id: string
  /** Whether logout was initiated by user or system */
  initiated_by: 'user' | 'system' | 'timeout' | 'admin'
}

/**
 * SSO session refresh event
 */
export interface SSOSessionRefreshEvent extends SSOAuditEvent {
  event_type: 'sso_session_refresh'
  /** Session ID being refreshed */
  session_id: string
  /** New expiration timestamp */
  new_expires_at: string
  /** Previous expiration timestamp */
  previous_expires_at?: string
}

/**
 * SSO provider error event
 */
export interface SSOProviderErrorEvent extends SSOAuditEvent {
  event_type: 'sso_provider_error'
  /** Error code from the provider */
  error_code: string
  /** Error message */
  error_message: string
  /** Whether the error is recoverable */
  recoverable: boolean
}

// ============================================================================
// RBAC Events
// ============================================================================

/**
 * Base RBAC audit event
 */
export interface RBACAuditEvent extends BaseAuditEvent {
  event_type: RBACEventType
  /** Resource being accessed */
  resource: string
  /** Action being performed */
  action: string
}

/**
 * RBAC permission check event
 */
export interface RBACPermissionCheckEvent extends RBACAuditEvent {
  event_type: 'rbac_permission_check'
  /** Whether permission was granted */
  granted: boolean
  /** Roles that were checked */
  roles_checked: string[]
  /** Policies that were evaluated */
  policies_evaluated?: string[]
}

/**
 * RBAC permission denied event
 */
export interface RBACPermissionDeniedEvent extends RBACAuditEvent {
  event_type: 'rbac_permission_denied'
  /** Roles the user has */
  user_roles: string[]
  /** Required roles for access */
  required_roles: string[]
  /** Reason for denial */
  denial_reason: string
}

/**
 * RBAC role assigned event
 */
export interface RBACRoleAssignedEvent extends RBACAuditEvent {
  event_type: 'rbac_role_assigned'
  /** User receiving the role */
  target_user: string
  /** Role being assigned */
  role: string
  /** Who assigned the role */
  assigned_by: string
  /** Expiration of the role assignment (if temporary) */
  expires_at?: string
}

/**
 * RBAC role revoked event
 */
export interface RBACRoleRevokedEvent extends RBACAuditEvent {
  event_type: 'rbac_role_revoked'
  /** User losing the role */
  target_user: string
  /** Role being revoked */
  role: string
  /** Who revoked the role */
  revoked_by: string
  /** Reason for revocation */
  revocation_reason?: string
}

/**
 * RBAC policy updated event
 */
export interface RBACPolicyUpdatedEvent extends RBACAuditEvent {
  event_type: 'rbac_policy_updated'
  /** Policy being updated */
  policy_id: string
  /** Policy name */
  policy_name: string
  /** Type of change */
  change_type: 'created' | 'modified' | 'deleted'
  /** Previous policy state (for modifications) */
  previous_state?: Record<string, unknown>
  /** New policy state */
  new_state?: Record<string, unknown>
}

// ============================================================================
// License Events
// ============================================================================

/**
 * Base license audit event
 */
export interface LicenseAuditEvent extends BaseAuditEvent {
  event_type: LicenseEventType
  /** License key identifier (obfuscated) */
  license_id: string
  /** Organization associated with the license */
  organization_id: string
}

/**
 * License validated event
 */
export interface LicenseValidatedEvent extends LicenseAuditEvent {
  event_type: 'license_validated'
  /** License tier */
  tier: 'free' | 'pro' | 'enterprise'
  /** License expiration date */
  expires_at: string
  /** Features included in the license */
  features: string[]
  /** Maximum seats allowed */
  max_seats: number
}

/**
 * License expired event
 */
export interface LicenseExpiredEvent extends LicenseAuditEvent {
  event_type: 'license_expired'
  /** When the license expired */
  expired_at: string
  /** Grace period end (if applicable) */
  grace_period_ends?: string
  /** Features that are now disabled */
  disabled_features: string[]
}

/**
 * License feature check event
 */
export interface LicenseFeatureCheckEvent extends LicenseAuditEvent {
  event_type: 'license_feature_check'
  /** Feature being checked */
  feature: string
  /** Whether the feature is enabled */
  enabled: boolean
  /** Reason if disabled */
  disabled_reason?: string
}

/**
 * License seats exceeded event
 */
export interface LicenseSeatsExceededEvent extends LicenseAuditEvent {
  event_type: 'license_seats_exceeded'
  /** Maximum allowed seats */
  max_seats: number
  /** Current active seats */
  current_seats: number
  /** User attempting to be added (if applicable) */
  attempted_user?: string
  /** Whether access was blocked */
  access_blocked: boolean
}

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * SSO Provider schema
 */
export const SSOProviderSchema = z.enum(['okta', 'azure_ad', 'google', 'saml', 'oidc'])

/**
 * SSO Event Type schema
 */
export const SSOEventTypeSchema = z.enum([
  'sso_login_attempt',
  'sso_login_success',
  'sso_login_failure',
  'sso_logout',
  'sso_session_refresh',
  'sso_provider_error',
])

/**
 * RBAC Event Type schema
 */
export const RBACEventTypeSchema = z.enum([
  'rbac_permission_check',
  'rbac_permission_denied',
  'rbac_role_assigned',
  'rbac_role_revoked',
  'rbac_policy_updated',
])

/**
 * License Event Type schema
 */
export const LicenseEventTypeSchema = z.enum([
  'license_validated',
  'license_expired',
  'license_feature_check',
  'license_seats_exceeded',
])

/**
 * All Audit Event Type schema
 */
export const AuditEventTypeSchema = z.union([
  SSOEventTypeSchema,
  RBACEventTypeSchema,
  LicenseEventTypeSchema,
])

/**
 * Audit Severity schema
 */
export const AuditSeveritySchema = z.enum(['info', 'warning', 'error', 'critical'])

/**
 * SSO Failure Reason schema
 */
export const SSOFailureReasonSchema = z.enum([
  'invalid_credentials',
  'account_disabled',
  'account_locked',
  'mfa_required',
  'mfa_failed',
  'session_expired',
  'token_invalid',
  'token_expired',
  'provider_unavailable',
  'unknown',
])

/**
 * Base SSO/RBAC/License Audit Event schema
 */
export const BaseAuditEventSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  event_type: AuditEventTypeSchema,
  actor: z.string().min(1),
  ip_address: z.string().min(1),
  user_agent: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Base SSO Audit Event schema
 */
export const SSOAuditEventSchema = BaseAuditEventSchema.extend({
  event_type: SSOEventTypeSchema,
  provider: SSOProviderSchema,
  session_id: z.string().optional(),
  email: z.string().email().optional(),
})

/**
 * SSO Login Attempt Event schema
 */
export const SSOLoginAttemptEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_login_attempt'),
  email: z.string().email(),
})

/**
 * SSO Login Success Event schema
 */
export const SSOLoginSuccessEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_login_success'),
  session_id: z.string().min(1),
  email: z.string().email(),
  session_expires_at: z.string().datetime(),
  mfa_used: z.boolean().optional(),
})

/**
 * SSO Login Failure Event schema
 */
export const SSOLoginFailureEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_login_failure'),
  failure_reason: SSOFailureReasonSchema,
  email: z.string().email().optional(),
  attempt_count: z.number().int().positive().optional(),
})

/**
 * SSO Logout Event schema
 */
export const SSOLogoutEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_logout'),
  session_id: z.string().min(1),
  initiated_by: z.enum(['user', 'system', 'timeout', 'admin']),
})

/**
 * SSO Session Refresh Event schema
 */
export const SSOSessionRefreshEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_session_refresh'),
  session_id: z.string().min(1),
  new_expires_at: z.string().datetime(),
  previous_expires_at: z.string().datetime().optional(),
})

/**
 * SSO Provider Error Event schema
 */
export const SSOProviderErrorEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_provider_error'),
  error_code: z.string().min(1),
  error_message: z.string().min(1),
  recoverable: z.boolean(),
})

/**
 * Base RBAC Audit Event schema
 */
export const RBACAuditEventSchema = BaseAuditEventSchema.extend({
  event_type: RBACEventTypeSchema,
  resource: z.string().min(1),
  action: z.string().min(1),
})

/**
 * RBAC Permission Check Event schema
 */
export const RBACPermissionCheckEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_permission_check'),
  granted: z.boolean(),
  roles_checked: z.array(z.string().min(1)),
  policies_evaluated: z.array(z.string().min(1)).optional(),
})

/**
 * RBAC Permission Denied Event schema
 */
export const RBACPermissionDeniedEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_permission_denied'),
  user_roles: z.array(z.string().min(1)),
  required_roles: z.array(z.string().min(1)),
  denial_reason: z.string().min(1),
})

/**
 * RBAC Role Assigned Event schema
 */
export const RBACRoleAssignedEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_role_assigned'),
  target_user: z.string().min(1),
  role: z.string().min(1),
  assigned_by: z.string().min(1),
  expires_at: z.string().datetime().optional(),
})

/**
 * RBAC Role Revoked Event schema
 */
export const RBACRoleRevokedEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_role_revoked'),
  target_user: z.string().min(1),
  role: z.string().min(1),
  revoked_by: z.string().min(1),
  revocation_reason: z.string().optional(),
})

/**
 * RBAC Policy Updated Event schema
 */
export const RBACPolicyUpdatedEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_policy_updated'),
  policy_id: z.string().min(1),
  policy_name: z.string().min(1),
  change_type: z.enum(['created', 'modified', 'deleted']),
  previous_state: z.record(z.string(), z.unknown()).optional(),
  new_state: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Base License Audit Event schema
 */
export const LicenseAuditEventSchema = BaseAuditEventSchema.extend({
  event_type: LicenseEventTypeSchema,
  license_id: z.string().min(1),
  organization_id: z.string().min(1),
})

/**
 * License Validated Event schema
 */
export const LicenseValidatedEventSchema = LicenseAuditEventSchema.extend({
  event_type: z.literal('license_validated'),
  tier: z.enum(['free', 'pro', 'enterprise']),
  expires_at: z.string().datetime(),
  features: z.array(z.string().min(1)),
  max_seats: z.number().int().positive(),
})

/**
 * License Expired Event schema
 */
export const LicenseExpiredEventSchema = LicenseAuditEventSchema.extend({
  event_type: z.literal('license_expired'),
  expired_at: z.string().datetime(),
  grace_period_ends: z.string().datetime().optional(),
  disabled_features: z.array(z.string().min(1)),
})

/**
 * License Feature Check Event schema
 */
export const LicenseFeatureCheckEventSchema = LicenseAuditEventSchema.extend({
  event_type: z.literal('license_feature_check'),
  feature: z.string().min(1),
  enabled: z.boolean(),
  disabled_reason: z.string().optional(),
})

/**
 * License Seats Exceeded Event schema
 */
export const LicenseSeatsExceededEventSchema = LicenseAuditEventSchema.extend({
  event_type: z.literal('license_seats_exceeded'),
  max_seats: z.number().int().positive(),
  current_seats: z.number().int().nonnegative(),
  attempted_user: z.string().optional(),
  access_blocked: z.boolean(),
})

// ============================================================================
// Type Inference Helpers
// ============================================================================

/**
 * Infer TypeScript type from SSO Login Attempt schema
 */
export type SSOLoginAttemptEventParsed = z.infer<typeof SSOLoginAttemptEventSchema>

/**
 * Infer TypeScript type from SSO Login Success schema
 */
export type SSOLoginSuccessEventParsed = z.infer<typeof SSOLoginSuccessEventSchema>

/**
 * Infer TypeScript type from SSO Login Failure schema
 */
export type SSOLoginFailureEventParsed = z.infer<typeof SSOLoginFailureEventSchema>

/**
 * Infer TypeScript type from SSO Logout schema
 */
export type SSOLogoutEventParsed = z.infer<typeof SSOLogoutEventSchema>

/**
 * Infer TypeScript type from SSO Session Refresh schema
 */
export type SSOSessionRefreshEventParsed = z.infer<typeof SSOSessionRefreshEventSchema>

/**
 * Infer TypeScript type from SSO Provider Error schema
 */
export type SSOProviderErrorEventParsed = z.infer<typeof SSOProviderErrorEventSchema>

/**
 * Infer TypeScript type from RBAC Permission Check schema
 */
export type RBACPermissionCheckEventParsed = z.infer<typeof RBACPermissionCheckEventSchema>

/**
 * Infer TypeScript type from RBAC Permission Denied schema
 */
export type RBACPermissionDeniedEventParsed = z.infer<typeof RBACPermissionDeniedEventSchema>

/**
 * Infer TypeScript type from RBAC Role Assigned schema
 */
export type RBACRoleAssignedEventParsed = z.infer<typeof RBACRoleAssignedEventSchema>

/**
 * Infer TypeScript type from RBAC Role Revoked schema
 */
export type RBACRoleRevokedEventParsed = z.infer<typeof RBACRoleRevokedEventSchema>

/**
 * Infer TypeScript type from RBAC Policy Updated schema
 */
export type RBACPolicyUpdatedEventParsed = z.infer<typeof RBACPolicyUpdatedEventSchema>

/**
 * Infer TypeScript type from License Validated schema
 */
export type LicenseValidatedEventParsed = z.infer<typeof LicenseValidatedEventSchema>

/**
 * Infer TypeScript type from License Expired schema
 */
export type LicenseExpiredEventParsed = z.infer<typeof LicenseExpiredEventSchema>

/**
 * Infer TypeScript type from License Feature Check schema
 */
export type LicenseFeatureCheckEventParsed = z.infer<typeof LicenseFeatureCheckEventSchema>

/**
 * Infer TypeScript type from License Seats Exceeded schema
 */
export type LicenseSeatsExceededEventParsed = z.infer<typeof LicenseSeatsExceededEventSchema>

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate an SSO event
 */
export function validateSSOEvent(
  event: unknown
):
  | SSOLoginAttemptEventParsed
  | SSOLoginSuccessEventParsed
  | SSOLoginFailureEventParsed
  | SSOLogoutEventParsed
  | SSOSessionRefreshEventParsed
  | SSOProviderErrorEventParsed {
  // Try each specific schema
  const schemas = [
    SSOLoginAttemptEventSchema,
    SSOLoginSuccessEventSchema,
    SSOLoginFailureEventSchema,
    SSOLogoutEventSchema,
    SSOSessionRefreshEventSchema,
    SSOProviderErrorEventSchema,
  ] as const

  for (const schema of schemas) {
    const result = schema.safeParse(event)
    if (result.success) {
      return result.data
    }
  }

  // If no specific schema matches, throw with generic SSO validation error
  const result = SSOAuditEventSchema.safeParse(event)
  if (!result.success) {
    throw new Error(`Invalid SSO event: ${result.error.message}`)
  }
  throw new Error('Invalid SSO event: event_type does not match any known SSO event')
}

/**
 * Validate an RBAC event
 */
export function validateRBACEvent(
  event: unknown
):
  | RBACPermissionCheckEventParsed
  | RBACPermissionDeniedEventParsed
  | RBACRoleAssignedEventParsed
  | RBACRoleRevokedEventParsed
  | RBACPolicyUpdatedEventParsed {
  const schemas = [
    RBACPermissionCheckEventSchema,
    RBACPermissionDeniedEventSchema,
    RBACRoleAssignedEventSchema,
    RBACRoleRevokedEventSchema,
    RBACPolicyUpdatedEventSchema,
  ] as const

  for (const schema of schemas) {
    const result = schema.safeParse(event)
    if (result.success) {
      return result.data
    }
  }

  const result = RBACAuditEventSchema.safeParse(event)
  if (!result.success) {
    throw new Error(`Invalid RBAC event: ${result.error.message}`)
  }
  throw new Error('Invalid RBAC event: event_type does not match any known RBAC event')
}

/**
 * Validate a License event
 */
export function validateLicenseEvent(
  event: unknown
):
  | LicenseValidatedEventParsed
  | LicenseExpiredEventParsed
  | LicenseFeatureCheckEventParsed
  | LicenseSeatsExceededEventParsed {
  const schemas = [
    LicenseValidatedEventSchema,
    LicenseExpiredEventSchema,
    LicenseFeatureCheckEventSchema,
    LicenseSeatsExceededEventSchema,
  ] as const

  for (const schema of schemas) {
    const result = schema.safeParse(event)
    if (result.success) {
      return result.data
    }
  }

  const result = LicenseAuditEventSchema.safeParse(event)
  if (!result.success) {
    throw new Error(`Invalid License event: ${result.error.message}`)
  }
  throw new Error('Invalid License event: event_type does not match any known License event')
}

/**
 * Validate any base audit event
 */
export function validateBaseAuditEvent(event: unknown): z.infer<typeof BaseAuditEventSchema> {
  return BaseAuditEventSchema.parse(event)
}
