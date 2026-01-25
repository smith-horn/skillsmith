/**
 * SMI-733: Audit Logging System
 *
 * Provides structured audit logging for security-relevant events.
 * Stores audit trails in SQLite database for compliance and forensics.
 *
 * Schema defined in docs/security/index.md §3.2
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { createLogger } from '../utils/logger.js'
import type {
  AuditEventType,
  AuditActor,
  AuditResult,
  AuditLogRow,
  AuditLogEntry,
  AuditQueryFilter,
  AuditLoggerConfig,
  AuditStats,
} from './audit-types.js'
import { MIN_RETENTION_DAYS, MAX_RETENTION_DAYS } from './audit-types.js'

// Re-export types for backwards compatibility
export type {
  AuditEventType,
  AuditActor,
  AuditResult,
  AuditLogEntry,
  AuditQueryFilter,
  AuditLoggerConfig,
  AuditStats,
}
export { MIN_RETENTION_DAYS, MAX_RETENTION_DAYS }

const logger = createLogger('AuditLogger')

/**
 * Audit Logger implementation with SQLite backend
 *
 * @example
 * ```typescript
 * const auditLogger = new AuditLogger(db)
 *
 * // Log URL fetch
 * await auditLogger.log({
 *   event_type: 'url_fetch',
 *   actor: 'adapter',
 *   resource: 'https://example.com/skill.yaml',
 *   action: 'fetch',
 *   result: 'success',
 *   metadata: { status: 200, duration: 123 }
 * })
 *
 * // Query audit trail
 * const recentBlocks = await auditLogger.query({
 *   result: 'blocked',
 *   since: new Date(Date.now() - 24 * 60 * 60 * 1000)
 * })
 * ```
 */
export class AuditLogger {
  private db: DatabaseType
  private config: AuditLoggerConfig
  private stmts!: {
    insert: { run: (...args: unknown[]) => { changes: number } }
    query: { all: (...args: unknown[]) => AuditLogRow[] }
  }

  constructor(db: DatabaseType, config: AuditLoggerConfig = {}) {
    this.db = db
    this.config = {
      autoCleanup: config.autoCleanup ?? false,
      retentionDays: config.retentionDays ?? 90,
    }
    this.ensureTableExists()
    this.prepareStatements()

    // Validate config retention days early
    if (this.config.retentionDays !== undefined) {
      if (
        this.config.retentionDays < MIN_RETENTION_DAYS ||
        this.config.retentionDays > MAX_RETENTION_DAYS
      ) {
        throw new Error(
          `Invalid retentionDays config: must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}, got ${this.config.retentionDays}`
        )
      }
    }

    // Run auto-cleanup if enabled
    if (this.config.autoCleanup) {
      try {
        const deleted = this.cleanupOldLogs(this.config.retentionDays!)
        if (deleted > 0) {
          logger.info('Auto-cleanup completed on initialization', {
            deleted,
            retentionDays: this.config.retentionDays,
          })
        }
      } catch (err) {
        // Log but don't throw - don't fail initialization due to cleanup issues
        logger.error('Auto-cleanup failed on initialization', err as Error, {
          retentionDays: this.config.retentionDays,
        })
      }
    }
  }

  /**
   * Prepare SQL statements for performance
   */
  private prepareStatements(): void {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO audit_logs (id, event_type, timestamp, actor, resource, action, result, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `) as unknown as typeof this.stmts.insert,

      query: this.db.prepare(`
        SELECT * FROM audit_logs
        WHERE 1=1
          AND (? IS NULL OR event_type = ?)
          AND (? IS NULL OR actor = ?)
          AND (? IS NULL OR resource LIKE ?)
          AND (? IS NULL OR result = ?)
          AND (? IS NULL OR timestamp >= ?)
          AND (? IS NULL OR timestamp <= ?)
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `) as unknown as typeof this.stmts.query,
    }
  }

  /**
   * Ensure the audit_logs table exists
   */
  private ensureTableExists(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT,
        resource TEXT,
        action TEXT,
        result TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource);
      CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_logs(result);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor);
    `)
  }

