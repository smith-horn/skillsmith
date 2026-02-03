/**
 * SMI-2269: QuarantineService Integration Tests
 *
 * Tests for authenticated quarantine review operations including:
 * - Session validation
 * - Permission checks (security_reviewer role)
 * - Multi-approval workflow for MALICIOUS severity
 * - Audit logging with verified identities
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { QuarantineService } from '../../src/services/quarantine/QuarantineService.js'
import { QuarantineServiceError } from '../../src/services/quarantine/types.js'
import type {
  AuthenticatedSession,
  QuarantinePermission,
} from '../../src/services/quarantine/types.js'
import { QuarantineRepository } from '../../src/repositories/quarantine/index.js'
import { AuditLogger } from '../../src/security/AuditLogger.js'
import { createDatabaseSync } from '../../src/db/createDatabase.js'
import type { Database } from '../../src/db/database-interface.js'

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock authenticated session for testing
 */
function createMockSession(overrides: Partial<AuthenticatedSession> = {}): AuthenticatedSession {
  return {
    userId: 'user-123',
    email: 'reviewer@example.com',
    displayName: 'Test Reviewer',
    permissions: ['quarantine:read', 'quarantine:review'],
    sessionId: 'session-456',
    expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
    ...overrides,
  }
}

/**
 * Create a session with specific permissions
 */
function createSessionWithPermissions(permissions: QuarantinePermission[]): AuthenticatedSession {
  return createMockSession({ permissions })
}

/**
 * Create an expired session
 */
function createExpiredSession(): AuthenticatedSession {
  return createMockSession({
    expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
  })
}

// ============================================================================
// Test Suite
// ============================================================================

