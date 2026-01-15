/**
 * SyncHistoryRepository - Tracks sync operation history
 *
 * Records each sync run with timing, counts, and status for monitoring.
 */

import type { Database as DatabaseType } from 'better-sqlite3'

/**
 * Sync run status
 */
export type SyncStatus = 'running' | 'success' | 'failed' | 'partial'

/**
 * Sync history entry
 */
export interface SyncHistoryEntry {
  id: string
  startedAt: string
  completedAt: string | null
  status: SyncStatus
  skillsAdded: number
  skillsUpdated: number
  skillsUnchanged: number
  errorMessage: string | null
  durationMs: number | null
  createdAt: string
}

/**
 * Database row type
 */
interface SyncHistoryRow {
  id: string
  started_at: string
  completed_at: string | null
  status: string
  skills_added: number
  skills_updated: number
  skills_unchanged: number
  error_message: string | null
  duration_ms: number | null
  created_at: string
}

/**
 * Sync result for completing a run
 */
export interface SyncRunResult {
  skillsAdded: number
  skillsUpdated: number
  skillsUnchanged: number
}

/**
 * Generate a unique ID for sync runs
 */
function generateSyncId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, '')
    .slice(0, 14)
  const random = Math.random().toString(36).slice(2, 8)
  return `sync-${timestamp}-${random}`
}

/**
 * Repository for sync history tracking
 */
export class SyncHistoryRepository {
  private db: DatabaseType
  private stmts!: {
    insert: { run: (...args: unknown[]) => { changes: number } }
    complete: { run: (...args: unknown[]) => { changes: number } }
    fail: { run: (...args: unknown[]) => { changes: number } }
    getById: { get: (id: string) => SyncHistoryRow | undefined }
    getHistory: { all: (limit: number) => SyncHistoryRow[] }
    getLastSuccessful: { get: () => SyncHistoryRow | undefined }
    getRunning: { all: () => SyncHistoryRow[] }
    deleteOld: { run: (cutoff: string) => { changes: number } }
    count: { get: () => { count: number } }
  }

  constructor(db: DatabaseType) {
    this.db = db
    this.ensureTable()
    this.prepareStatements()
  }

  /**
   * Ensure sync_history table exists
   */
  private ensureTable(): void {
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_history'")
      .get()

    if (!tableExists) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sync_history (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'success', 'failed', 'partial')),
          skills_added INTEGER DEFAULT 0,
          skills_updated INTEGER DEFAULT 0,
          skills_unchanged INTEGER DEFAULT 0,
          error_message TEXT,
          duration_ms INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_sync_history_started ON sync_history(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sync_history_status ON sync_history(status);
      `)
    }
  }

  private prepareStatements(): void {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO sync_history (id, started_at, status)
        VALUES (?, ?, 'running')
      `) as unknown as typeof this.stmts.insert,

      complete: this.db.prepare(`
        UPDATE sync_history
        SET completed_at = ?, status = ?, skills_added = ?, skills_updated = ?, skills_unchanged = ?, duration_ms = ?
        WHERE id = ?
      `) as unknown as typeof this.stmts.complete,

      fail: this.db.prepare(`
        UPDATE sync_history
        SET completed_at = ?, status = 'failed', error_message = ?, duration_ms = ?
        WHERE id = ?
      `) as unknown as typeof this.stmts.fail,

      getById: this.db.prepare(`
        SELECT * FROM sync_history WHERE id = ?
      `) as unknown as typeof this.stmts.getById,

      getHistory: this.db.prepare(`
        SELECT * FROM sync_history ORDER BY started_at DESC LIMIT ?
      `) as unknown as typeof this.stmts.getHistory,

      getLastSuccessful: this.db.prepare(`
        SELECT * FROM sync_history WHERE status = 'success' ORDER BY started_at DESC LIMIT 1
      `) as unknown as typeof this.stmts.getLastSuccessful,

      getRunning: this.db.prepare(`
        SELECT * FROM sync_history WHERE status = 'running'
      `) as unknown as typeof this.stmts.getRunning,

      deleteOld: this.db.prepare(`
        DELETE FROM sync_history WHERE started_at < ?
      `) as unknown as typeof this.stmts.deleteOld,

