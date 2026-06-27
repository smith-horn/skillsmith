/**
 * SMI-5358: QuarantineService Concurrency / Race Tests
 *
 * Existing coverage (QuarantineService.test.ts) only exercises single, strictly
 * sequential reviews. These tests model OVERLAPPING reviewer/writer operations
 * against the SAME quarantine entry and assert the concurrency invariants that
 * protect against lost updates and illegal state transitions:
 *
 *   1. Two reviewers racing to decide one SUSPICIOUS entry (approve vs reject)
 *      -> exactly one wins, the loser is rejected as ALREADY_REVIEWED, and the
 *         persisted DB state reflects the winner's decision (no lost update).
 *   2. A stale-snapshot ("optimistic version") writer whose read predates another
 *      reviewer's decision -> the stale write is rejected, persisted state is
 *      unchanged from the winner.
 *   3. MALICIOUS double-approval by the SAME reviewer -> the second is rejected,
 *      only one approval row exists, and the entry does NOT illegally transition.
 *   4. MALICIOUS approval by two DISTINCT reviewers reaching the required count
 *      -> the entry transitions to approved EXACTLY once with exactly two
 *         approval rows (no double-count, no double-transition).
 *
 * HONESTY NOTE: better-sqlite3 is fully SYNCHRONOUS, so genuine OS-thread
 * interleaving is not achievable in-process. `Promise.all` / `Promise.allSettled`
 * here schedule each synchronous `service.review()` as a microtask; each call
 * therefore runs to completion atomically rather than truly interleaving. We are
 * NOT faking parallelism. What we test is the REAL concurrency invariant: the
 * read-then-act guard (`reviewStatus !== 'pending'`), the per-reviewer guard
 * (`hasReviewerApproved`), and the approval-count check are what prevent lost
 * updates / illegal transitions when overlapping operations target the same
 * entry. All assertions read the PERSISTED DB state after the race, never a mock
 * return value. Removing any of those guards makes the persisted state
 * inconsistent and fails these tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { QuarantineService } from '../../src/services/quarantine/QuarantineService.js'
import { QuarantineServiceError } from '../../src/services/quarantine/types.js'
import type {
  AuthenticatedSession,
  AuthenticatedReviewResult,
} from '../../src/services/quarantine/types.js'
import { QuarantineRepository } from '../../src/repositories/quarantine/index.js'
import { ApprovalRepository } from '../../src/repositories/quarantine/index.js'
import { AuditLogger } from '../../src/security/AuditLogger.js'
import { createDatabaseSync } from '../../src/db/createDatabase.js'
import type { Database } from '../../src/db/database-interface.js'

// ============================================================================
// Test Helpers
// ============================================================================

const REVIEW_PERMS: AuthenticatedSession['permissions'] = ['quarantine:read', 'quarantine:review']

const MALICIOUS_PERMS: AuthenticatedSession['permissions'] = [
  'quarantine:read',
  'quarantine:review',
  'quarantine:review_malicious',
]

function makeSession(overrides: Partial<AuthenticatedSession> = {}): AuthenticatedSession {
  return {
    userId: 'user-123',
    email: 'reviewer@example.com',
    displayName: 'Test Reviewer',
    permissions: REVIEW_PERMS,
    sessionId: 'session-456',
    expiresAt: new Date(Date.now() + 3600000),
    ...overrides,
  }
}

/** Run `fn` on a fresh microtask so overlapping calls are scheduled together. */
function defer<T>(fn: () => T): Promise<T> {
  return Promise.resolve().then(fn)
}

function fulfilled<T>(results: PromiseSettledResult<T>[]): PromiseFulfilledResult<T>[] {
  return results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled')
}

function rejectedWith(results: PromiseSettledResult<unknown>[]): PromiseRejectedResult[] {
  return results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
}

// ============================================================================
// Test Suite
// ============================================================================