  /**
   * Log an audit event
   *
   * @param entry - Audit log entry (id, timestamp, created_at are auto-generated)
   */
  log(
    entry: Omit<AuditLogEntry, 'id' | 'timestamp' | 'created_at'> & {
      timestamp?: string
    }
  ): void {
    const id = randomUUID()
    const timestamp = entry.timestamp || new Date().toISOString()
    const created_at = new Date().toISOString()
    const metadata = entry.metadata ? JSON.stringify(entry.metadata) : null

    try {
      this.stmts.insert.run(
        id,
        entry.event_type,
        timestamp,
        entry.actor,
        entry.resource,
        entry.action,
        entry.result,
        metadata,
        created_at
      )

      logger.debug('Audit log entry created', {
        id,
        event_type: entry.event_type,
        resource: entry.resource,
      })
    } catch (err) {
      logger.error('Failed to write audit log', err as Error, { entry })
      throw err
    }
  }

  /**
   * Query audit logs with filters
   *
   * @param filter - Query filters
   * @returns Array of matching audit log entries
   */
  query(filter: AuditQueryFilter = {}): AuditLogEntry[] {
    const { event_type, actor, resource, result, since, until, limit = 100, offset = 0 } = filter

    const resourcePattern = resource ? `%${resource}%` : null
    const sinceIso = since?.toISOString() || null
    const untilIso = until?.toISOString() || null

    try {
      const rows = this.stmts.query.all(
        event_type || null,
        event_type || null,
        actor || null,
        actor || null,
        resourcePattern,
        resourcePattern,
        result || null,
        result || null,
        sinceIso,
        sinceIso,
        untilIso,
        untilIso,
        limit,
        offset
      )

      return rows.map((row) => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      }))
    } catch (err) {
      logger.error('Failed to query audit logs', err as Error, { filter })
      throw err
    }
  }

  /**
   * Get audit statistics
   *
   * @returns Statistics about audit log entries
   */
  getStats(): AuditStats {
    try {
      // Total events
      const totalResult = this.db.prepare('SELECT COUNT(*) as count FROM audit_logs').get() as {
        count: number
      }

      // Events by type
      const typeResults = this.db
        .prepare(`SELECT event_type, COUNT(*) as count FROM audit_logs GROUP BY event_type`)
        .all() as Array<{ event_type: AuditEventType; count: number }>

      const events_by_type = typeResults.reduce(
        (acc, row) => {
          acc[row.event_type] = row.count
          return acc
        },
        {} as Record<AuditEventType, number>
      )

      // Events by result
      const resultResults = this.db
        .prepare(`SELECT result, COUNT(*) as count FROM audit_logs GROUP BY result`)
        .all() as Array<{ result: AuditResult; count: number }>

      const events_by_result = resultResults.reduce(
        (acc, row) => {
          acc[row.result] = row.count
          return acc
        },
        {} as Record<AuditResult, number>
      )

      // Blocked events
      const blockedResult = this.db
        .prepare(`SELECT COUNT(*) as count FROM audit_logs WHERE result = 'blocked'`)
        .get() as { count: number }

      // Error events
      const errorResult = this.db
        .prepare(`SELECT COUNT(*) as count FROM audit_logs WHERE result = 'error'`)
        .get() as { count: number }

      // Oldest and newest events
      const rangeResult = this.db
        .prepare(`SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM audit_logs`)
        .get() as { oldest: string | null; newest: string | null }

      return {
        total_events: totalResult.count,
        events_by_type,
        events_by_result,
        blocked_events: blockedResult.count,
        error_events: errorResult.count,
        oldest_event: rangeResult.oldest,
        newest_event: rangeResult.newest,
      }
    } catch (err) {
      logger.error('Failed to get audit stats', err as Error)
      throw err
    }
  }

  /**
   * Clean up old audit logs (internal implementation)
   *
   * @param olderThan - Delete logs older than this date
   * @param skipMetaLog - Skip meta-logging (used internally to prevent recursion)
   * @returns Number of deleted entries
   */
  private cleanupInternal(olderThan: Date, skipMetaLog = false): number {
    const olderThanIso = olderThan.toISOString()

    try {
      const result = this.db.prepare(`DELETE FROM audit_logs WHERE timestamp < ?`).run(olderThanIso)

      logger.info('Audit logs cleaned up', {
        deleted: result.changes,
        olderThan: olderThanIso,
      })

      // Meta-log the cleanup operation (unless skipped to prevent recursion)
      if (!skipMetaLog && result.changes > 0) {
        try {
          this.log({
            event_type: 'config_change',
            actor: 'system',
            resource: 'audit_logs',
            action: 'cleanup_internal',
            result: 'success',
            metadata: {
              cutoffDate: olderThanIso,
              deletedCount: result.changes,
            },
          })
        } catch {
          // Meta-logging failure should not affect cleanup result
          logger.warn('Failed to meta-log cleanup operation')
        }
      }

      return result.changes
    } catch (err) {
      logger.error('Failed to cleanup audit logs', err as Error, {
        olderThan: olderThan.toISOString(),
      })
      throw err
    }
  }

  /**
   * Clean up old audit logs
   *
   * @deprecated Use cleanupOldLogs() instead for validated retention-based cleanup
   * @param olderThan - Delete logs older than this date
   * @returns Number of deleted entries
   */
  cleanup(olderThan: Date): number {
    return this.cleanupInternal(olderThan)
  }

  /**
   * Validate retention days parameter
   *
   * @param retentionDays - Number of days to validate
   * @throws Error if retentionDays is invalid
   */
  private validateRetentionDays(retentionDays: number): void {
    if (!Number.isFinite(retentionDays)) {
      throw new Error(`Invalid retention days: must be a finite number, got ${retentionDays}`)
    }
    if (!Number.isInteger(retentionDays)) {
      throw new Error(`Invalid retention days: must be an integer, got ${retentionDays}`)
    }
    if (retentionDays < MIN_RETENTION_DAYS) {
      throw new Error(
        `Invalid retention days: minimum is ${MIN_RETENTION_DAYS} day(s), got ${retentionDays}`
      )
    }
    if (retentionDays > MAX_RETENTION_DAYS) {
      throw new Error(
        `Invalid retention days: maximum is ${MAX_RETENTION_DAYS} days, got ${retentionDays}`
      )
    }
  }

  /**
   * Clean up old audit logs based on retention policy
   *
   * SMI-1012: Audit log retention policy with input validation
   *
   * @param retentionDays - Number of days to retain logs (default: 90, min: 1, max: 3650)
   * @returns Number of deleted rows
   * @throws Error if retentionDays is invalid (< 1, > 3650, or non-integer)
   *
   * @example
   * ```typescript
   * // Delete logs older than 90 days (default)
   * const deleted = auditLogger.cleanupOldLogs()
   *
   * // Delete logs older than 30 days
   * const deleted = auditLogger.cleanupOldLogs(30)
   *
   * // These will throw errors:
   * auditLogger.cleanupOldLogs(0)  // Error: minimum is 1 day
   * auditLogger.cleanupOldLogs(-5) // Error: minimum is 1 day
   * ```
   */
  cleanupOldLogs(retentionDays: number = 90): number {
    // Validate input to prevent accidental data loss
    this.validateRetentionDays(retentionDays)

    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const _originalError: Error | null = null

    try {
      // Use internal cleanup to skip double meta-logging
      const deleted = this.cleanupInternal(cutoffDate, true)

      // Meta-logging: Log the cleanup operation using the audit logger itself
      try {
        this.log({
          event_type: 'config_change',
          actor: 'system',
          resource: 'audit_logs',
          action: 'cleanup',
          result: 'success',
          metadata: {
            retentionDays,
            cutoffDate: cutoffDate.toISOString(),
            deletedCount: deleted,
          },
        })
      } catch (metaLogErr) {
        // Meta-logging failure should not affect cleanup result
        logger.warn('Failed to meta-log successful cleanup', {
          error: (metaLogErr as Error).message,
          deleted,
        })
      }

      return deleted
    } catch (err) {
      // Store original error before attempting meta-logging
      const cleanupError = err as Error

      // Try to log failed cleanup attempt (best effort)
      try {
        this.log({
          event_type: 'config_change',
          actor: 'system',
          resource: 'audit_logs',
          action: 'cleanup',
          result: 'error',
          metadata: {
            retentionDays,
            cutoffDate: cutoffDate.toISOString(),
            error: cleanupError.message,
          },
        })
      } catch (metaLogErr) {
        // Log meta-logging failure but preserve original error
        logger.warn('Failed to meta-log cleanup error', {
          originalError: cleanupError.message,
          metaLogError: (metaLogErr as Error).message,
        })
      }

      // Always throw the original cleanup error
      throw cleanupError
    }
  }

  /**
   * Export audit logs to JSON
   *
   * @param filter - Query filters
   * @returns JSON string of audit logs
   */
  export(filter: AuditQueryFilter = {}): string {
    const logs = this.query({ ...filter, limit: filter.limit || 10000 })
    return JSON.stringify(logs, null, 2)
  }
}
