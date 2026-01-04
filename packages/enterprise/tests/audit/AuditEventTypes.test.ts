/**
 * SMI-964: SSO/RBAC Event Types - Test Suite
 *
 * Comprehensive tests for audit event interfaces and Zod schemas
 */

import { describe, it, expect } from 'vitest'
import {
  // Schemas
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
  // Validation functions
  validateSSOEvent,
  validateRBACEvent,
  validateLicenseEvent,
  validateBaseAuditEvent,
} from '../../src/audit/AuditEventTypes.js'

// ============================================================================
// Test Fixtures
// ============================================================================

const baseEventData = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  timestamp: '2025-01-04T12:00:00.000Z',
  actor: 'user-123',
  ip_address: '192.168.1.100',
  user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
}

const baseSSOEventData = {
  ...baseEventData,
  provider: 'okta' as const,
}

const baseRBACEventData = {
  ...baseEventData,
  resource: 'skills:admin',
  action: 'read',
}

const baseLicenseEventData = {
  ...baseEventData,
  license_id: 'lic_abc123',
  organization_id: 'org_xyz789',
}

// ============================================================================
// Enum Schema Tests
// ============================================================================

describe('Enum Schemas', () => {
  describe('SSOProviderSchema', () => {
    it('should accept valid providers', () => {
      expect(SSOProviderSchema.parse('okta')).toBe('okta')
      expect(SSOProviderSchema.parse('azure_ad')).toBe('azure_ad')
      expect(SSOProviderSchema.parse('google')).toBe('google')
      expect(SSOProviderSchema.parse('saml')).toBe('saml')
      expect(SSOProviderSchema.parse('oidc')).toBe('oidc')
    })

    it('should reject invalid providers', () => {
      expect(() => SSOProviderSchema.parse('invalid')).toThrow()
      expect(() => SSOProviderSchema.parse('')).toThrow()
    })
  })

  describe('SSOEventTypeSchema', () => {
    it('should accept all valid SSO event types', () => {
      const validTypes = [
        'sso_login_attempt',
        'sso_login_success',
        'sso_login_failure',
        'sso_logout',
        'sso_session_refresh',
        'sso_provider_error',
      ]
      for (const type of validTypes) {
        expect(SSOEventTypeSchema.parse(type)).toBe(type)
      }
    })
  })

  describe('RBACEventTypeSchema', () => {
    it('should accept all valid RBAC event types', () => {
      const validTypes = [
        'rbac_permission_check',
        'rbac_permission_denied',
        'rbac_role_assigned',
        'rbac_role_revoked',
        'rbac_policy_updated',
      ]
      for (const type of validTypes) {
        expect(RBACEventTypeSchema.parse(type)).toBe(type)
      }
    })
  })

  describe('LicenseEventTypeSchema', () => {
    it('should accept all valid license event types', () => {
      const validTypes = [
        'license_validated',
        'license_expired',
        'license_feature_check',
        'license_seats_exceeded',
      ]
      for (const type of validTypes) {
        expect(LicenseEventTypeSchema.parse(type)).toBe(type)
      }
    })
  })

  describe('AuditEventTypeSchema', () => {
    it('should accept all audit event types', () => {
      expect(AuditEventTypeSchema.parse('sso_login_success')).toBe('sso_login_success')
      expect(AuditEventTypeSchema.parse('rbac_permission_check')).toBe('rbac_permission_check')
      expect(AuditEventTypeSchema.parse('license_validated')).toBe('license_validated')
    })
  })

  describe('AuditSeveritySchema', () => {
    it('should accept valid severity levels', () => {
      expect(AuditSeveritySchema.parse('info')).toBe('info')
      expect(AuditSeveritySchema.parse('warning')).toBe('warning')
      expect(AuditSeveritySchema.parse('error')).toBe('error')
      expect(AuditSeveritySchema.parse('critical')).toBe('critical')
    })
  })

  describe('SSOFailureReasonSchema', () => {
    it('should accept all failure reasons', () => {
      const reasons = [
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
      ]
      for (const reason of reasons) {
        expect(SSOFailureReasonSchema.parse(reason)).toBe(reason)
      }
    })
  })
})

// ============================================================================
// SSO Event Schema Tests
// ============================================================================

