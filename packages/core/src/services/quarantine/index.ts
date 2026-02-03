/**
 * SMI-2269: Quarantine Service Module
 *
 * Authenticated quarantine operations with multi-approval workflow.
 *
 * @module @skillsmith/core/services/quarantine
 */

export { QuarantineService } from './QuarantineService.js'
export {
  // Types
  type QuarantinePermission,
  type AuthenticatedSession,
  type ApprovalRecord,
  type MultiApprovalStatus,
  type AuthenticatedReviewInput,
  type AuthenticatedReviewResult,
  type QuarantineServiceErrorCode,
  // Error class
  QuarantineServiceError,
  // Helper functions
  hasPermission,
  isSessionValid,
  requirePermission,
} from './types.js'
