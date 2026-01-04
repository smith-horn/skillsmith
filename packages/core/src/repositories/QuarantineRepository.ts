/**
 * SMI-865: Quarantine Repository - CRUD operations for skill quarantine management
 *
 * Provides:
 * - Create, Read, Update, Delete operations for quarantine entries
 * - Review workflow management
 * - Integration with AuditLogger for audit trail
 * - Query filtering and pagination
 *
 * Severity Categories:
 * - MALICIOUS: Permanent quarantine, security threat detected
 * - SUSPICIOUS: Manual review required before import
 * - RISKY: Can import with warnings displayed
 * - LOW_QUALITY: Can import with reduced quality score
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { QuarantineSeverity, QuarantineReviewStatus } from '../db/quarantine-schema.js'
import {
  initializeQuarantineSchema,
  QUARANTINE_SEVERITY_POLICIES,
} from '../db/quarantine-schema.js'
import type { AuditLogger } from '../security/AuditLogger.js'

/**
 * Database row type for quarantine entries
 */
interface QuarantineRow {
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
 * Repository for quarantine CRUD operations
 *
 * @example
 * ```typescript
 * const repo = new QuarantineRepository(db, auditLogger)
 *
 * // Quarantine a suspicious skill
 * const entry = repo.create({
 *   skillId: 'community/suspicious-skill',
 *   source: 'github',
 *   quarantineReason: 'Obfuscated code detected',
 *   severity: 'SUSPICIOUS',
 *   detectedPatterns: ['eval()', 'obfuscated variables']
 * })
 *
 * // Review and approve/reject
 * const decision = repo.review(entry.id, {
 *   reviewedBy: 'security-team',
 *   reviewStatus: 'approved',
 *   reviewNotes: 'Manual review confirmed safe after code analysis'
 * })
 * ```
 */
export class QuarantineRepository {
  private db: DatabaseType
  private auditLogger?: AuditLogger
  private stmts!: {
    insert: { run: (...args: unknown[]) => { changes: number } }
    selectById: { get: (id: string) => QuarantineRow | undefined }
    selectBySkillId: { all: (skillId: string) => QuarantineRow[] }
    selectAll: { all: (limit: number, offset: number) => QuarantineRow[] }
    selectCount: { get: () => { count: number } }
    update: { run: (...args: unknown[]) => { changes: number } }
    delete: { run: (id: string) => { changes: number } }
    deleteBySkillId: { run: (skillId: string) => { changes: number } }
  }

  constructor(db: DatabaseType, auditLogger?: AuditLogger) {
    this.db = db
    this.auditLogger = auditLogger
    this.ensureTableExists()
    this.prepareStatements()
  }

  /**
   * Ensure the quarantine table exists
   */
  private ensureTableExists(): void {
    initializeQuarantineSchema(this.db)
  }

