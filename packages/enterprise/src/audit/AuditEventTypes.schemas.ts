/**
 * SMI-964: SSO/RBAC/License Audit Event Zod Schemas
 * @module @skillsmith/enterprise/audit/AuditEventTypes.schemas
 */

import { z } from 'zod'

// ============================================================================
// Base Schemas
// ============================================================================

export const SSOProviderSchema = z.enum(['okta', 'azure_ad', 'google', 'saml', 'oidc'])

export const SSOEventTypeSchema = z.enum([
  'sso_login_attempt',
  'sso_login_success',
  'sso_login_failure',
  'sso_logout',
  'sso_session_refresh',
  'sso_provider_error',
])

export const RBACEventTypeSchema = z.enum([
  'rbac_permission_check',
  'rbac_permission_denied',
  'rbac_role_assigned',
  'rbac_role_revoked',
  'rbac_policy_updated',
])

export const LicenseEventTypeSchema = z.enum([
  'license_validated',
  'license_expired',
  'license_feature_check',
  'license_seats_exceeded',
])

export const AuditEventTypeSchema = z.union([
  SSOEventTypeSchema,
  RBACEventTypeSchema,
  LicenseEventTypeSchema,
])

export const AuditSeveritySchema = z.enum(['info', 'warning', 'error', 'critical'])

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

// ============================================================================
// Base Event Schemas
// ============================================================================

export const BaseAuditEventSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  event_type: AuditEventTypeSchema,
  actor: z.string().min(1),
  ip_address: z.string().min(1),
  user_agent: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const SSOAuditEventSchema = BaseAuditEventSchema.extend({
  event_type: SSOEventTypeSchema,
  provider: SSOProviderSchema,
  session_id: z.string().optional(),
  email: z.string().email().optional(),
})

export const RBACAuditEventSchema = BaseAuditEventSchema.extend({
  event_type: RBACEventTypeSchema,
  resource: z.string().min(1),
  action: z.string().min(1),
})

export const LicenseAuditEventSchema = BaseAuditEventSchema.extend({
  event_type: LicenseEventTypeSchema,
  license_id: z.string().min(1),
  organization_id: z.string().min(1),
})

// ============================================================================
// SSO Event Schemas
// ============================================================================

export const SSOLoginAttemptEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_login_attempt'),
  email: z.string().email(),
})

export const SSOLoginSuccessEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_login_success'),
  session_id: z.string().min(1),
  email: z.string().email(),
  session_expires_at: z.string().datetime(),
  mfa_used: z.boolean().optional(),
})

export const SSOLoginFailureEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_login_failure'),
  failure_reason: SSOFailureReasonSchema,
  email: z.string().email().optional(),
  attempt_count: z.number().int().positive().optional(),
})

export const SSOLogoutEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_logout'),
  session_id: z.string().min(1),
  initiated_by: z.enum(['user', 'system', 'timeout', 'admin']),
})

export const SSOSessionRefreshEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_session_refresh'),
  session_id: z.string().min(1),
  new_expires_at: z.string().datetime(),
  previous_expires_at: z.string().datetime().optional(),
})

export const SSOProviderErrorEventSchema = SSOAuditEventSchema.extend({
  event_type: z.literal('sso_provider_error'),
  error_code: z.string().min(1),
  error_message: z.string().min(1),
  recoverable: z.boolean(),
})

// ============================================================================
// RBAC Event Schemas
// ============================================================================

export const RBACPermissionCheckEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_permission_check'),
  granted: z.boolean(),
  roles_checked: z.array(z.string().min(1)),
  policies_evaluated: z.array(z.string().min(1)).optional(),
})

export const RBACPermissionDeniedEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_permission_denied'),
  user_roles: z.array(z.string().min(1)),
  required_roles: z.array(z.string().min(1)),
  denial_reason: z.string().min(1),
})

export const RBACRoleAssignedEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_role_assigned'),
  target_user: z.string().min(1),
  role: z.string().min(1),
  assigned_by: z.string().min(1),
  expires_at: z.string().datetime().optional(),
})

export const RBACRoleRevokedEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_role_revoked'),
  target_user: z.string().min(1),
  role: z.string().min(1),
  revoked_by: z.string().min(1),
  revocation_reason: z.string().optional(),
})

export const RBACPolicyUpdatedEventSchema = RBACAuditEventSchema.extend({
  event_type: z.literal('rbac_policy_updated'),
  policy_id: z.string().min(1),
  policy_name: z.string().min(1),
  change_type: z.enum(['created', 'modified', 'deleted']),
  previous_state: z.record(z.string(), z.unknown()).optional(),
  new_state: z.record(z.string(), z.unknown()).optional(),
})

// ============================================================================
// License Event Schemas
// ============================================================================

export const LicenseValidatedEventSchema = LicenseAuditEventSchema.extend({
  event_type: z.literal('license_validated'),
  tier: z.enum(['free', 'pro', 'enterprise']),
  expires_at: z.string().datetime(),
  features: z.array(z.string().min(1)),
  max_seats: z.number().int().positive(),
})

export const LicenseExpiredEventSchema = LicenseAuditEventSchema.extend({
  event_type: z.literal('license_expired'),
  expired_at: z.string().datetime(),
  grace_period_ends: z.string().datetime().optional(),
  disabled_features: z.array(z.string().min(1)),
})

export const LicenseFeatureCheckEventSchema = LicenseAuditEventSchema.extend({
  event_type: z.literal('license_feature_check'),
  feature: z.string().min(1),
  enabled: z.boolean(),
  disabled_reason: z.string().optional(),
})

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

export type SSOLoginAttemptEventParsed = z.infer<typeof SSOLoginAttemptEventSchema>
export type SSOLoginSuccessEventParsed = z.infer<typeof SSOLoginSuccessEventSchema>
export type SSOLoginFailureEventParsed = z.infer<typeof SSOLoginFailureEventSchema>
export type SSOLogoutEventParsed = z.infer<typeof SSOLogoutEventSchema>
export type SSOSessionRefreshEventParsed = z.infer<typeof SSOSessionRefreshEventSchema>
export type SSOProviderErrorEventParsed = z.infer<typeof SSOProviderErrorEventSchema>

export type RBACPermissionCheckEventParsed = z.infer<typeof RBACPermissionCheckEventSchema>
export type RBACPermissionDeniedEventParsed = z.infer<typeof RBACPermissionDeniedEventSchema>
export type RBACRoleAssignedEventParsed = z.infer<typeof RBACRoleAssignedEventSchema>
export type RBACRoleRevokedEventParsed = z.infer<typeof RBACRoleRevokedEventSchema>
export type RBACPolicyUpdatedEventParsed = z.infer<typeof RBACPolicyUpdatedEventSchema>

export type LicenseValidatedEventParsed = z.infer<typeof LicenseValidatedEventSchema>
export type LicenseExpiredEventParsed = z.infer<typeof LicenseExpiredEventSchema>
export type LicenseFeatureCheckEventParsed = z.infer<typeof LicenseFeatureCheckEventSchema>
export type LicenseSeatsExceededEventParsed = z.infer<typeof LicenseSeatsExceededEventSchema>
