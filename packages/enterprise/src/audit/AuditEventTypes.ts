/**
 * SMI-964: SSO/RBAC Event Types
 * SMI-1712: Refactored to use z.infer<> exclusively to avoid type drift
 *
 * TypeScript types for enterprise audit events, derived from Zod schemas.
 * All types are single-source-of-truth from schemas - no manual interfaces.
 */

import { z } from 'zod'

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

// Import schemas for type inference
import {
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

// Re-export validators
export {
  validateSSOEvent,
  validateRBACEvent,
  validateLicenseEvent,
  validateBaseAuditEvent,
} from './AuditEventTypes.validators.js'

// ============================================================================
// Base Types (derived from Zod schemas)
// ============================================================================

/** SSO identity providers */
export type SSOProvider = z.infer<typeof SSOProviderSchema>

/** SSO event types */
export type SSOEventType = z.infer<typeof SSOEventTypeSchema>

/** RBAC event types */
export type RBACEventType = z.infer<typeof RBACEventTypeSchema>

/** License event types */
export type LicenseEventType = z.infer<typeof LicenseEventTypeSchema>

/** All audit event types */
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>

/** Severity levels for audit events */
export type AuditSeverity = z.infer<typeof AuditSeveritySchema>

/** SSO login failure reason */
export type SSOFailureReason = z.infer<typeof SSOFailureReasonSchema>

// ============================================================================
// Base Event Types
// ============================================================================

/** Base SSO/RBAC/License audit event */
export type BaseAuditEvent = z.infer<typeof BaseAuditEventSchema>

/** Base SSO audit event */
export type SSOAuditEvent = z.infer<typeof SSOAuditEventSchema>

/** Base RBAC audit event */
export type RBACAuditEvent = z.infer<typeof RBACAuditEventSchema>

/** Base license audit event */
export type LicenseAuditEvent = z.infer<typeof LicenseAuditEventSchema>

// ============================================================================
// SSO Events
// ============================================================================

/** SSO login attempt event */
export type SSOLoginAttemptEvent = z.infer<typeof SSOLoginAttemptEventSchema>

/** SSO login success event */
export type SSOLoginSuccessEvent = z.infer<typeof SSOLoginSuccessEventSchema>

/** SSO login failure event */
export type SSOLoginFailureEvent = z.infer<typeof SSOLoginFailureEventSchema>

/** SSO logout event */
export type SSOLogoutEvent = z.infer<typeof SSOLogoutEventSchema>

/** SSO session refresh event */
export type SSOSessionRefreshEvent = z.infer<typeof SSOSessionRefreshEventSchema>

/** SSO provider error event */
export type SSOProviderErrorEvent = z.infer<typeof SSOProviderErrorEventSchema>

// ============================================================================
// RBAC Events
// ============================================================================

/** RBAC permission check event */
export type RBACPermissionCheckEvent = z.infer<typeof RBACPermissionCheckEventSchema>

/** RBAC permission denied event */
export type RBACPermissionDeniedEvent = z.infer<typeof RBACPermissionDeniedEventSchema>

/** RBAC role assigned event */
export type RBACRoleAssignedEvent = z.infer<typeof RBACRoleAssignedEventSchema>

/** RBAC role revoked event */
export type RBACRoleRevokedEvent = z.infer<typeof RBACRoleRevokedEventSchema>

/** RBAC policy updated event */
export type RBACPolicyUpdatedEvent = z.infer<typeof RBACPolicyUpdatedEventSchema>

// ============================================================================
// License Events
// ============================================================================

/** License validated event */
export type LicenseValidatedEvent = z.infer<typeof LicenseValidatedEventSchema>

/** License expired event */
export type LicenseExpiredEvent = z.infer<typeof LicenseExpiredEventSchema>

/** License feature check event */
export type LicenseFeatureCheckEvent = z.infer<typeof LicenseFeatureCheckEventSchema>

/** License seats exceeded event */
export type LicenseSeatsExceededEvent = z.infer<typeof LicenseSeatsExceededEventSchema>