  /**
   * Prepare SQL statements for performance
   */
  private prepareStatements(): void {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO quarantine (
          id, skill_id, source, quarantine_reason, severity,
          detected_patterns, quarantine_date, reviewed_by, review_status,
          review_notes, review_date, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, datetime('now'), datetime('now'))
      `) as unknown as typeof this.stmts.insert,

      selectById: this.db.prepare(`
        SELECT * FROM quarantine WHERE id = ?
      `) as unknown as typeof this.stmts.selectById,

      selectBySkillId: this.db.prepare(`
        SELECT * FROM quarantine WHERE skill_id = ? ORDER BY quarantine_date DESC
      `) as unknown as typeof this.stmts.selectBySkillId,

      selectAll: this.db.prepare(`
        SELECT * FROM quarantine ORDER BY quarantine_date DESC LIMIT ? OFFSET ?
      `) as unknown as typeof this.stmts.selectAll,

      selectCount: this.db.prepare(`
        SELECT COUNT(*) as count FROM quarantine
      `) as unknown as typeof this.stmts.selectCount,

      update: this.db.prepare(`
        UPDATE quarantine SET
          quarantine_reason = COALESCE(?, quarantine_reason),
          severity = COALESCE(?, severity),
          detected_patterns = COALESCE(?, detected_patterns),
          reviewed_by = COALESCE(?, reviewed_by),
          review_status = COALESCE(?, review_status),
          review_notes = COALESCE(?, review_notes),
          review_date = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE review_date END,
          updated_at = datetime('now')
        WHERE id = ?
      `) as unknown as typeof this.stmts.update,

      delete: this.db.prepare(`
        DELETE FROM quarantine WHERE id = ?
      `) as unknown as typeof this.stmts.delete,

      deleteBySkillId: this.db.prepare(`
        DELETE FROM quarantine WHERE skill_id = ?
      `) as unknown as typeof this.stmts.deleteBySkillId,
    }
  }

  /**
   * Convert a database row to a QuarantineEntry object
   */
  private rowToEntry(row: QuarantineRow): QuarantineEntry {
    return {
      id: row.id,
      skillId: row.skill_id,
      source: row.source,
      quarantineReason: row.quarantine_reason,
      severity: row.severity,
      detectedPatterns: JSON.parse(row.detected_patterns || '[]'),
      quarantineDate: row.quarantine_date,
      reviewedBy: row.reviewed_by,
      reviewStatus: row.review_status,
      reviewNotes: row.review_notes,
      reviewDate: row.review_date,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Log audit event if AuditLogger is available
   */
  private logAudit(
    action: string,
    resource: string,
    result: 'success' | 'blocked' | 'error' | 'warning',
    metadata?: Record<string, unknown>
  ): void {
    if (this.auditLogger) {
      this.auditLogger.log({
        event_type: 'security_scan',
        actor: 'system',
        resource,
        action,
        result,
        metadata,
      })
    }
  }

  /**
   * Create a new quarantine entry
   *
   * @param input - Quarantine entry data
   * @returns Created quarantine entry
   */
  create(input: QuarantineCreateInput): QuarantineEntry {
    const id = input.id || randomUUID()
    const patterns = JSON.stringify(input.detectedPatterns || [])

    this.stmts.insert.run(
      id,
      input.skillId,
      input.source,
      input.quarantineReason,
      input.severity,
      patterns,
      null, // reviewed_by
      'pending', // review_status
      null, // review_notes
      null // review_date
    )

    this.logAudit('quarantine_create', input.skillId, 'success', {
      quarantineId: id,
      severity: input.severity,
      reason: input.quarantineReason,
      patterns: input.detectedPatterns,
    })

    const row = this.stmts.selectById.get(id) as QuarantineRow
    return this.rowToEntry(row)
  }

  /**
   * Find a quarantine entry by ID
   *
   * @param id - Quarantine entry ID
   * @returns Quarantine entry or null if not found
   */
  findById(id: string): QuarantineEntry | null {
    const row = this.stmts.selectById.get(id) as QuarantineRow | undefined
    return row ? this.rowToEntry(row) : null
  }

  /**
   * Find all quarantine entries for a skill
   *
   * @param skillId - Skill ID
   * @returns Array of quarantine entries
   */
  findBySkillId(skillId: string): QuarantineEntry[] {
    const rows = this.stmts.selectBySkillId.all(skillId) as QuarantineRow[]
    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Check if a skill is quarantined
   *
   * @param skillId - Skill ID
   * @returns True if skill has any pending quarantine entries
   */
  isQuarantined(skillId: string): boolean {
    const entries = this.findBySkillId(skillId)
    return entries.some((e) => e.reviewStatus === 'pending' || e.reviewStatus === 'rejected')
  }

  /**
   * Get the most severe quarantine entry for a skill
   *
   * @param skillId - Skill ID
   * @returns Most severe quarantine entry or null
   */
  getMostSevere(skillId: string): QuarantineEntry | null {
    const entries = this.findBySkillId(skillId).filter((e) => e.reviewStatus !== 'approved')
    if (entries.length === 0) return null

    return entries.sort((a, b) => {
      const aLevel = QUARANTINE_SEVERITY_POLICIES[a.severity].level
      const bLevel = QUARANTINE_SEVERITY_POLICIES[b.severity].level
      return bLevel - aLevel
    })[0]
  }

  /**
   * Find all quarantine entries with pagination
   *
   * @param options - Pagination options
   * @returns Paginated quarantine results
   */
  findAll(options: { limit?: number; offset?: number } = {}): PaginatedQuarantineResults {
    const limit = options.limit ?? 20
    const offset = options.offset ?? 0

    const rows = this.stmts.selectAll.all(limit, offset) as QuarantineRow[]
    const { count } = this.stmts.selectCount.get() as { count: number }

    return {
      items: rows.map((row) => this.rowToEntry(row)),
      total: count,
      limit,
      offset,
      hasMore: offset + rows.length < count,
    }
  }

  /**
   * Query quarantine entries with filters
   *
   * @param filter - Query filters
   * @returns Paginated quarantine results
   */
  query(filter: QuarantineQueryFilter): PaginatedQuarantineResults {
    const {
      skillId,
      source,
      severity,
      reviewStatus,
      reviewedBy,
      since,
      until,
      limit = 20,
      offset = 0,
    } = filter

    // Build dynamic query
    let query = 'SELECT * FROM quarantine WHERE 1=1'
    let countQuery = 'SELECT COUNT(*) as count FROM quarantine WHERE 1=1'
    const params: unknown[] = []
    const countParams: unknown[] = []

    if (skillId) {
      query += ' AND skill_id = ?'
      countQuery += ' AND skill_id = ?'
      params.push(skillId)
      countParams.push(skillId)
    }

    if (source) {
      query += ' AND source = ?'
      countQuery += ' AND source = ?'
      params.push(source)
      countParams.push(source)
    }

    if (severity) {
      query += ' AND severity = ?'
      countQuery += ' AND severity = ?'
      params.push(severity)
      countParams.push(severity)
    }

    if (reviewStatus) {
      query += ' AND review_status = ?'
      countQuery += ' AND review_status = ?'
      params.push(reviewStatus)
      countParams.push(reviewStatus)
    }

    if (reviewedBy) {
      query += ' AND reviewed_by = ?'
      countQuery += ' AND reviewed_by = ?'
      params.push(reviewedBy)
      countParams.push(reviewedBy)
    }

    if (since) {
      query += ' AND quarantine_date >= ?'
      countQuery += ' AND quarantine_date >= ?'
      params.push(since.toISOString())
      countParams.push(since.toISOString())
    }

    if (until) {
      query += ' AND quarantine_date <= ?'
      countQuery += ' AND quarantine_date <= ?'
      params.push(until.toISOString())
      countParams.push(until.toISOString())
    }

    query += ' ORDER BY quarantine_date DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)

    const rows = this.db.prepare(query).all(...params) as QuarantineRow[]
    const { count } = this.db.prepare(countQuery).get(...countParams) as { count: number }

    return {
      items: rows.map((row) => this.rowToEntry(row)),
      total: count,
      limit,
      offset,
      hasMore: offset + rows.length < count,
    }
  }

  /**
   * Update a quarantine entry
   *
   * @param id - Quarantine entry ID
   * @param input - Update data
   * @returns Updated entry or null if not found
   */
  update(id: string, input: QuarantineUpdateInput): QuarantineEntry | null {
    const patterns = input.detectedPatterns ? JSON.stringify(input.detectedPatterns) : null
    const hasReviewUpdate = input.reviewStatus !== undefined

    const result = this.stmts.update.run(
      input.quarantineReason ?? null,
      input.severity ?? null,
      patterns,
      input.reviewedBy ?? null,
      input.reviewStatus ?? null,
      input.reviewNotes ?? null,
      hasReviewUpdate ? 'set' : null, // Trigger review_date update
      id
    )

    if (result.changes === 0) {
      return null
    }

    const updated = this.findById(id)
    if (updated) {
      this.logAudit('quarantine_update', updated.skillId, 'success', {
        quarantineId: id,
        updates: input,
      })
    }

    return updated
  }

  /**
   * Review a quarantine entry
   *
   * @param id - Quarantine entry ID
   * @param reviewInput - Review data
   * @returns Review decision with import guidance
   */
  review(
    id: string,
    reviewInput: {
      reviewedBy: string
      reviewStatus: QuarantineReviewStatus
      reviewNotes?: string
    }
  ): ReviewDecision | null {
    const entry = this.findById(id)
    if (!entry) return null

    const updated = this.update(id, {
      reviewedBy: reviewInput.reviewedBy,
      reviewStatus: reviewInput.reviewStatus,
      reviewNotes: reviewInput.reviewNotes,
    })

    if (!updated) return null

    const policy = QUARANTINE_SEVERITY_POLICIES[updated.severity]
    const approved = reviewInput.reviewStatus === 'approved'

    const warnings: string[] = []
    if (approved && updated.severity === 'RISKY') {
      warnings.push(`Skill was flagged as RISKY: ${updated.quarantineReason}`)
    }
    if (approved && updated.severity === 'LOW_QUALITY') {
      warnings.push(`Skill has low quality indicators: ${updated.quarantineReason}`)
    }

    this.logAudit('quarantine_review', updated.skillId, approved ? 'success' : 'blocked', {
      quarantineId: id,
      reviewStatus: reviewInput.reviewStatus,
      reviewedBy: reviewInput.reviewedBy,
      severity: updated.severity,
      canImport: approved && policy.allowImport,
    })

    return {
      approved,
      skillId: updated.skillId,
      severity: updated.severity,
      canImport: approved || policy.allowImport,
      warnings,
    }
  }

  /**
   * Delete a quarantine entry
   *
   * @param id - Quarantine entry ID
   * @returns True if entry was deleted
   */
  delete(id: string): boolean {
    const entry = this.findById(id)
    const result = this.stmts.delete.run(id)

    if (result.changes > 0 && entry) {
      this.logAudit('quarantine_delete', entry.skillId, 'success', {
        quarantineId: id,
      })
    }

    return result.changes > 0
  }

  /**
   * Delete all quarantine entries for a skill
   *
   * @param skillId - Skill ID
   * @returns Number of deleted entries
   */
  deleteBySkillId(skillId: string): number {
    const result = this.stmts.deleteBySkillId.run(skillId)

    if (result.changes > 0) {
      this.logAudit('quarantine_delete_all', skillId, 'success', {
        deletedCount: result.changes,
      })
    }

    return result.changes
  }

  /**
   * Get quarantine statistics
   *
   * @returns Quarantine statistics
   */
  getStats(): QuarantineStats {
    const totalResult = this.db.prepare('SELECT COUNT(*) as count FROM quarantine').get() as {
      count: number
    }

    const severityResults = this.db
      .prepare('SELECT severity, COUNT(*) as count FROM quarantine GROUP BY severity')
      .all() as Array<{ severity: QuarantineSeverity; count: number }>

    const bySeverity = severityResults.reduce(
      (acc, row) => {
        acc[row.severity] = row.count
        return acc
      },
      {} as Record<QuarantineSeverity, number>
    )

    const statusResults = this.db
      .prepare('SELECT review_status, COUNT(*) as count FROM quarantine GROUP BY review_status')
      .all() as Array<{ review_status: QuarantineReviewStatus; count: number }>

    const byStatus = statusResults.reduce(
      (acc, row) => {
        acc[row.review_status] = row.count
        return acc
      },
      {} as Record<QuarantineReviewStatus, number>
    )

    const pendingResult = this.db
      .prepare("SELECT COUNT(*) as count FROM quarantine WHERE review_status = 'pending'")
      .get() as { count: number }

    const rangeResult = this.db
      .prepare(
        'SELECT MIN(quarantine_date) as oldest, MAX(quarantine_date) as newest FROM quarantine'
      )
      .get() as { oldest: string | null; newest: string | null }

    return {
      total: totalResult.count,
      bySeverity,
      byStatus,
      pendingReview: pendingResult.count,
      oldestEntry: rangeResult.oldest,
      newestEntry: rangeResult.newest,
    }
  }

  /**
   * Count all quarantine entries
   *
   * @returns Total count
   */
  count(): number {
    const { count } = this.stmts.selectCount.get() as { count: number }
    return count
  }

  /**
   * Execute a function within a transaction
   *
   * @param fn - Function to execute
   * @returns Result of the function
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }
}
