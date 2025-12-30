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

const logger = createLogger('AuditLogger')

/**
 * Types of security events that are audited
 */
export type AuditEventType =
  | 'url_fetch'
  | 'file_access'
  | 'skill_install'
  | 'skill_uninstall'
  | 'security_scan'
  | 'cache_operation'
  | 'source_sync'
  | 'config_change'

/**
 * Actor performing the action
 */
export type AuditActor = 'user' | 'system' | 'adapter' | 'scanner'

/**
 * Result of the audited action
 */
export type AuditResult = 'success' | 'blocked' | 'error' | 'warning'

/**
 * Database row type for audit logs
 */
interface AuditLogRow {
  id: string
  event_type: AuditEventType
  timestamp: string
  actor: AuditActor
  resource: string
  action: string
  result: AuditResult
  metadata: string | null
  created_at: string
}

/**
 * Audit log entry structure
 */
export interface AuditLogEntry {
  id: string
  event_type: AuditEventType
  timestamp: string
  actor: AuditActor
  resource: string
  action: string
  result: AuditResult
  metadata?: Record<string, unknown>
  created_at: string
}

/**
 * Query filters for audit log retrieval
 */
export interface AuditQueryFilter {
  event_type?: AuditEventType
  actor?: AuditActor
  resource?: string
  result?: AuditResult
  since?: Date
  until?: Date
  limit?: number
  offset?: number
}

/**
 * Audit statistics
 */
export interface AuditStats {
  total_events: number
  events_by_type: Record<AuditEventType, number>
  events_by_result: Record<AuditResult, number>
  blocked_events: number
  error_events: number
  oldest_event: string | null
  newest_event: string | null
}

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
  private stmts!: {
    insert: { run: (...args: unknown[]) => { changes: number } }
    query: { all: (...args: unknown[]) => AuditLogRow[] }
  }

  constructor(db: DatabaseType) {
    this.db = db
    this.ensureTableExists()
    this.prepareStatements()
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
   * Clean up old audit logs
   *
   * @param olderThan - Delete logs older than this date
   * @returns Number of deleted entries
   */
  cleanup(olderThan: Date): number {
    const olderThanIso = olderThan.toISOString()

    try {
      const result = this.db.prepare(`DELETE FROM audit_logs WHERE timestamp < ?`).run(olderThanIso)

      logger.info('Audit logs cleaned up', {
        deleted: result.changes,
        olderThan: olderThanIso,
      })

      return result.changes
    } catch (err) {
      logger.error('Failed to cleanup audit logs', err as Error, {
        olderThan: olderThan.toISOString(),
      })
      throw err
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