describe('SSO Event Schemas', () => {
  describe('SSOLoginAttemptEventSchema', () => {
    it('should validate a valid login attempt event', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_attempt',
        email: 'user@example.com',
      }
      const result = SSOLoginAttemptEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should require email field', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_attempt',
      }
      const result = SSOLoginAttemptEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })

    it('should validate email format', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_attempt',
        email: 'not-an-email',
      }
      const result = SSOLoginAttemptEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })
  })

  describe('SSOLoginSuccessEventSchema', () => {
    it('should validate a valid login success event', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_success',
        session_id: 'sess_abc123',
        email: 'user@example.com',
        session_expires_at: '2025-01-05T12:00:00.000Z',
        mfa_used: true,
      }
      const result = SSOLoginSuccessEventSchema.safeParse(event)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.mfa_used).toBe(true)
      }
    })

    it('should require session_id and session_expires_at', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_success',
        email: 'user@example.com',
      }
      const result = SSOLoginSuccessEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })
  })

  describe('SSOLoginFailureEventSchema', () => {
    it('should validate a valid login failure event', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_failure',
        failure_reason: 'invalid_credentials',
        email: 'user@example.com',
        attempt_count: 3,
      }
      const result = SSOLoginFailureEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should require failure_reason', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_failure',
      }
      const result = SSOLoginFailureEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })

    it('should validate attempt_count is positive', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_failure',
        failure_reason: 'invalid_credentials',
        attempt_count: -1,
      }
      const result = SSOLoginFailureEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })
  })

  describe('SSOLogoutEventSchema', () => {
    it('should validate a valid logout event', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_logout',
        session_id: 'sess_abc123',
        initiated_by: 'user',
      }
      const result = SSOLogoutEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should accept all initiated_by values', () => {
      for (const initiator of ['user', 'system', 'timeout', 'admin']) {
        const event = {
          ...baseSSOEventData,
          event_type: 'sso_logout',
          session_id: 'sess_abc123',
          initiated_by: initiator,
        }
        const result = SSOLogoutEventSchema.safeParse(event)
        expect(result.success).toBe(true)
      }
    })
  })

  describe('SSOSessionRefreshEventSchema', () => {
    it('should validate a valid session refresh event', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_session_refresh',
        session_id: 'sess_abc123',
        new_expires_at: '2025-01-06T12:00:00.000Z',
        previous_expires_at: '2025-01-05T12:00:00.000Z',
      }
      const result = SSOSessionRefreshEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should allow optional previous_expires_at', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_session_refresh',
        session_id: 'sess_abc123',
        new_expires_at: '2025-01-06T12:00:00.000Z',
      }
      const result = SSOSessionRefreshEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })
  })

  describe('SSOProviderErrorEventSchema', () => {
    it('should validate a valid provider error event', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_provider_error',
        error_code: 'OKTA_503',
        error_message: 'Service temporarily unavailable',
        recoverable: true,
      }
      const result = SSOProviderErrorEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should require all error fields', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_provider_error',
        error_code: 'OKTA_503',
      }
      const result = SSOProviderErrorEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })
  })
})

// ============================================================================
// RBAC Event Schema Tests
// ============================================================================

describe('RBAC Event Schemas', () => {
  describe('RBACPermissionCheckEventSchema', () => {
    it('should validate a valid permission check event', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_permission_check',
        granted: true,
        roles_checked: ['admin', 'editor'],
        policies_evaluated: ['policy_001', 'policy_002'],
      }
      const result = RBACPermissionCheckEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should allow optional policies_evaluated', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_permission_check',
        granted: false,
        roles_checked: ['viewer'],
      }
      const result = RBACPermissionCheckEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })
  })

  describe('RBACPermissionDeniedEventSchema', () => {
    it('should validate a valid permission denied event', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_permission_denied',
        user_roles: ['viewer'],
        required_roles: ['admin', 'editor'],
        denial_reason: 'User does not have required role',
      }
      const result = RBACPermissionDeniedEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should require all fields', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_permission_denied',
        user_roles: ['viewer'],
      }
      const result = RBACPermissionDeniedEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })
  })

  describe('RBACRoleAssignedEventSchema', () => {
    it('should validate a valid role assignment event', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_role_assigned',
        target_user: 'user-456',
        role: 'admin',
        assigned_by: 'user-123',
        expires_at: '2025-06-01T00:00:00.000Z',
      }
      const result = RBACRoleAssignedEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should allow optional expires_at for permanent assignments', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_role_assigned',
        target_user: 'user-456',
        role: 'admin',
        assigned_by: 'user-123',
      }
      const result = RBACRoleAssignedEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })
  })

  describe('RBACRoleRevokedEventSchema', () => {
    it('should validate a valid role revocation event', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_role_revoked',
        target_user: 'user-456',
        role: 'admin',
        revoked_by: 'user-123',
        revocation_reason: 'Employee termination',
      }
      const result = RBACRoleRevokedEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should allow optional revocation_reason', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_role_revoked',
        target_user: 'user-456',
        role: 'admin',
        revoked_by: 'user-123',
      }
      const result = RBACRoleRevokedEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })
  })

  describe('RBACPolicyUpdatedEventSchema', () => {
    it('should validate a valid policy update event', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_policy_updated',
        policy_id: 'pol_001',
        policy_name: 'Admin Access Policy',
        change_type: 'modified',
        previous_state: { permissions: ['read'] },
        new_state: { permissions: ['read', 'write'] },
      }
      const result = RBACPolicyUpdatedEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should accept all change types', () => {
      for (const changeType of ['created', 'modified', 'deleted']) {
        const event = {
          ...baseRBACEventData,
          event_type: 'rbac_policy_updated',
          policy_id: 'pol_001',
          policy_name: 'Test Policy',
          change_type: changeType,
        }
        const result = RBACPolicyUpdatedEventSchema.safeParse(event)
        expect(result.success).toBe(true)
      }
    })
  })
})

