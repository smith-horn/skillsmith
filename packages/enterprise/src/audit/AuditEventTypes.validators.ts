/**
 * SMI-964: SSO/RBAC/License Audit Event Validators
 * @module @skillsmith/enterprise/audit/AuditEventTypes.validators
 */

import {
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

import type {
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

import type { z } from 'zod'

// ============================================================================
// Validation Functions
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
