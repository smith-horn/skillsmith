/**
 * Services Module
 *
 * Business logic services with authentication and authorization.
 *
 * @module @skillsmith/core/services
 */

// Quarantine Service (SMI-2269)
export {
  QuarantineService,
  type QuarantinePermission,
  type AuthenticatedSession,
  type ApprovalRecord,
  type MultiApprovalStatus,
  type AuthenticatedReviewInput,
  type AuthenticatedReviewResult,
  type QuarantineServiceErrorCode,
  QuarantineServiceError,
  hasPermission,
  isSessionValid,
  requirePermission,
} from './quarantine/index.js'