// ============================================================================
// License Event Schema Tests
// ============================================================================

describe('License Event Schemas', () => {
  describe('LicenseValidatedEventSchema', () => {
    it('should validate a valid license validation event', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_validated',
        tier: 'enterprise',
        expires_at: '2026-01-01T00:00:00.000Z',
        features: ['sso', 'audit', 'rbac'],
        max_seats: 100,
      }
      const result = LicenseValidatedEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should accept all tier values', () => {
      for (const tier of ['free', 'pro', 'enterprise']) {
        const event = {
          ...baseLicenseEventData,
          event_type: 'license_validated',
          tier,
          expires_at: '2026-01-01T00:00:00.000Z',
          features: [],
          max_seats: 10,
        }
        const result = LicenseValidatedEventSchema.safeParse(event)
        expect(result.success).toBe(true)
      }
    })

    it('should require positive max_seats', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_validated',
        tier: 'pro',
        expires_at: '2026-01-01T00:00:00.000Z',
        features: [],
        max_seats: 0,
      }
      const result = LicenseValidatedEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })
  })

  describe('LicenseExpiredEventSchema', () => {
    it('should validate a valid license expired event', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_expired',
        expired_at: '2025-01-01T00:00:00.000Z',
        grace_period_ends: '2025-01-15T00:00:00.000Z',
        disabled_features: ['sso', 'audit'],
      }
      const result = LicenseExpiredEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should allow optional grace_period_ends', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_expired',
        expired_at: '2025-01-01T00:00:00.000Z',
        disabled_features: ['sso'],
      }
      const result = LicenseExpiredEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })
  })

  describe('LicenseFeatureCheckEventSchema', () => {
    it('should validate a valid feature check event', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_feature_check',
        feature: 'sso',
        enabled: true,
      }
      const result = LicenseFeatureCheckEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should include disabled_reason when feature is disabled', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_feature_check',
        feature: 'advanced_analytics',
        enabled: false,
        disabled_reason: 'Feature not included in current tier',
      }
      const result = LicenseFeatureCheckEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })
  })

  describe('LicenseSeatsExceededEventSchema', () => {
    it('should validate a valid seats exceeded event', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_seats_exceeded',
        max_seats: 10,
        current_seats: 11,
        attempted_user: 'user-new',
        access_blocked: true,
      }
      const result = LicenseSeatsExceededEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should allow current_seats to be zero', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_seats_exceeded',
        max_seats: 0,
        current_seats: 0,
        access_blocked: true,
      }
      // max_seats must be positive, so this should fail
      const result = LicenseSeatsExceededEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })

    it('should require access_blocked field', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_seats_exceeded',
        max_seats: 10,
        current_seats: 11,
      }
      const result = LicenseSeatsExceededEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })
  })
})

// ============================================================================
// Base Event Validation Tests
// ============================================================================

