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
import type { QuarantineSeverity, QuarantineReviewStatus } from '../../db/quarantine-schema.js'
import {
  initializeQuarantineSchema,
  QUARANTINE_SEVERITY_POLICIES,
} from '../../db/quarantine-schema.js'
import type { AuditLogger } from '../../security/AuditLogger.js'

import type {
  QuarantineRow,
  QuarantineEntry,
  QuarantineCreateInput,
  QuarantineUpdateInput,
  QuarantineQueryFilter,
  PaginatedQuarantineResults,
  QuarantineStats,
  ReviewDecision,
  PreparedStatements,
} from './types.js'
import {
  INSERT_QUERY,
  SELECT_BY_ID_QUERY,
  SELECT_BY_SKILL_ID_QUERY,
  SELECT_ALL_QUERY,
  SELECT_COUNT_QUERY,
  UPDATE_QUERY,
  DELETE_QUERY,
  DELETE_BY_SKILL_ID_QUERY,
  STATS_TOTAL_QUERY,
  STATS_BY_SEVERITY_QUERY,
  STATS_BY_STATUS_QUERY,
  STATS_PENDING_QUERY,
  STATS_RANGE_QUERY,
} from './queries.js'
import { buildFilteredQuery, rowToEntry } from './query-builder.js'

// Re-export types for backward compatibility
export type {
  QuarantineEntry,
  QuarantineCreateInput,
  QuarantineUpdateInput,
  QuarantineQueryFilter,
  PaginatedQuarantineResults,
  QuarantineStats,
  ReviewDecision,
} from './types.js'

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
  private stmts!: PreparedStatements

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
      insert: this.db.prepare(INSERT_QUERY) as unknown as PreparedStatements['insert'],
      selectById: this.db.prepare(
        SELECT_BY_ID_QUERY
      ) as unknown as PreparedStatements['selectById'],
      selectBySkillId: this.db.prepare(
        SELECT_BY_SKILL_ID_QUERY
      ) as unknown as PreparedStatements['selectBySkillId'],
      selectAll: this.db.prepare(SELECT_ALL_QUERY) as unknown as PreparedStatements['selectAll'],
      selectCount: this.db.prepare(
        SELECT_COUNT_QUERY
      ) as unknown as PreparedStatements['selectCount'],
      update: this.db.prepare(UPDATE_QUERY) as unknown as PreparedStatements['update'],
      delete: this.db.prepare(DELETE_QUERY) as unknown as PreparedStatements['delete'],
      deleteBySkillId: this.db.prepare(
        DELETE_BY_SKILL_ID_QUERY
      ) as unknown as PreparedStatements['deleteBySkillId'],
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
    return rowToEntry(row)
  }

  /**
   * Find a quarantine entry by ID
   *
   * @param id - Quarantine entry ID
   * @returns Quarantine entry or null if not found
   */
  findById(id: string): QuarantineEntry | null {
    const row = this.stmts.selectById.get(id) as QuarantineRow | undefined
    return row ? rowToEntry(row) : null
  }

  /**
   * Find all quarantine entries for a skill
   *
   * @param skillId - Skill ID
   * @returns Array of quarantine entries
   */
  findBySkillId(skillId: string): QuarantineEntry[] {
    const rows = this.stmts.selectBySkillId.all(skillId) as QuarantineRow[]
    return rows.map((row) => rowToEntry(row))
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
      items: rows.map((row) => rowToEntry(row)),
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
    const { limit = 20, offset = 0 } = filter
    const { query, countQuery, params, countParams } = buildFilteredQuery(filter)

    const rows = this.db.prepare(query).all(...params) as QuarantineRow[]
    const { count } = this.db.prepare(countQuery).get(...countParams) as { count: number }

    return {
      items: rows.map((row) => rowToEntry(row)),
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
    const totalResult = this.db.prepare(STATS_TOTAL_QUERY).get() as { count: number }

    const severityResults = this.db.prepare(STATS_BY_SEVERITY_QUERY).all() as Array<{
      severity: QuarantineSeverity
      count: number
    }>

    const bySeverity = severityResults.reduce(
      (acc, row) => {
        acc[row.severity] = row.count
        return acc
      },
      {} as Record<QuarantineSeverity, number>
    )

    const statusResults = this.db.prepare(STATS_BY_STATUS_QUERY).all() as Array<{
      review_status: QuarantineReviewStatus
      count: number
    }>

    const byStatus = statusResults.reduce(
      (acc, row) => {
        acc[row.review_status] = row.count
        return acc
      },
      {} as Record<QuarantineReviewStatus, number>
    )

    const pendingResult = this.db.prepare(STATS_PENDING_QUERY).get() as { count: number }
    const rangeResult = this.db.prepare(STATS_RANGE_QUERY).get() as {
      oldest: string | null
      newest: string | null
    }

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
