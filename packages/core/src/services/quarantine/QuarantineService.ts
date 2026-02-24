/**
 * SMI-2269: Quarantine Service with Authentication
 * SMI-2277: Persist multi-approval state to database
 * @see SMI-2741: Multi-approval workflow split to QuarantineService.multiapproval.ts
 *
 * Service layer for quarantine operations that enforces authentication
 * and authorization. Wraps QuarantineRepository with security controls.
 *
 * VP Engineering Guidance:
 * - Auth belongs in service/handler layer, not repository
 * - Repositories should be pure data access
 *
 * Security Controls:
 * - QUA-002: Requires authenticated session for review operations
 * - Enforces security_reviewer permission for review access
 * - Multi-approval workflow for MALICIOUS severity
 * - Audit logs include verified reviewer identity
 * - Approval state persisted to database (survives restarts)
 *
 * @module @skillsmith/core/services/quarantine/QuarantineService
 */

import type { QuarantineRepository } from '../../repositories/quarantine/index.js'
import type { ApprovalRepository } from '../../repositories/quarantine/ApprovalRepository.js'
import type { AuditLogger } from '../../security/AuditLogger.js'
import type {
  AuthenticatedSession,
  AuthenticatedReviewInput,
  AuthenticatedReviewResult,
  MultiApprovalStatus,
} from './types.js'
import { QuarantineServiceError, requirePermission } from './types.js'
import {
  handleMaliciousApproval,
  buildMultiApprovalStatus,
} from './QuarantineService.multiapproval.js'

// Re-export multi-approval functions for public API
export {
  handleMaliciousApproval,
  buildMultiApprovalStatus,
} from './QuarantineService.multiapproval.js'
export {
  MALICIOUS_APPROVAL_COUNT,
  MULTI_APPROVAL_TIMEOUT_MS,
} from './QuarantineService.multiapproval.js'

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * Quarantine Service with Authentication
 *
 * Provides authenticated access to quarantine operations with:
 * - Session validation
 * - Permission checks (security_reviewer role)
 * - Multi-approval workflow for MALICIOUS severity
 * - Audit logging with verified identities
 * - Database-persisted approval state (SMI-2277)
 *
 * @example
 * ```typescript
 * const service = new QuarantineService(repository, approvalRepository, auditLogger)
 *
 * // Review a quarantined skill (requires authentication)
 * const result = await service.review(
 *   session,
 *   quarantineId,
 *   { reviewStatus: 'approved', reviewNotes: 'Verified safe' }
 * )
 * ```
 */
export class QuarantineService {
  constructor(
    private readonly repository: QuarantineRepository,
    private readonly approvalRepository: ApprovalRepository,
    private readonly auditLogger: AuditLogger
  ) {}

  // ==========================================================================
  // Read Operations (require quarantine:read permission)
  // ==========================================================================

  /**
   * Find a quarantine entry by ID
   *
   * @param session - Authenticated session
   * @param id - Quarantine entry ID
   * @returns Quarantine entry or null
   */
  findById(session: AuthenticatedSession, id: string) {
    requirePermission(session, 'quarantine:read')
    return this.repository.findById(id)
  }

  /**
   * Find quarantine entries for a skill
   *
   * @param session - Authenticated session
   * @param skillId - Skill ID
   * @returns Array of quarantine entries
   */
  findBySkillId(session: AuthenticatedSession, skillId: string) {
    requirePermission(session, 'quarantine:read')
    return this.repository.findBySkillId(skillId)
  }

  /**
   * Find all quarantine entries with optional filtering
   *
   * @param session - Authenticated session
   * @param filter - Query filters
   * @returns Paginated quarantine results
   */
  findAll(session: AuthenticatedSession, filter?: Parameters<QuarantineRepository['findAll']>[0]) {
    requirePermission(session, 'quarantine:read')
    return this.repository.findAll(filter)
  }

  /**
   * Get quarantine statistics
   *
   * @param session - Authenticated session
   * @returns Quarantine statistics
   */
  getStats(session: AuthenticatedSession) {
    requirePermission(session, 'quarantine:read')
    return this.repository.getStats()
  }

  // ==========================================================================
  // Review Operations (require quarantine:review permission)
  // ==========================================================================