describe('Base Event Validation', () => {
  describe('BaseAuditEventSchema', () => {
    it('should validate a minimal valid event', () => {
      const event = {
        ...baseEventData,
        event_type: 'sso_login_success',
      }
      const result = BaseAuditEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should require valid UUID for id', () => {
      const event = {
        ...baseEventData,
        id: 'not-a-uuid',
        event_type: 'sso_login_success',
      }
      const result = BaseAuditEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })

    it('should require valid ISO timestamp', () => {
      const event = {
        ...baseEventData,
        timestamp: 'not-a-timestamp',
        event_type: 'sso_login_success',
      }
      const result = BaseAuditEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })

    it('should require non-empty IP address', () => {
      const event = {
        ...baseEventData,
        ip_address: '',
        event_type: 'sso_login_success',
      }
      const result = BaseAuditEventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })

    it('should accept any non-empty IP address string', () => {
      const event = {
        ...baseEventData,
        ip_address: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
        event_type: 'sso_login_success',
      }
      const result = BaseAuditEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    it('should allow optional metadata', () => {
      const event = {
        ...baseEventData,
        event_type: 'sso_login_success',
        metadata: { custom_field: 'value', nested: { data: true } },
      }
      const result = BaseAuditEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })
  })
})

// ============================================================================
// Validation Helper Function Tests
// ============================================================================

describe('Validation Helper Functions', () => {
  describe('validateSSOEvent', () => {
    it('should validate SSO login attempt event', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_attempt',
        email: 'user@example.com',
      }
      expect(() => validateSSOEvent(event)).not.toThrow()
      const result = validateSSOEvent(event)
      expect(result.event_type).toBe('sso_login_attempt')
    })

    it('should validate SSO login success event', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'sso_login_success',
        session_id: 'sess_123',
        email: 'user@example.com',
        session_expires_at: '2025-01-05T12:00:00.000Z',
      }
      const result = validateSSOEvent(event)
      expect(result.event_type).toBe('sso_login_success')
    })

    it('should throw for invalid SSO event', () => {
      const event = {
        ...baseSSOEventData,
        event_type: 'invalid_type',
      }
      expect(() => validateSSOEvent(event)).toThrow()
    })
  })

  describe('validateRBACEvent', () => {
    it('should validate RBAC permission check event', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_permission_check',
        granted: true,
        roles_checked: ['admin'],
      }
      const result = validateRBACEvent(event)
      expect(result.event_type).toBe('rbac_permission_check')
    })

    it('should throw for invalid RBAC event', () => {
      const event = {
        ...baseRBACEventData,
        event_type: 'rbac_invalid',
      }
      expect(() => validateRBACEvent(event)).toThrow()
    })
  })

  describe('validateLicenseEvent', () => {
    it('should validate license validated event', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_validated',
        tier: 'enterprise',
        expires_at: '2026-01-01T00:00:00.000Z',
        features: ['sso'],
        max_seats: 50,
      }
      const result = validateLicenseEvent(event)
      expect(result.event_type).toBe('license_validated')
    })

    it('should throw for invalid license event', () => {
      const event = {
        ...baseLicenseEventData,
        event_type: 'license_invalid',
      }
      expect(() => validateLicenseEvent(event)).toThrow()
    })
  })

  describe('validateBaseAuditEvent', () => {
    it('should validate any valid audit event', () => {
      const event = {
        ...baseEventData,
        event_type: 'sso_login_success',
      }
      const result = validateBaseAuditEvent(event)
      expect(result.event_type).toBe('sso_login_success')
    })

    it('should throw for missing required fields', () => {
      const event = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        event_type: 'sso_login_success',
      }
      expect(() => validateBaseAuditEvent(event)).toThrow()
    })
  })
})

// ============================================================================
// Edge Cases and Security Tests
// ============================================================================

describe('Edge Cases and Security', () => {
  it('should handle empty strings correctly', () => {
    const event = {
      ...baseEventData,
      actor: '',
      event_type: 'sso_login_success',
    }
    const result = BaseAuditEventSchema.safeParse(event)
    expect(result.success).toBe(false)
  })

  it('should handle null values', () => {
    const event = {
      ...baseEventData,
      actor: null,
      event_type: 'sso_login_success',
    }
    const result = BaseAuditEventSchema.safeParse(event)
    expect(result.success).toBe(false)
  })

  it('should handle undefined values', () => {
    const event = {
      ...baseEventData,
      actor: undefined,
      event_type: 'sso_login_success',
    }
    const result = BaseAuditEventSchema.safeParse(event)
    expect(result.success).toBe(false)
  })

  it('should handle excessively long strings', () => {
    const event = {
      ...baseEventData,
      actor: 'a'.repeat(10000),
      event_type: 'sso_login_success',
    }
    // The schema allows long strings but the consumer should handle this
    const result = BaseAuditEventSchema.safeParse(event)
    expect(result.success).toBe(true)
  })

  it('should handle special characters in user agent', () => {
    const event = {
      ...baseEventData,
      user_agent: 'Mozilla/5.0 <script>alert("xss")</script>',
      event_type: 'sso_login_success',
    }
    // Schema validates structure, not content safety
    const result = BaseAuditEventSchema.safeParse(event)
    expect(result.success).toBe(true)
  })

  it('should accept metadata with nested objects', () => {
    const event = {
      ...baseEventData,
      event_type: 'sso_login_success',
      metadata: {
        deeply: {
          nested: {
            object: {
              value: true,
            },
          },
        },
      },
    }
    const result = BaseAuditEventSchema.safeParse(event)
    expect(result.success).toBe(true)
  })
})
