/**
 * @fileoverview Multi-Approval Workflow for MALICIOUS Severity Quarantine
 * @module @skillsmith/core/services/quarantine/QuarantineService.multiapproval
 * @see SMI-2277: Persist multi-approval state to database
 * @see SMI-2741: Split from QuarantineService.ts to meet 500-line standard
 *
 * Handles the multi-approval workflow required for MALICIOUS severity skills.
 * MALICIOUS severity requires multiple independent reviewers to approve before
 * a skill can be unquarantined, preventing single-reviewer compromise.
 */

import type { QuarantineRepository } from '../../repositories/quarantine/index.js'
import type { ApprovalRepository } from '../../repositories/quarantine/ApprovalRepository.js'
import type { AuditLogger } from '../../security/AuditLogger.js'
import type {
  AuthenticatedSession,
  AuthenticatedReviewInput,
  AuthenticatedReviewResult,
  MultiApprovalStatus,
  ApprovalRecord,
} from './types.js'
import { QuarantineServiceError, requirePermission } from './types.js'

/**
 * Number of approvals required for MALICIOUS severity reviews
 */
export const MALICIOUS_APPROVAL_COUNT = 2

/**
 * Multi-approval timeout in milliseconds (24 hours)
 */
export const MULTI_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000

/**
 * Handle approval for MALICIOUS severity skills
 *
 * MALICIOUS severity requires multiple reviewers to approve
 * before a skill can be unquarantined. This prevents single
 * reviewer compromise from allowing malicious skills.
 *
 * Approval state is persisted to the database (SMI-2277) so
 * pending approvals survive service restarts.
 *
 * @param session - Authenticated session
 * @param quarantineId - Quarantine entry ID
 * @param skillId - Skill ID
 * @param input - Review input
 * @param repository - Quarantine repository
 * @param approvalRepository - Approval repository
 * @param auditLogger - Audit logger
 * @returns Review result with multi-approval status
 */
