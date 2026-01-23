/**
 * SMI-964: SSO/RBAC Event Types
 *
 * TypeScript interfaces for enterprise audit events:
 * - SSO Events: Login attempts, successes, failures, logout, session refresh, provider errors
 * - RBAC Events: Permission checks, denials, role assignments, revocations, policy updates
 * - License Events: Validation, expiration, feature checks, seat limits
 */

// Re-export all schemas
export {
  SSOProviderSchema,
  SSOEventTypeSchema,
  RBACEventTypeSchema,
  LicenseEventTypeSchema,
  AuditEventTypeSchema,
  AuditSeveritySchema,
  SSOFailureReasonSchema,
  BaseAuditEventSchema,
  SSOAuditEventSchema,
  SSOLoginAttemptEventSchema,
  SSOLoginSuccessEventSchema,
  SSOLoginFailureEventSchema,
  SSOLogoutEventSchema,
  SSOSessionRefreshEventSchema,
  SSOProviderErrorEventSchema,
  RBACAuditEventSchema,
  RBACPermissionCheckEventSchema,
  RBACPermissionDeniedEventSchema,
  RBACRoleAssignedEventSchema,
  RBACRoleRevokedEventSchema,
  RBACPolicyUpdatedEventSchema,
  LicenseAuditEventSchema,
  LicenseValidatedEventSchema,
  LicenseExpiredEventSchema,
  LicenseFeatureCheckEventSchema,
  LicenseSeatsExceededEventSchema,
} from './AuditEventTypes.schemas.js'

// Re-export parsed types
export type {
  SSOLoginAttemptEventParsed,
  SSOLoginSuccessEventParsed,
  SSOLoginFailureEventParsed,
  SSOLogoutEventParsed,
  SSOSessionRefreshEventParsed,
  SSOProviderErrorEventParsed,
  RBACPermissionCheckEventParsed,
  RBACPermissionDeniedEventParsed,
  RBACRoleAssignedEventParsed,
  RBACRoleRevokedEventParsed,
  RBACPolicyUpdatedEventParsed,
  LicenseValidatedEventParsed,
  LicenseExpiredEventParsed,
  LicenseFeatureCheckEventParsed,
  LicenseSeatsExceededEventParsed,
} from './AuditEventTypes.schemas.js'

// Re-export validators
export {
  validateSSOEvent,
  validateRBACEvent,
  validateLicenseEvent,
  validateBaseAuditEvent,
} from './AuditEventTypes.validators.js'

// ============================================================================
// Base Types
// ============================================================================

/** SSO identity providers */
export type SSOProvider = 'okta' | 'azure_ad' | 'google' | 'saml' | 'oidc'

/** SSO event types */
export type SSOEventType =
  | 'sso_login_attempt'
  | 'sso_login_success'
  | 'sso_login_failure'
  | 'sso_logout'
  | 'sso_session_refresh'
  | 'sso_provider_error'

/** RBAC event types */
export type RBACEventType =
  | 'rbac_permission_check'
  | 'rbac_permission_denied'
  | 'rbac_role_assigned'
  | 'rbac_role_revoked'
  | 'rbac_policy_updated'

/** License event types */
export type LicenseEventType =
  | 'license_validated'
  | 'license_expired'
  | 'license_feature_check'
  | 'license_seats_exceeded'

/** All audit event types */
export type AuditEventType = SSOEventType | RBACEventType | LicenseEventType

/** Severity levels for audit events */
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical'

// ============================================================================
// Base Audit Event
// ============================================================================

/** Base SSO/RBAC/License audit event interface */
export interface BaseAuditEvent {
  id: string
  timestamp: string
  event_type: AuditEventType
  actor: string
  ip_address: string
  user_agent: string
  metadata?: Record<string, unknown>
}

// ============================================================================
// SSO Events
// ============================================================================

/** SSO login failure reason */
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

/** Base SSO audit event */
export interface SSOAuditEvent extends BaseAuditEvent {
  event_type: SSOEventType
  provider: SSOProvider
  session_id?: string
  email?: string
}

