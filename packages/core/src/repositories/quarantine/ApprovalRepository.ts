/**
 * SMI-2277: Approval Repository
 *
 * Persists multi-approval state to SQLite instead of in-memory Map.
 * This ensures pending approvals survive service restarts.
 *
 * @module @skillsmith/core/repositories/quarantine/ApprovalRepository
 */

import type { Database as DatabaseType } from '../../db/database-interface.js'
import { randomUUID } from 'crypto'
import { initializeQuarantineApprovalsSchema } from '../../db/quarantine-approvals-schema.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Database row for quarantine_approvals table
 */
export interface ApprovalRow {
  id: string
  skill_id: string
  reviewer_id: string
  reviewer_role: string
  decision: 'approved' | 'rejected'
  reason: string | null
  created_at: string
  required_approvals: number
  is_complete: number // SQLite uses 0/1 for booleans
}

/**
 * Domain object for a recorded approval
 */
export interface ApprovalEntry {
  id: string
  skillId: string
  reviewerId: string
  reviewerRole: string
  decision: 'approved' | 'rejected'
  reason: string | null
  createdAt: string
  requiredApprovals: number
  isComplete: boolean
}

/**
 * Input for recording a new approval
 */
export interface RecordApprovalInput {
  skillId: string
  reviewerId: string
  reviewerRole: string
  decision: 'approved' | 'rejected'
  reason?: string
  requiredApprovals?: number
}

// ============================================================================
// SQL Queries
// ============================================================================

const INSERT_APPROVAL_QUERY = `
  INSERT INTO quarantine_approvals (
    id, skill_id, reviewer_id, reviewer_role, decision, reason,
    created_at, required_approvals, is_complete
  )
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, 0)
`

const SELECT_BY_SKILL_ID_QUERY = `
  SELECT * FROM quarantine_approvals
  WHERE skill_id = ?
  ORDER BY created_at ASC
`

const SELECT_PENDING_BY_SKILL_ID_QUERY = `
  SELECT * FROM quarantine_approvals
  WHERE skill_id = ? AND is_complete = 0
  ORDER BY created_at ASC
`

const COUNT_PENDING_APPROVALS_QUERY = `
  SELECT COUNT(*) as count FROM quarantine_approvals
  WHERE skill_id = ? AND is_complete = 0 AND decision = 'approved'
`

const CHECK_REVIEWER_EXISTS_QUERY = `
  SELECT id FROM quarantine_approvals
  WHERE skill_id = ? AND reviewer_id = ? AND is_complete = 0
`

const MARK_COMPLETE_QUERY = `
  UPDATE quarantine_approvals
  SET is_complete = 1
  WHERE skill_id = ? AND is_complete = 0
`

const DELETE_BY_SKILL_ID_QUERY = `
  DELETE FROM quarantine_approvals WHERE skill_id = ?
`

const SELECT_FIRST_PENDING_QUERY = `
  SELECT created_at FROM quarantine_approvals
  WHERE skill_id = ? AND is_complete = 0
  ORDER BY created_at ASC
  LIMIT 1
`

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Repository for persisting multi-approval workflow state.
 *
 * Replaces the in-memory Map<string, MultiApprovalStatus> with
 * database-backed storage to survive service restarts.
 *
 * @example
 * ```typescript
 * const repo = new ApprovalRepository(db)
 *
 * // Record a reviewer's approval
 * repo.recordApproval({
 *   skillId: 'quarantine-123',
 *   reviewerId: 'user-456',
 *   reviewerRole: 'reviewer@example.com',
 *   decision: 'approved',
 *   reason: 'Code verified safe',
 * })
 *
 * // Check if enough approvals have been collected
 * const complete = repo.isComplete('quarantine-123')
 * ```
 */
export class ApprovalRepository {
  private db: DatabaseType

  constructor(db: DatabaseType) {
    this.db = db
    this.ensureTableExists()
  }

  /**
   * Ensure the quarantine_approvals table exists
   */
  private ensureTableExists(): void {
    initializeQuarantineApprovalsSchema(this.db)
  }