export function handleMaliciousApproval(
  session: AuthenticatedSession,
  quarantineId: string,
  skillId: string,
  input: AuthenticatedReviewInput,
  repository: QuarantineRepository,
  approvalRepository: ApprovalRepository,
  auditLogger: AuditLogger
): AuthenticatedReviewResult {
  // Require elevated permission for MALICIOUS review
  requirePermission(session, 'quarantine:review_malicious')

  // Check if this reviewer already approved (database-backed)
  if (approvalRepository.hasReviewerApproved(quarantineId, session.userId)) {
    // Retrieve existing approval for error details
    const existingApprovals = approvalRepository.getPendingApprovals(quarantineId)
    const existing = existingApprovals.find((a) => a.reviewerId === session.userId)
    throw new QuarantineServiceError('You have already approved this entry', 'ALREADY_REVIEWED', {
      quarantineId,
      previousApprovalAt: existing?.createdAt ?? 'unknown',
    })
  }

  // Check for approval timeout
  const startTime = approvalRepository.getWorkflowStartTime(quarantineId)
  if (startTime) {
    const timeSinceStart = Date.now() - new Date(startTime).getTime()
    if (timeSinceStart > MULTI_APPROVAL_TIMEOUT_MS) {
      // Capture existing approvals before clearing for audit
      const expiredApprovals = approvalRepository.getPendingApprovals(quarantineId)

      // Reset approval workflow
      approvalRepository.clearApprovals(quarantineId)

      // Log timeout event so cleared reviewer work is auditable
      auditLogger.log({
        event_type: 'quarantine_multi_approval_timeout',
        actor: 'system',
        resource: skillId,
        action: 'timeout',
        result: 'success',
        metadata: {
          quarantineId,
          timeoutMs: MULTI_APPROVAL_TIMEOUT_MS,
          expiredApprovals: expiredApprovals.map((a) => ({
            reviewerId: a.reviewerId,
            email: a.reviewerEmail,
            approvedAt: a.createdAt,
          })),
          triggeredBy: {
            userId: session.userId,
            email: session.email,
          },
        },
      })

      throw new QuarantineServiceError(
        'Multi-approval workflow timed out. Please start again.',
        'INVALID_INPUT',
        { quarantineId, timeoutMs: MULTI_APPROVAL_TIMEOUT_MS }
      )
    }
  }

  // Record this approval in the database
  approvalRepository.recordApproval({
    skillId: quarantineId,
    reviewerId: session.userId,
    reviewerEmail: session.email,
    decision: 'approved',
    reason: input.reviewNotes,
    requiredApprovals: MALICIOUS_APPROVAL_COUNT,
  })

  // Get current approval count and all pending approvals
  const pendingApprovals = approvalRepository.getPendingApprovals(quarantineId)
  const approvalCount = pendingApprovals.filter((a) => a.decision === 'approved').length

  // Build the multi-approval status from database state
  const approvalStatus = buildMultiApprovalStatus(quarantineId, pendingApprovals)

  // Log the approval
  auditLogger.log({
    event_type: 'quarantine_multi_approval',
    actor: 'reviewer',
    resource: skillId,
    action: 'approve',
    result: 'success',
    metadata: {
      quarantineId,
      approvalNumber: approvalCount,
      requiredApprovals: MALICIOUS_APPROVAL_COUNT,
      reviewer: {
        userId: session.userId,
        email: session.email,
      },
    },
  })

  // Check if we have enough approvals
  if (approvalCount >= MALICIOUS_APPROVAL_COUNT) {
    // Mark approvals as complete in database
    approvalRepository.markComplete(quarantineId)
    approvalStatus.isComplete = true
    approvalStatus.completedAt = new Date()

    // Perform the actual review
    const approverEmails = pendingApprovals
      .filter((a) => a.decision === 'approved')
      .map((a) => a.reviewerEmail)
    const reviewResult = repository.review(quarantineId, {
      reviewedBy: approverEmails.join(', '),
      reviewStatus: 'approved',
      reviewNotes: `Multi-approval complete: ${approvalCount} reviewers approved. ${input.reviewNotes || ''}`,
    })

    // Log completion
    auditLogger.log({
      event_type: 'quarantine_multi_approval_complete',
      actor: 'reviewer',
      resource: skillId,
      action: 'complete',
      result: 'success',
      metadata: {
        quarantineId,
        approvals: pendingApprovals
          .filter((a) => a.decision === 'approved')
          .map((a) => ({
            reviewerId: a.reviewerId,
            email: a.reviewerEmail,
            approvedAt: a.createdAt,
          })),
      },
    })

    return {
      success: true,
      approved: true,
      skillId,
      severity: 'MALICIOUS',
      canImport: reviewResult?.canImport ?? false,
      warnings: [
        'MALICIOUS skill approved through multi-approval workflow',
        `Approved by: ${approverEmails.join(', ')}`,
      ],
      reviewedBy: {
        userId: session.userId,
        email: session.email,
        displayName: session.displayName,
      },
      multiApprovalStatus: approvalStatus,
    }
  }

  // Need more approvals
  return {
    success: true,
    approved: false,
    skillId,
    severity: 'MALICIOUS',
    canImport: false,
    warnings: [
      `Multi-approval in progress: ${approvalCount}/${MALICIOUS_APPROVAL_COUNT} approvals received`,
      `Requires ${MALICIOUS_APPROVAL_COUNT - approvalCount} more approval(s)`,
    ],
    reviewedBy: {
      userId: session.userId,
      email: session.email,
      displayName: session.displayName,
    },
    multiApprovalStatus: approvalStatus,
  }
}

/**
 * Build a MultiApprovalStatus from database rows
 *
 * Converts persisted approval entries into the MultiApprovalStatus
 * interface expected by consumers.
 */
export function buildMultiApprovalStatus(
  quarantineId: string,
  approvals: Array<{
    reviewerId: string
    reviewerEmail: string
    createdAt: string
    completedAt: string | null
    reason: string | null
    isComplete: boolean
  }>
): MultiApprovalStatus {
  const currentApprovals: ApprovalRecord[] = approvals.map((a) => ({
    reviewerId: a.reviewerId,
    reviewerEmail: a.reviewerEmail,
    approvedAt: new Date(a.createdAt),
    notes: a.reason ?? undefined,
  }))

  const startedAt = approvals.length > 0 ? new Date(approvals[0].createdAt) : new Date()
  const isComplete = approvals.some((a) => a.isComplete)
  const completedEntry = approvals.find((a) => a.completedAt)

  return {
    quarantineId,
    requiredApprovals: MALICIOUS_APPROVAL_COUNT,
    currentApprovals,
    isComplete,
    startedAt,
    completedAt: completedEntry ? new Date(completedEntry.completedAt!) : undefined,
  }
}
