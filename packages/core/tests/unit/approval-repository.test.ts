/**
 * SMI-2277: ApprovalRepository Unit Tests
 *
 * Tests for the database-persisted multi-approval workflow state.
 * Verifies that approval state survives across repository instances
 * (simulating service restarts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ApprovalRepository } from '../../src/repositories/quarantine/ApprovalRepository.js'
import { createDatabaseSync } from '../../src/db/createDatabase.js'
import type { Database } from '../../src/db/database-interface.js'

describe('SMI-2277: ApprovalRepository', () => {
  let db: Database
  let repo: ApprovalRepository

  beforeEach(() => {
    db = createDatabaseSync(':memory:')
    repo = new ApprovalRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  // ==========================================================================
  // Recording Approvals
  // ==========================================================================

  describe('recordApproval', () => {
    it('should record an approval with generated ID', () => {
      const entry = repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-456',
        reviewerEmail: 'reviewer@example.com',
        decision: 'approved',
        reason: 'Code verified safe',
      })

      expect(entry.id).toBeDefined()
      expect(entry.skillId).toBe('quarantine-123')
      expect(entry.reviewerId).toBe('user-456')
      expect(entry.reviewerEmail).toBe('reviewer@example.com')
      expect(entry.decision).toBe('approved')
      expect(entry.reason).toBe('Code verified safe')
      expect(entry.isComplete).toBe(false)
      expect(entry.requiredApprovals).toBe(2)
      expect(entry.createdAt).toBeDefined()
    })

    it('should record a rejection', () => {
      const entry = repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-456',
        reviewerEmail: 'reviewer@example.com',
        decision: 'rejected',
        reason: 'Confirmed malicious',
      })

      expect(entry.decision).toBe('rejected')
    })

    it('should record approval without reason', () => {
      const entry = repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-456',
        reviewerEmail: 'reviewer@example.com',
        decision: 'approved',
      })

      expect(entry.reason).toBeNull()
    })

    it('should respect custom requiredApprovals', () => {
      const entry = repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-456',
        reviewerEmail: 'reviewer@example.com',
        decision: 'approved',
        requiredApprovals: 3,
      })

      expect(entry.requiredApprovals).toBe(3)
    })

    it('should allow different reviewers for the same skill', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
      })

      const approvals = repo.getApprovals('quarantine-123')
      expect(approvals).toHaveLength(2)
    })
  })

  // ==========================================================================
  // Querying Approvals
  // ==========================================================================

  describe('getApprovals', () => {
    it('should return empty array for unknown skill', () => {
      const approvals = repo.getApprovals('nonexistent')
      expect(approvals).toEqual([])
    })

    it('should return all approvals for a skill in order', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
        reason: 'First',
      })

      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
        reason: 'Second',
      })

      const approvals = repo.getApprovals('quarantine-123')
      expect(approvals).toHaveLength(2)
      expect(approvals[0].reason).toBe('First')
      expect(approvals[1].reason).toBe('Second')
    })

    it('should not return approvals for different skills', () => {
      repo.recordApproval({
        skillId: 'quarantine-111',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-222',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
      })

      const approvals = repo.getApprovals('quarantine-111')
      expect(approvals).toHaveLength(1)
      expect(approvals[0].skillId).toBe('quarantine-111')
    })
  })

  describe('getPendingApprovals', () => {
    it('should only return non-complete approvals', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
      })

      // Mark as complete
      repo.markComplete('quarantine-123')

      const pending = repo.getPendingApprovals('quarantine-123')
      expect(pending).toHaveLength(0)

      // All approvals (including complete) should still be retrievable
      const all = repo.getApprovals('quarantine-123')
      expect(all).toHaveLength(2)
    })
  })

  // ==========================================================================
  // Reviewer Uniqueness
  // ==========================================================================

  describe('hasReviewerApproved', () => {
    it('should return false for unknown reviewer', () => {
      expect(repo.hasReviewerApproved('quarantine-123', 'user-unknown')).toBe(false)
    })

    it('should return true for existing reviewer', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-456',
        reviewerEmail: 'reviewer@example.com',
        decision: 'approved',
      })

      expect(repo.hasReviewerApproved('quarantine-123', 'user-456')).toBe(true)
    })

    it('should return false after approvals are cleared', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-456',
        reviewerEmail: 'reviewer@example.com',
        decision: 'approved',
      })

      repo.clearApprovals('quarantine-123')

      expect(repo.hasReviewerApproved('quarantine-123', 'user-456')).toBe(false)
    })

    it('should scope check to specific skill', () => {
      repo.recordApproval({
        skillId: 'quarantine-111',
        reviewerId: 'user-456',
        reviewerEmail: 'reviewer@example.com',
        decision: 'approved',
      })

      expect(repo.hasReviewerApproved('quarantine-111', 'user-456')).toBe(true)
      expect(repo.hasReviewerApproved('quarantine-222', 'user-456')).toBe(false)
    })
  })

  // ==========================================================================
  // Completion Detection
  // ==========================================================================

  describe('isComplete', () => {
    it('should return false with zero approvals', () => {
      expect(repo.isComplete('quarantine-123')).toBe(false)
    })

    it('should return false with one approval (default requires 2)', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      expect(repo.isComplete('quarantine-123')).toBe(false)
    })

    it('should return true when required count is reached', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
      })

      expect(repo.isComplete('quarantine-123')).toBe(true)
    })

    it('should respect custom required count', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
      })

      // With required count of 3, should not be complete
      expect(repo.isComplete('quarantine-123', 3)).toBe(false)
    })

    it('should only count approved decisions, not rejected', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'rejected',
      })

      expect(repo.isComplete('quarantine-123')).toBe(false)
    })
  })

  // ==========================================================================
  // Marking Complete
  // ==========================================================================

  describe('markComplete', () => {
    it('should mark pending approvals as complete', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
      })

      const updated = repo.markComplete('quarantine-123')
      expect(updated).toBe(2)

      const approvals = repo.getApprovals('quarantine-123')
      expect(approvals.every((a) => a.isComplete)).toBe(true)
    })

    it('should return 0 for unknown skill', () => {
      const updated = repo.markComplete('nonexistent')
      expect(updated).toBe(0)
    })
  })

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  describe('clearApprovals', () => {
    it('should delete all approvals for a skill', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
      })

      const deleted = repo.clearApprovals('quarantine-123')
      expect(deleted).toBe(2)

      const approvals = repo.getApprovals('quarantine-123')
      expect(approvals).toHaveLength(0)
    })

    it('should not affect other skills', () => {
      repo.recordApproval({
        skillId: 'quarantine-111',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-222',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
      })

      repo.clearApprovals('quarantine-111')

      expect(repo.getApprovals('quarantine-111')).toHaveLength(0)
      expect(repo.getApprovals('quarantine-222')).toHaveLength(1)
    })

    it('should return 0 for unknown skill', () => {
      const deleted = repo.clearApprovals('nonexistent')
      expect(deleted).toBe(0)
    })
  })

  // ==========================================================================
  // Workflow Start Time
  // ==========================================================================

  describe('getWorkflowStartTime', () => {
    it('should return null for unknown skill', () => {
      expect(repo.getWorkflowStartTime('nonexistent')).toBeNull()
    })

    it('should return earliest pending approval time', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      const startTime = repo.getWorkflowStartTime('quarantine-123')
      expect(startTime).toBeDefined()
      expect(startTime).not.toBeNull()
    })

    it('should return null after approvals are cleared', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.clearApprovals('quarantine-123')

      expect(repo.getWorkflowStartTime('quarantine-123')).toBeNull()
    })
  })

  // ==========================================================================
  // Pending Approval Count
  // ==========================================================================

  describe('getPendingApprovalCount', () => {
    it('should return 0 for unknown skill', () => {
      expect(repo.getPendingApprovalCount('nonexistent')).toBe(0)
    })

    it('should count only approved pending entries', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'rejected',
      })

      expect(repo.getPendingApprovalCount('quarantine-123')).toBe(1)
    })

    it('should not count completed approvals', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.markComplete('quarantine-123')

      expect(repo.getPendingApprovalCount('quarantine-123')).toBe(0)
    })
  })

  // ==========================================================================
  // Duplicate Reviewer Enforcement (unique index)
  // ==========================================================================

  describe('duplicate reviewer enforcement', () => {
    it('should reject duplicate reviewer for same pending skill', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      expect(() =>
        repo.recordApproval({
          skillId: 'quarantine-123',
          reviewerId: 'user-1',
          reviewerEmail: 'reviewer1@example.com',
          decision: 'approved',
        })
      ).toThrow() // UNIQUE constraint violation
    })

    it('should allow same reviewer after previous round is completed', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      // Complete the first round
      repo.markComplete('quarantine-123')

      // Same reviewer can now approve in a new round
      const entry = repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      expect(entry.reviewerId).toBe('user-1')
    })

    it('should allow same reviewer for different skills', () => {
      repo.recordApproval({
        skillId: 'quarantine-111',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      // Different skill, same reviewer — should work
      const entry = repo.recordApproval({
        skillId: 'quarantine-222',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      expect(entry.skillId).toBe('quarantine-222')
    })
  })

  // ==========================================================================
  // Completed At Timestamp
  // ==========================================================================

  describe('completedAt timestamp', () => {
    it('should be null for pending approvals', () => {
      const entry = repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      expect(entry.completedAt).toBeNull()
    })

    it('should be set when markComplete is called', () => {
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      repo.markComplete('quarantine-123')

      const approvals = repo.getApprovals('quarantine-123')
      expect(approvals[0].completedAt).toBeDefined()
      expect(approvals[0].completedAt).not.toBeNull()
    })
  })

  // ==========================================================================
  // Persistence (simulates restart)
  // ==========================================================================

  describe('persistence across instances', () => {
    it('should retain approvals when a new repository is created', () => {
      // First "session" - record an approval
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      // Simulate service restart: create new repository from same db
      const repo2 = new ApprovalRepository(db)

      const approvals = repo2.getApprovals('quarantine-123')
      expect(approvals).toHaveLength(1)
      expect(approvals[0].reviewerId).toBe('user-1')
    })

    it('should allow completing multi-approval across instances', () => {
      // First reviewer approves
      repo.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-1',
        reviewerEmail: 'reviewer1@example.com',
        decision: 'approved',
      })

      // Simulate restart
      const repo2 = new ApprovalRepository(db)

      // Second reviewer approves in new instance
      repo2.recordApproval({
        skillId: 'quarantine-123',
        reviewerId: 'user-2',
        reviewerEmail: 'reviewer2@example.com',
        decision: 'approved',
      })

      expect(repo2.isComplete('quarantine-123')).toBe(true)
    })
  })
})