describe('SMI-5358: QuarantineService concurrency / race invariants', () => {
  let db: Database
  let repository: QuarantineRepository
  let approvalRepository: ApprovalRepository
  let auditLogger: AuditLogger
  let service: QuarantineService

  beforeEach(() => {
    db = createDatabaseSync(':memory:')
    auditLogger = new AuditLogger(db)
    repository = new QuarantineRepository(db, auditLogger)
    approvalRepository = new ApprovalRepository(db)
    service = new QuarantineService(repository, approvalRepository, auditLogger)
  })

  afterEach(() => {
    db.close()
  })

  // ==========================================================================
  // SUSPICIOUS: approve vs reject race on the same entry
  // ==========================================================================

  describe('SUSPICIOUS approve-vs-reject race', () => {
    it('lets exactly one reviewer win; the loser is rejected ALREADY_REVIEWED and no update is lost', async () => {
      const approver = makeSession({ userId: 'user-approve', email: 'approve@example.com' })
      const rejecter = makeSession({ userId: 'user-reject', email: 'reject@example.com' })

      const entry = repository.create({
        skillId: 'test/race-skill',
        source: 'test',
        quarantineReason: 'Overlapping reviews',
        severity: 'SUSPICIOUS',
      })

      const results = await Promise.allSettled([
        defer(() =>
          service.review(approver, entry.id, {
            reviewStatus: 'approved',
            reviewNotes: 'approve path',
          })
        ),
        defer(() =>
          service.review(rejecter, entry.id, {
            reviewStatus: 'rejected',
            reviewNotes: 'reject path',
          })
        ),
      ])

      const winners = fulfilled<AuthenticatedReviewResult>(results)
      const losers = rejectedWith(results)

      // Exactly one decision succeeds, exactly one is blocked.
      expect(winners.length).toBe(1)
      expect(losers.length).toBe(1)
      expect(losers[0].reason).toBeInstanceOf(QuarantineServiceError)
      expect((losers[0].reason as QuarantineServiceError).code).toBe('ALREADY_REVIEWED')

      // Persisted state reflects the WINNER, not a half-written / overwritten row.
      const persisted = repository.findById(entry.id)
      expect(persisted).not.toBeNull()
      expect(persisted!.reviewStatus).not.toBe('pending')

      const winner = winners[0].value
      if (winner.approved) {
        expect(persisted!.reviewStatus).toBe('approved')
        expect(persisted!.reviewedBy).toBe(approver.email)
      } else {
        expect(persisted!.reviewStatus).toBe('rejected')
        expect(persisted!.reviewedBy).toBe(rejecter.email)
      }
    })

    it('rejects a stale-snapshot writer whose read predates the winning decision (no lost update)', () => {
      const winner = makeSession({ userId: 'user-winner', email: 'winner@example.com' })
      const staleWriter = makeSession({ userId: 'user-stale', email: 'stale@example.com' })

      const entry = repository.create({
        skillId: 'test/stale-skill',
        source: 'test',
        quarantineReason: 'Stale snapshot write',
        severity: 'SUSPICIOUS',
      })

      // staleWriter captures a snapshot while the entry is still pending.
      const snapshot = service.findById(staleWriter, entry.id)
      expect(snapshot).not.toBeNull()
      expect(snapshot!.reviewStatus).toBe('pending')

      // winner commits a decision first.
      service.review(winner, entry.id, {
        reviewStatus: 'approved',
        reviewNotes: 'committed first',
      })

      // staleWriter now tries to write based on its stale (pending) view.
      expect(() =>
        service.review(staleWriter, entry.id, {
          reviewStatus: 'rejected',
          reviewNotes: 'based on stale read',
        })
      ).toThrow(QuarantineServiceError)

      // The winner's decision survives untouched: the stale reject did not overwrite it.
      const persisted = repository.findById(entry.id)
      expect(persisted!.reviewStatus).toBe('approved')
      expect(persisted!.reviewedBy).toBe(winner.email)
    })
  })

  // ==========================================================================
  // MALICIOUS: same-reviewer double-approval (per-reviewer guard)
  // ==========================================================================

  describe('MALICIOUS same-reviewer double-approval', () => {
    it('does not double-count or illegally transition when one reviewer approves twice', async () => {
      const reviewer = makeSession({
        userId: 'user-dup',
        email: 'dup@example.com',
        permissions: MALICIOUS_PERMS,
      })

      const entry = repository.create({
        skillId: 'test/malicious-dup',
        source: 'test',
        quarantineReason: 'Malicious code detected',
        severity: 'MALICIOUS',
      })

      const results = await Promise.allSettled([
        defer(() =>
          service.review(reviewer, entry.id, {
            reviewStatus: 'approved',
            reviewNotes: 'first',
          })
        ),
        defer(() =>
          service.review(reviewer, entry.id, {
            reviewStatus: 'approved',
            reviewNotes: 'second (duplicate)',
          })
        ),
      ])

      const winners = fulfilled<AuthenticatedReviewResult>(results)
      const losers = rejectedWith(results)

      // One approval recorded, the duplicate rejected.
      expect(winners.length).toBe(1)
      expect(losers.length).toBe(1)
      expect((losers[0].reason as QuarantineServiceError).code).toBe('ALREADY_REVIEWED')

      // The single accepted approval did NOT complete the workflow.
      expect(winners[0].value.approved).toBe(false)

      // Persisted: exactly ONE approval row, and the entry stays pending.
      const pending = approvalRepository.getPendingApprovals(entry.id)
      expect(pending.length).toBe(1)
      expect(pending[0].reviewerId).toBe('user-dup')

      const persisted = repository.findById(entry.id)
      expect(persisted!.reviewStatus).toBe('pending')
      expect(persisted!.reviewedBy).toBeNull()
    })
  })

  // ==========================================================================
  // MALICIOUS: two distinct reviewers reaching the required count
  // ==========================================================================

  describe('MALICIOUS two-reviewer approval completion', () => {
    it('transitions to approved exactly once with exactly two approval rows (no double-count)', async () => {
      const reviewerA = makeSession({
        userId: 'user-A',
        email: 'a@example.com',
        permissions: MALICIOUS_PERMS,
      })
      const reviewerB = makeSession({
        userId: 'user-B',
        email: 'b@example.com',
        permissions: MALICIOUS_PERMS,
      })

      const entry = repository.create({
        skillId: 'test/malicious-two',
        source: 'test',
        quarantineReason: 'Malicious code detected',
        severity: 'MALICIOUS',
      })

      const results = await Promise.allSettled([
        defer(() =>
          service.review(reviewerA, entry.id, {
            reviewStatus: 'approved',
            reviewNotes: 'approval A',
          })
        ),
        defer(() =>
          service.review(reviewerB, entry.id, {
            reviewStatus: 'approved',
            reviewNotes: 'approval B',
          })
        ),
      ])

      const winners = fulfilled<AuthenticatedReviewResult>(results)

      // Both distinct reviewers are accepted.
      expect(winners.length).toBe(2)

      // Exactly ONE result reports completion (approved), the other in-progress.
      const completed = winners.filter((r) => r.value.approved === true)
      const inProgress = winners.filter((r) => r.value.approved === false)
      expect(completed.length).toBe(1)
      expect(inProgress.length).toBe(1)

      // Persisted: exactly two approval rows, both approvals, all marked complete.
      const allApprovals = approvalRepository.getApprovals(entry.id)
      expect(allApprovals.length).toBe(2)
      expect(allApprovals.filter((a) => a.decision === 'approved').length).toBe(2)
      expect(allApprovals.every((a) => a.isComplete)).toBe(true)
      const reviewerIds = allApprovals.map((a) => a.reviewerId).sort()
      expect(reviewerIds).toEqual(['user-A', 'user-B'])

      // No pending approvals remain, and the entry transitioned to approved once.
      expect(approvalRepository.getPendingApprovals(entry.id).length).toBe(0)
      const persisted = repository.findById(entry.id)
      expect(persisted!.reviewStatus).toBe('approved')
    })

    it('keeps the entry pending after a single approval (count guard holds)', () => {
      const reviewerA = makeSession({
        userId: 'user-solo',
        email: 'solo@example.com',
        permissions: MALICIOUS_PERMS,
      })

      const entry = repository.create({
        skillId: 'test/malicious-solo',
        source: 'test',
        quarantineReason: 'Malicious code detected',
        severity: 'MALICIOUS',
      })

      const result = service.review(reviewerA, entry.id, {
        reviewStatus: 'approved',
        reviewNotes: 'only approval',
      })

      // A single approval must NOT unilaterally unquarantine a MALICIOUS skill.
      expect(result.approved).toBe(false)
      const persisted = repository.findById(entry.id)
      expect(persisted!.reviewStatus).toBe('pending')
      expect(approvalRepository.getPendingApprovals(entry.id).length).toBe(1)
    })
  })
})