  /**
   * Record a new approval or rejection for a quarantine entry
   *
   * @param input - Approval details
   * @returns The created approval entry
   * @throws Error if reviewer has already submitted for this skill
   */
  recordApproval(input: RecordApprovalInput): ApprovalEntry {
    const id = randomUUID()
    const requiredApprovals = input.requiredApprovals ?? 2

    this.db
      .prepare(INSERT_APPROVAL_QUERY)
      .run(
        id,
        input.skillId,
        input.reviewerId,
        input.reviewerRole,
        input.decision,
        input.reason ?? null,
        requiredApprovals
      )

    const row = this.db
      .prepare('SELECT * FROM quarantine_approvals WHERE id = ?')
      .get(id) as ApprovalRow

    return rowToEntry(row)
  }

  /**
   * Get all approvals for a quarantine entry (both pending and complete)
   *
   * @param skillId - The quarantine entry ID
   * @returns All approval entries for this skill
   */
  getApprovals(skillId: string): ApprovalEntry[] {
    const rows = this.db.prepare(SELECT_BY_SKILL_ID_QUERY).all(skillId) as ApprovalRow[]

    return rows.map(rowToEntry)
  }

  /**
   * Get only pending (non-complete) approvals for a quarantine entry
   *
   * @param skillId - The quarantine entry ID
   * @returns Pending approval entries
   */
  getPendingApprovals(skillId: string): ApprovalEntry[] {
    const rows = this.db.prepare(SELECT_PENDING_BY_SKILL_ID_QUERY).all(skillId) as ApprovalRow[]

    return rows.map(rowToEntry)
  }

  /**
   * Check if a specific reviewer has already submitted for a skill
   *
   * @param skillId - The quarantine entry ID
   * @param reviewerId - The reviewer's user ID
   * @returns True if the reviewer already has a pending approval
   */
  hasReviewerApproved(skillId: string, reviewerId: string): boolean {
    const row = this.db.prepare(CHECK_REVIEWER_EXISTS_QUERY).get(skillId, reviewerId)

    return !!row
  }

  /**
   * Check if the required number of approvals have been reached
   *
   * @param skillId - The quarantine entry ID
   * @param requiredApprovals - Number of approvals needed (default: 2)
   * @returns True if approval count meets or exceeds required
   */
  isComplete(skillId: string, requiredApprovals: number = 2): boolean {
    const { count } = this.db.prepare(COUNT_PENDING_APPROVALS_QUERY).get(skillId) as {
      count: number
    }

    return count >= requiredApprovals
  }

  /**
   * Mark all pending approvals for a skill as complete
   *
   * @param skillId - The quarantine entry ID
   * @returns Number of rows updated
   */
  markComplete(skillId: string): number {
    const result = this.db.prepare(MARK_COMPLETE_QUERY).run(skillId)

    return result.changes
  }

  /**
   * Delete all approvals for a skill (for cleanup/reset/cancellation)
   *
   * @param skillId - The quarantine entry ID
   * @returns Number of rows deleted
   */
  clearApprovals(skillId: string): number {
    const result = this.db.prepare(DELETE_BY_SKILL_ID_QUERY).run(skillId)

    return result.changes
  }

  /**
   * Get the timestamp of the first pending approval for timeout checks
   *
   * @param skillId - The quarantine entry ID
   * @returns ISO date string of the first approval, or null if none
   */
  getWorkflowStartTime(skillId: string): string | null {
    const row = this.db.prepare(SELECT_FIRST_PENDING_QUERY).get(skillId) as
      | { created_at: string }
      | undefined

    return row?.created_at ?? null
  }

  /**
   * Get the count of pending approvals for a skill
   *
   * @param skillId - The quarantine entry ID
   * @returns Count of pending approved entries
   */
  getPendingApprovalCount(skillId: string): number {
    const { count } = this.db.prepare(COUNT_PENDING_APPROVALS_QUERY).get(skillId) as {
      count: number
    }

    return count
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a database row to a domain object
 */
function rowToEntry(row: ApprovalRow): ApprovalEntry {
  return {
    id: row.id,
    skillId: row.skill_id,
    reviewerId: row.reviewer_id,
    reviewerRole: row.reviewer_role,
    decision: row.decision,
    reason: row.reason,
    createdAt: row.created_at,
    requiredApprovals: row.required_approvals,
    isComplete: row.is_complete === 1,
  }
}