describe('SMI-2269: QuarantineService Authentication', () => {
  let db: Database
  let repository: QuarantineRepository
  let auditLogger: AuditLogger
  let service: QuarantineService

  beforeEach(() => {
    // Create in-memory database for testing
    db = createDatabaseSync(':memory:')
    auditLogger = new AuditLogger(db)
    repository = new QuarantineRepository(db, auditLogger)
    service = new QuarantineService(repository, auditLogger)
  })

  afterEach(() => {
    db.close()
  })

  // ==========================================================================
  // Session Validation Tests
  // ==========================================================================

  describe('Session Validation', () => {
    it('should reject expired sessions', () => {
      const session = createExpiredSession()

      expect(() => service.findById(session, 'some-id')).toThrow(QuarantineServiceError)
      expect(() => service.findById(session, 'some-id')).toThrow('Session has expired')
    })

    it('should accept valid sessions', () => {
      const session = createMockSession()

      // Should not throw
      expect(() => service.findById(session, 'nonexistent-id')).not.toThrow()
    })

    it('should include session expiry in error details', () => {
      const session = createExpiredSession()

      try {
        service.findById(session, 'some-id')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(QuarantineServiceError)
        expect((error as QuarantineServiceError).code).toBe('SESSION_EXPIRED')
        expect((error as QuarantineServiceError).details?.expiresAt).toBeDefined()
      }
    })
  })

  // ==========================================================================
  // Permission Tests
  // ==========================================================================

  describe('Permission Enforcement', () => {
    it('should reject users without quarantine:read permission', () => {
      const session = createSessionWithPermissions([])

      expect(() => service.findById(session, 'some-id')).toThrow(QuarantineServiceError)
      expect(() => service.findById(session, 'some-id')).toThrow('Permission denied')
    })

    it('should allow read with quarantine:read permission', () => {
      const session = createSessionWithPermissions(['quarantine:read'])

      // Should not throw
      expect(() => service.findById(session, 'nonexistent-id')).not.toThrow()
    })

    it('should reject review without quarantine:review permission', () => {
      const session = createSessionWithPermissions(['quarantine:read'])

      // Create a quarantine entry first
      const entry = repository.create({
        skillId: 'test/skill',
        source: 'test',
        quarantineReason: 'Test reason',
        severity: 'SUSPICIOUS',
      })

      expect(() =>
        service.review(session, entry.id, {
          reviewStatus: 'approved',
        })
      ).toThrow('Permission denied')
    })

    it('should allow admin users to bypass permission checks', () => {
      const session = createSessionWithPermissions(['quarantine:admin'])

      // Admin should be able to read without explicit read permission
      expect(() => service.findById(session, 'nonexistent-id')).not.toThrow()
    })

    it('should include required permission in error details', () => {
      const session = createSessionWithPermissions([])

      try {
        service.findById(session, 'some-id')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(QuarantineServiceError)
        expect((error as QuarantineServiceError).code).toBe('INSUFFICIENT_PERMISSIONS')
        expect((error as QuarantineServiceError).details?.required).toBe('quarantine:read')
      }
    })
  })

  // ==========================================================================
  // Review Tests
  // ==========================================================================

  describe('Authenticated Review', () => {
    it('should include verified reviewer identity in result', () => {
      const session = createMockSession({
        userId: 'verified-user-123',
        email: 'verified@example.com',
        displayName: 'Verified Reviewer',
      })

      const entry = repository.create({
        skillId: 'test/skill',
        source: 'test',
        quarantineReason: 'Test reason',
        severity: 'SUSPICIOUS',
      })

      const result = service.review(session, entry.id, {
        reviewStatus: 'approved',
        reviewNotes: 'Verified safe',
      })

      expect(result.reviewedBy.userId).toBe('verified-user-123')
      expect(result.reviewedBy.email).toBe('verified@example.com')
      expect(result.reviewedBy.displayName).toBe('Verified Reviewer')
    })

    it('should reject review of non-existent entry', () => {
      const session = createMockSession()

      expect(() =>
        service.review(session, 'nonexistent-id', {
          reviewStatus: 'approved',
        })
      ).toThrow('Quarantine entry not found')
    })

    it('should reject review of already-reviewed entry', () => {
      const session = createMockSession()

      const entry = repository.create({
        skillId: 'test/skill',
        source: 'test',
        quarantineReason: 'Test reason',
        severity: 'SUSPICIOUS',
      })

      // First review should succeed
      service.review(session, entry.id, {
        reviewStatus: 'approved',
      })

      // Second review should fail
      expect(() =>
        service.review(session, entry.id, {
          reviewStatus: 'rejected',
        })
      ).toThrow('already reviewed')
    })

    it('should log audit event with session details', () => {
      const session = createMockSession({
        sessionId: 'audit-test-session',
      })

      const entry = repository.create({
        skillId: 'test/audit-skill',
        source: 'test',
        quarantineReason: 'Test reason',
        severity: 'SUSPICIOUS',
      })

      // Spy on audit logger
      const logSpy = vi.spyOn(auditLogger, 'log')

      service.review(session, entry.id, {
        reviewStatus: 'approved',
      })

      // Check audit was logged
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'quarantine_authenticated_review',
          actor: 'reviewer',
          resource: 'test/audit-skill',
          action: 'review',
          result: 'success',
          metadata: expect.objectContaining({
            sessionId: 'audit-test-session',
            reviewer: expect.objectContaining({
              userId: session.userId,
              email: session.email,
            }),
          }),
        })
      )
    })
  })

  // ==========================================================================
  // MALICIOUS Severity Multi-Approval Tests
  // ==========================================================================

  describe('Multi-Approval Workflow (MALICIOUS Severity)', () => {
    it('should require quarantine:review_malicious permission for MALICIOUS reviews', () => {
      const session = createSessionWithPermissions(['quarantine:read', 'quarantine:review'])

      const entry = repository.create({
        skillId: 'test/malicious-skill',
        source: 'test',
        quarantineReason: 'Malicious code detected',
        severity: 'MALICIOUS',
      })

      expect(() =>
        service.review(session, entry.id, {
          reviewStatus: 'approved',
        })
      ).toThrow('quarantine:review_malicious required')
    })

    it('should start multi-approval workflow for MALICIOUS approval', () => {
      const session = createSessionWithPermissions([
        'quarantine:read',
        'quarantine:review',
        'quarantine:review_malicious',
      ])

      const entry = repository.create({
        skillId: 'test/malicious-skill',
        source: 'test',
        quarantineReason: 'Malicious code detected',
        severity: 'MALICIOUS',
      })

      const result = service.review(session, entry.id, {
        reviewStatus: 'approved',
        reviewNotes: 'First approval',
      })

      expect(result.approved).toBe(false) // Not yet approved (needs 2 approvals)
      expect(result.multiApprovalStatus).toBeDefined()
      expect(result.multiApprovalStatus?.currentApprovals.length).toBe(1)
      expect(result.multiApprovalStatus?.requiredApprovals).toBe(2)
    })

    it('should complete approval when enough reviewers approve', () => {
      const session1 = createSessionWithPermissions([
        'quarantine:read',
        'quarantine:review',
        'quarantine:review_malicious',
      ])
      const session2 = createMockSession({
        userId: 'user-456',
        email: 'reviewer2@example.com',
        permissions: ['quarantine:read', 'quarantine:review', 'quarantine:review_malicious'],
      })

      const entry = repository.create({
        skillId: 'test/malicious-skill',
        source: 'test',
        quarantineReason: 'Malicious code detected',
        severity: 'MALICIOUS',
      })

      // First approval
      const result1 = service.review(session1, entry.id, {
        reviewStatus: 'approved',
        reviewNotes: 'First approval',
      })
      expect(result1.approved).toBe(false)

      // Second approval
      const result2 = service.review(session2, entry.id, {
        reviewStatus: 'approved',
        reviewNotes: 'Second approval',
      })
      expect(result2.approved).toBe(true)
      expect(result2.multiApprovalStatus?.isComplete).toBe(true)
    })

    it('should prevent same user from approving twice', () => {
      const session = createSessionWithPermissions([
        'quarantine:read',
        'quarantine:review',
        'quarantine:review_malicious',
      ])

      const entry = repository.create({
        skillId: 'test/malicious-skill',
        source: 'test',
        quarantineReason: 'Malicious code detected',
        severity: 'MALICIOUS',
      })

      // First approval should work
      service.review(session, entry.id, {
        reviewStatus: 'approved',
      })

      // Same user trying to approve again should fail
      expect(() =>
        service.review(session, entry.id, {
          reviewStatus: 'approved',
        })
      ).toThrow('already approved')
    })

    it('should allow MALICIOUS rejection without multi-approval', () => {
      const session = createSessionWithPermissions([
        'quarantine:read',
        'quarantine:review',
        'quarantine:review_malicious',
      ])

      const entry = repository.create({
        skillId: 'test/malicious-skill',
        source: 'test',
        quarantineReason: 'Malicious code detected',
        severity: 'MALICIOUS',
      })

      // Rejection should work immediately (no multi-approval needed)
      const result = service.review(session, entry.id, {
        reviewStatus: 'rejected',
        reviewNotes: 'Confirmed malicious',
      })

      expect(result.approved).toBe(false)
      expect(result.multiApprovalStatus).toBeUndefined()
    })

    it('should track multi-approval status', () => {
      const session = createSessionWithPermissions([
        'quarantine:read',
        'quarantine:review',
        'quarantine:review_malicious',
      ])

      const entry = repository.create({
        skillId: 'test/malicious-skill',
        source: 'test',
        quarantineReason: 'Malicious code detected',
        severity: 'MALICIOUS',
      })

      // First approval
      service.review(session, entry.id, {
        reviewStatus: 'approved',
      })

      // Check status
      const status = service.getMultiApprovalStatus(session, entry.id)
      expect(status).not.toBeNull()
      expect(status?.currentApprovals.length).toBe(1)
      expect(status?.isComplete).toBe(false)
    })
  })

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('Error Handling', () => {
    it('should return typed error codes', () => {
      const session = createExpiredSession()

      try {
        service.findById(session, 'some-id')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(QuarantineServiceError)
        expect((error as QuarantineServiceError).code).toBe('SESSION_EXPIRED')
        expect((error as QuarantineServiceError).name).toBe('QuarantineServiceError')
      }
    })

    it('should include error details for debugging', () => {
      const session = createSessionWithPermissions([])

      try {
        service.findById(session, 'some-id')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(QuarantineServiceError)
        expect((error as QuarantineServiceError).details).toBeDefined()
        expect((error as QuarantineServiceError).details?.available).toEqual([])
      }
    })
  })
})
