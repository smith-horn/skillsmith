/**
 * SMI-865: Quarantine Repository Types
 *
 * Type definitions for quarantine management.
 *
 * Severity Categories:
 * - MALICIOUS: Permanent quarantine, security threat detected
 * - SUSPICIOUS: Manual review required before import
 * - RISKY: Can import with warnings displayed
 * - LOW_QUALITY: Can import with reduced quality score
 */

import type { QuarantineSeverity, QuarantineReviewStatus } from '../../db/quarantine-schema.js'

/**
 * Database row type for quarantine entries
 */
export interface QuarantineRow {
  id: string
  skill_id: string
  source: string
  quarantine_reason: string
  severity: QuarantineSeverity
  detected_patterns: string
  quarantine_date: string
  reviewed_by: string | null
  review_status: QuarantineReviewStatus
  review_notes: string | null
  review_date: string | null
  created_at: string
  updated_at: string
}

/**
 * Quarantine entry structure
 */
export interface QuarantineEntry {
  id: string
  skillId: string
  source: string
  quarantineReason: string
  severity: QuarantineSeverity
  detectedPatterns: string[]
  quarantineDate: string
  reviewedBy: string | null
  reviewStatus: QuarantineReviewStatus
  reviewNotes: string | null
  reviewDate: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Input for creating a quarantine entry
 */
export interface QuarantineCreateInput {
  id?: string
  skillId: string
  source: string
  quarantineReason: string
  severity: QuarantineSeverity
  detectedPatterns?: string[]
}

/**
 * Input for updating a quarantine entry
 */
export interface QuarantineUpdateInput {
  quarantineReason?: string
  severity?: QuarantineSeverity
  detectedPatterns?: string[]
  reviewedBy?: string
  reviewStatus?: QuarantineReviewStatus
  reviewNotes?: string
}

/**
 * Query filters for quarantine entries
 */
export interface QuarantineQueryFilter {
  skillId?: string
  source?: string
  severity?: QuarantineSeverity
  reviewStatus?: QuarantineReviewStatus
  reviewedBy?: string
  since?: Date
  until?: Date
  limit?: number
  offset?: number
}

/**
 * Paginated results for quarantine queries
 */
export interface PaginatedQuarantineResults {
  items: QuarantineEntry[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

/**
 * Quarantine statistics
 */
export interface QuarantineStats {
  total: number
  bySeverity: Record<QuarantineSeverity, number>
  byStatus: Record<QuarantineReviewStatus, number>
  pendingReview: number
  oldestEntry: string | null
  newestEntry: string | null
}

/**
 * Review decision result
 */
export interface ReviewDecision {
  approved: boolean
  skillId: string
  severity: QuarantineSeverity
  canImport: boolean
  warnings: string[]
}

/**
 * Prepared statement types for database operations
 */
export interface PreparedStatements {
  insert: { run: (...args: unknown[]) => { changes: number } }
  selectById: { get: (id: string) => QuarantineRow | undefined }
  selectBySkillId: { all: (skillId: string) => QuarantineRow[] }
  selectAll: { all: (limit: number, offset: number) => QuarantineRow[] }
  selectCount: { get: () => { count: number } }
  update: { run: (...args: unknown[]) => { changes: number } }
  delete: { run: (id: string) => { changes: number } }
  deleteBySkillId: { run: (skillId: string) => { changes: number } }
}
