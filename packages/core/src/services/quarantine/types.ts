/**
 * SMI-2269: Quarantine Service Types
 *
 * Authentication and authorization types for quarantine review operations.
 * Part of QUA-002 security fix: No authentication on quarantine review.
 *
 * @module @skillsmith/core/services/quarantine/types
 */

import type { QuarantineSeverity, QuarantineReviewStatus } from '../../db/quarantine-schema.js'

// ============================================================================
// Authentication Types
// ============================================================================

/**
 * User permissions for quarantine operations
 */
export type QuarantinePermission =
  | 'quarantine:read'
  | 'quarantine:create'
  | 'quarantine:review'
  | 'quarantine:review_malicious'
  | 'quarantine:delete'
  | 'quarantine:admin'

/**
 * Authenticated session for quarantine operations
 *
 * All quarantine review operations require a valid session with
 * appropriate permissions. This ensures audit trails contain
 * verified reviewer identities.
 */
export interface AuthenticatedSession {
  /** Unique user identifier (from auth provider) */
  userId: string

  /** User's email address (verified) */
  email: string

  /** User's display name */
  displayName: string

  /** User's assigned permissions */
  permissions: QuarantinePermission[]

  /** Session token ID for audit logging */
  sessionId: string

  /** Session expiration timestamp */
  expiresAt: Date

  /** Organization/team ID (for team-based permissions) */
  organizationId?: string
}

// ============================================================================
// Multi-Approval Types (MALICIOUS Severity)
// ============================================================================

/**
 * Approval record for multi-approval workflow
 */
export interface ApprovalRecord {
  /** Reviewer user ID */
  reviewerId: string

  /** Reviewer email */
  reviewerEmail: string

  /** Timestamp of approval */
  approvedAt: Date

  /** Optional notes from reviewer */
  notes?: string
}

/**
 * Multi-approval status for MALICIOUS severity reviews
 */
export interface MultiApprovalStatus {
  /** Quarantine entry ID */
  quarantineId: string

  /** Required number of approvals */
  requiredApprovals: number

  /** Current approvals received */
  currentApprovals: ApprovalRecord[]

  /** Whether all required approvals have been received */
  isComplete: boolean

  /** Timestamp when first approval was received */
  startedAt: Date

  /** Timestamp when approval completed (if complete) */
  completedAt?: Date
}

// ============================================================================
// Service Input/Output Types
// ============================================================================

/**
 * Input for authenticated review operation
 */
export interface AuthenticatedReviewInput {
  /** Review status decision */
  reviewStatus: QuarantineReviewStatus

  /** Optional review notes */
  reviewNotes?: string
}

/**
 * Result from authenticated review operation
 */
export interface AuthenticatedReviewResult {
  /** Whether the review was successful */
  success: boolean

  /** Whether the skill is approved for import */
  approved: boolean

  /** Skill ID that was reviewed */
  skillId: string

  /** Severity of the quarantined skill */
  severity: QuarantineSeverity

  /** Whether the skill can be imported */
  canImport: boolean

  /** Any warnings about the skill */
  warnings: string[]

  /** Verified reviewer identity */
  reviewedBy: {
    userId: string
    email: string
    displayName: string
  }

  /** For MALICIOUS severity: multi-approval status */
  multiApprovalStatus?: MultiApprovalStatus
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes for quarantine service operations
 */
export type QuarantineServiceErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'SESSION_EXPIRED'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'MULTI_APPROVAL_REQUIRED'
  | 'ALREADY_REVIEWED'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'

/**
 * Service error with typed error codes
 */
export class QuarantineServiceError extends Error {
  constructor(
    message: string,
    public readonly code: QuarantineServiceErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'QuarantineServiceError'
  }
}

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Check if session has a specific permission
 */
export function hasPermission(
  session: AuthenticatedSession,
  permission: QuarantinePermission
): boolean {
  // Admin has all permissions
  if (session.permissions.includes('quarantine:admin')) {
    return true
  }
  return session.permissions.includes(permission)
}

/**
 * Check if session is valid (not expired)
 */
export function isSessionValid(session: AuthenticatedSession): boolean {
  return session.expiresAt > new Date()
}

/**
 * Validate session and check permission
 *
 * @throws QuarantineServiceError if session is invalid or lacks permission
 */
export function requirePermission(
  session: AuthenticatedSession,
  permission: QuarantinePermission
): void {
  if (!isSessionValid(session)) {
    throw new QuarantineServiceError('Session has expired', 'SESSION_EXPIRED', {
      expiresAt: session.expiresAt.toISOString(),
    })
  }

  if (!hasPermission(session, permission)) {
    throw new QuarantineServiceError(
      `Permission denied: ${permission} required`,
      'INSUFFICIENT_PERMISSIONS',
      {
        required: permission,
        available: session.permissions,
      }
    )
  }
}