      count: this.db.prepare(`
        SELECT COUNT(*) as count FROM sync_history
      `) as unknown as typeof this.stmts.count,
    }
  }

  private rowToEntry(row: SyncHistoryRow): SyncHistoryEntry {
    return {
      id: row.id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: row.status as SyncStatus,
      skillsAdded: row.skills_added,
      skillsUpdated: row.skills_updated,
      skillsUnchanged: row.skills_unchanged,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    }
  }

  /**
   * Start a new sync run
   * @returns The sync run ID
   */
  startRun(): string {
    const id = generateSyncId()
    const startedAt = new Date().toISOString()
    this.stmts.insert.run(id, startedAt)
    return id
  }

  /**
   * Complete a sync run successfully
   */
  completeRun(id: string, result: SyncRunResult): void {
    const completedAt = new Date().toISOString()
    const entry = this.stmts.getById.get(id) as SyncHistoryRow | undefined

    if (!entry) {
      throw new Error(`Sync run not found: ${id}`)
    }

    const durationMs = new Date(completedAt).getTime() - new Date(entry.started_at).getTime()

    // Determine status based on results
    const status: SyncStatus =
      result.skillsAdded > 0 || result.skillsUpdated > 0 ? 'success' : 'success'

    this.stmts.complete.run(
      completedAt,
      status,
      result.skillsAdded,
      result.skillsUpdated,
      result.skillsUnchanged,
      durationMs,
      id
    )
  }

  /**
   * Mark a sync run as partially complete (some errors)
   */
  completeRunPartial(id: string, result: SyncRunResult, errorMessage: string): void {
    const completedAt = new Date().toISOString()
    const entry = this.stmts.getById.get(id) as SyncHistoryRow | undefined

    if (!entry) {
      throw new Error(`Sync run not found: ${id}`)
    }

    const durationMs = new Date(completedAt).getTime() - new Date(entry.started_at).getTime()

    // Use raw SQL for partial status since we need to include error
    this.db
      .prepare(
        `
      UPDATE sync_history
      SET completed_at = ?, status = 'partial', skills_added = ?, skills_updated = ?, skills_unchanged = ?, error_message = ?, duration_ms = ?
      WHERE id = ?
    `
      )
      .run(
        completedAt,
        result.skillsAdded,
        result.skillsUpdated,
        result.skillsUnchanged,
        errorMessage,
        durationMs,
        id
      )
  }

  /**
   * Mark a sync run as failed
   */
  failRun(id: string, error: string): void {
    const completedAt = new Date().toISOString()
    const entry = this.stmts.getById.get(id) as SyncHistoryRow | undefined

    if (!entry) {
      throw new Error(`Sync run not found: ${id}`)
    }

    const durationMs = new Date(completedAt).getTime() - new Date(entry.started_at).getTime()
    this.stmts.fail.run(completedAt, error, durationMs, id)
  }

  /**
   * Get a specific sync run by ID
   */
  getById(id: string): SyncHistoryEntry | null {
    const row = this.stmts.getById.get(id) as SyncHistoryRow | undefined
    return row ? this.rowToEntry(row) : null
  }

  /**
   * Get sync history (most recent first)
   */
  getHistory(limit: number = 10): SyncHistoryEntry[] {
    const rows = this.stmts.getHistory.all(limit) as SyncHistoryRow[]
    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Get the last successful sync run
   */
  getLastSuccessful(): SyncHistoryEntry | null {
    const row = this.stmts.getLastSuccessful.get() as SyncHistoryRow | undefined
    return row ? this.rowToEntry(row) : null
  }

  /**
   * Get any currently running sync operations
   */
  getRunning(): SyncHistoryEntry[] {
    const rows = this.stmts.getRunning.all() as SyncHistoryRow[]
    return rows.map((row) => this.rowToEntry(row))
  }

  /**
   * Check if a sync is currently running
   */
  isRunning(): boolean {
    return this.getRunning().length > 0
  }

  /**
   * Clean up old history entries
   * @param daysToKeep Number of days of history to retain
   */
  cleanup(daysToKeep: number = 30): number {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - daysToKeep)
    const result = this.stmts.deleteOld.run(cutoff.toISOString())
    return result.changes
  }

  /**
   * Get total count of history entries
   */
  count(): number {
    const result = this.stmts.count.get() as { count: number }
    return result.count
  }

  /**
   * Get sync statistics
   */
  getStats(): {
    totalRuns: number
    successfulRuns: number
    failedRuns: number
    lastSuccessAt: string | null
    averageDurationMs: number | null
  } {
    const stats = this.db
      .prepare(
        `
      SELECT
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_runs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
        MAX(CASE WHEN status = 'success' THEN completed_at ELSE NULL END) as last_success_at,
        AVG(CASE WHEN status = 'success' THEN duration_ms ELSE NULL END) as avg_duration_ms
      FROM sync_history
    `
      )
      .get() as {
      total_runs: number
      successful_runs: number
      failed_runs: number
      last_success_at: string | null
      avg_duration_ms: number | null
    }

    return {
      totalRuns: stats.total_runs,
      successfulRuns: stats.successful_runs,
      failedRuns: stats.failed_runs,
      lastSuccessAt: stats.last_success_at,
      averageDurationMs: stats.avg_duration_ms ? Math.round(stats.avg_duration_ms) : null,
    }
  }
}