/** SSO login attempt event */
export interface SSOLoginAttemptEvent extends SSOAuditEvent {
  event_type: 'sso_login_attempt'
  email: string
}

/** SSO login success event */
export interface SSOLoginSuccessEvent extends SSOAuditEvent {
  event_type: 'sso_login_success'
  session_id: string
  email: string
  session_expires_at: string
  mfa_used?: boolean
}

/** SSO login failure event */
export interface SSOLoginFailureEvent extends SSOAuditEvent {
  event_type: 'sso_login_failure'
  failure_reason: SSOFailureReason
  email?: string
  attempt_count?: number
}

/** SSO logout event */
export interface SSOLogoutEvent extends SSOAuditEvent {
  event_type: 'sso_logout'
  session_id: string
  initiated_by: 'user' | 'system' | 'timeout' | 'admin'
}

/** SSO session refresh event */
export interface SSOSessionRefreshEvent extends SSOAuditEvent {
  event_type: 'sso_session_refresh'
  session_id: string
  new_expires_at: string
  previous_expires_at?: string
}

/** SSO provider error event */
export interface SSOProviderErrorEvent extends SSOAuditEvent {
  event_type: 'sso_provider_error'
  error_code: string
  error_message: string
  recoverable: boolean
}

// ============================================================================
// RBAC Events
// ============================================================================

/** Base RBAC audit event */
export interface RBACAuditEvent extends BaseAuditEvent {
  event_type: RBACEventType
  resource: string
  action: string
}

/** RBAC permission check event */
export interface RBACPermissionCheckEvent extends RBACAuditEvent {
  event_type: 'rbac_permission_check'
  granted: boolean
  roles_checked: string[]
  policies_evaluated?: string[]
}

/** RBAC permission denied event */
export interface RBACPermissionDeniedEvent extends RBACAuditEvent {
  event_type: 'rbac_permission_denied'
  user_roles: string[]
  required_roles: string[]
  denial_reason: string
}

/** RBAC role assigned event */
export interface RBACRoleAssignedEvent extends RBACAuditEvent {
  event_type: 'rbac_role_assigned'
  target_user: string
  role: string
  assigned_by: string
  expires_at?: string
}

/** RBAC role revoked event */
export interface RBACRoleRevokedEvent extends RBACAuditEvent {
  event_type: 'rbac_role_revoked'
  target_user: string
  role: string
  revoked_by: string
  revocation_reason?: string
}

/** RBAC policy updated event */
export interface RBACPolicyUpdatedEvent extends RBACAuditEvent {
  event_type: 'rbac_policy_updated'
  policy_id: string
  policy_name: string
  change_type: 'created' | 'modified' | 'deleted'
  previous_state?: Record<string, unknown>
  new_state?: Record<string, unknown>
}

// ============================================================================
// License Events
// ============================================================================

/** Base license audit event */
export interface LicenseAuditEvent extends BaseAuditEvent {
  event_type: LicenseEventType
  license_id: string
  organization_id: string
}

/** License validated event */
export interface LicenseValidatedEvent extends LicenseAuditEvent {
  event_type: 'license_validated'
  tier: 'free' | 'pro' | 'enterprise'
  expires_at: string
  features: string[]
  max_seats: number
}

/** License expired event */
export interface LicenseExpiredEvent extends LicenseAuditEvent {
  event_type: 'license_expired'
  expired_at: string
  grace_period_ends?: string
  disabled_features: string[]
}

/** License feature check event */
export interface LicenseFeatureCheckEvent extends LicenseAuditEvent {
  event_type: 'license_feature_check'
  feature: string
  enabled: boolean
  disabled_reason?: string
}

/** License seats exceeded event */
export interface LicenseSeatsExceededEvent extends LicenseAuditEvent {
  event_type: 'license_seats_exceeded'
  max_seats: number
  current_seats: number
  attempted_user?: string
  access_blocked: boolean
}