  /**
   * Review a quarantine entry with authentication
   *
   * This is the secure replacement for QuarantineRepository.review().
   * It enforces:
   * - Valid authenticated session
   * - security_reviewer permission (quarantine:review)
   * - Multi-approval for MALICIOUS severity (quarantine:review_malicious)
   * - Audit logging with verified reviewer identity
   *
   * @param session - Authenticated session (verified by auth layer)
   * @param quarantineId - Quarantine entry ID to review
   * @param input - Review decision and notes
   * @returns Review result with verified reviewer identity
   * @throws QuarantineServiceError on auth/permission failure
   */
  review(
    session: AuthenticatedSession,
    quarantineId: string,
    input: AuthenticatedReviewInput
  ): AuthenticatedReviewResult {
    // Validate session and require review permission
    requirePermission(session, 'quarantine:review')

    // Get the quarantine entry
    const entry = this.repository.findById(quarantineId)
    if (!entry) {
      throw new QuarantineServiceError(`Quarantine entry not found: ${quarantineId}`, 'NOT_FOUND', {
        quarantineId,
      })
    }

    // Check if already reviewed
    if (entry.reviewStatus !== 'pending') {
      throw new QuarantineServiceError(
        `Quarantine entry already reviewed: ${entry.reviewStatus}`,
        'ALREADY_REVIEWED',
        { quarantineId, currentStatus: entry.reviewStatus }
      )
    }

    // For MALICIOUS severity, require multi-approval workflow
    if (entry.severity === 'MALICIOUS' && input.reviewStatus === 'approved') {
      return handleMaliciousApproval(
        session,
        quarantineId,
        entry.skillId,
        input,
        this.repository,
        this.approvalRepository,
        this.auditLogger
      )
    }

    // For MALICIOUS severity rejection or non-MALICIOUS, check elevated permission
    if (entry.severity === 'MALICIOUS') {
      requirePermission(session, 'quarantine:review_malicious')
    }

    // Perform the review with verified identity
    const reviewResult = this.repository.review(quarantineId, {
      reviewedBy: session.email, // Verified email from session
      reviewStatus: input.reviewStatus,
      reviewNotes: input.reviewNotes,
    })

    if (!reviewResult) {
      throw new QuarantineServiceError('Failed to review quarantine entry', 'INVALID_INPUT', {
        quarantineId,
      })
    }

    // Log audit event with full session details
    this.auditLogger.log({
      event_type: 'quarantine_authenticated_review',
      actor: 'reviewer',
      resource: entry.skillId,
      action: 'review',
      result: 'success',
      metadata: {
        quarantineId,
        reviewStatus: input.reviewStatus,
        reviewer: {
          userId: session.userId,
          email: session.email,
          displayName: session.displayName,
        },
        sessionId: session.sessionId,
        severity: entry.severity,
        canImport: reviewResult.canImport,
      },
    })

    return {
      success: true,
      approved: reviewResult.approved,
      skillId: reviewResult.skillId,
      severity: reviewResult.severity,
      canImport: reviewResult.canImport,
      warnings: reviewResult.warnings,
      reviewedBy: {
        userId: session.userId,
        email: session.email,
        displayName: session.displayName,
      },
    }
  }

  // ==========================================================================
  // Multi-Approval Status Operations
  // ==========================================================================

  /**
   * Get pending multi-approval status for a quarantine entry
   *
   * @param session - Authenticated session
   * @param quarantineId - Quarantine entry ID
   * @returns Multi-approval status or null
   */
  getMultiApprovalStatus(
    session: AuthenticatedSession,
    quarantineId: string
  ): MultiApprovalStatus | null {
    requirePermission(session, 'quarantine:read')

    const pendingApprovals = this.approvalRepository.getPendingApprovals(quarantineId)
    if (pendingApprovals.length === 0) {
      return null
    }

    return buildMultiApprovalStatus(quarantineId, pendingApprovals)
  }

  /**
   * Cancel a pending multi-approval workflow
   *
   * @param session - Authenticated session (requires admin)
   * @param quarantineId - Quarantine entry ID
   * @returns Whether the cancellation was successful
   */
  cancelMultiApproval(session: AuthenticatedSession, quarantineId: string): boolean {
    requirePermission(session, 'quarantine:admin')

    const pendingApprovals = this.approvalRepository.getPendingApprovals(quarantineId)
    if (pendingApprovals.length === 0) {
      return false
    }

    this.approvalRepository.clearApprovals(quarantineId)

    this.auditLogger.log({
      event_type: 'quarantine_multi_approval_cancelled',
      actor: 'reviewer',
      resource: quarantineId,
      action: 'cancel',
      result: 'success',
      metadata: {
        quarantineId,
        cancelledBy: session.email,
        pendingApprovals: pendingApprovals.length,
      },
    })

    return true
  }

  // ==========================================================================
  // Admin Operations (require quarantine:admin permission)
  // ==========================================================================

  /**
   * Create a quarantine entry (admin only)
   *
   * @param session - Authenticated session
   * @param input - Quarantine creation input
   * @returns Created quarantine entry
   */
  create(session: AuthenticatedSession, input: Parameters<QuarantineRepository['create']>[0]) {
    requirePermission(session, 'quarantine:create')
    return this.repository.create(input)
  }

  /**
   * Delete a quarantine entry (admin only)
   *
   * @param session - Authenticated session
   * @param id - Quarantine entry ID
   * @returns Whether the entry was deleted
   */
  delete(session: AuthenticatedSession, id: string): boolean {
    requirePermission(session, 'quarantine:delete')

    // Cancel any pending multi-approval
    this.approvalRepository.clearApprovals(id)

    return this.repository.delete(id)
  }
}
