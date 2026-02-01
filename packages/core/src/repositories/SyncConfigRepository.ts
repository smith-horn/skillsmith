/**
 * SyncConfigRepository - Manages sync configuration state
 *
 * Handles the singleton sync_config record for registry sync settings.
 */

import type { Database as DatabaseType } from '../db/database-interface.js'

/**
 * Sync frequency options
 */
export type SyncFrequency = 'daily' | 'weekly'

/**
 * Interval in milliseconds for each frequency
 */
export const FREQUENCY_INTERVALS: Record<SyncFrequency, number> = {
  daily: 86400000, // 24 hours
  weekly: 604800000, // 7 days
}

/**
 * Sync configuration
 */
export interface SyncConfig {
  id: string
  enabled: boolean
  frequency: SyncFrequency
  intervalMs: number
  lastSyncAt: string | null
  nextSyncAt: string | null
  lastSyncCount: number
  lastSyncError: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Database row type
 */
interface SyncConfigRow {
  id: string
  enabled: number
  frequency: string
  interval_ms: number
  last_sync_at: string | null
  next_sync_at: string | null
  last_sync_count: number
  last_sync_error: string | null
  created_at: string
  updated_at: string
}

/**
 * Partial update input
 */
export interface SyncConfigUpdate {
  enabled?: boolean
  frequency?: SyncFrequency
}

/**
 * Repository for sync configuration management
 */
export class SyncConfigRepository {
  private db: DatabaseType
  private stmts!: {
    get: { get: () => SyncConfigRow | undefined }
    update: { run: (...args: unknown[]) => { changes: number } }
    setLastSync: { run: (timestamp: string, count: number) => { changes: number } }
    setLastSyncError: { run: (error: string) => { changes: number } }
    setNextSync: { run: (timestamp: string) => { changes: number } }
    clearError: { run: () => { changes: number } }
  }

  constructor(db: DatabaseType) {
    this.db = db
    this.ensureTable()
    this.prepareStatements()
  }

  /**
   * Ensure sync_config table exists and has default row
   */
  private ensureTable(): void {
    // Check if table exists
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_config'")
      .get()

    if (!tableExists) {
      // Create table if it doesn't exist (handles pre-migration databases)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sync_config (
          id TEXT PRIMARY KEY DEFAULT 'default',
          enabled INTEGER NOT NULL DEFAULT 1,
          frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('daily', 'weekly')),
          interval_ms INTEGER NOT NULL DEFAULT 86400000,
          last_sync_at TEXT,
          next_sync_at TEXT,
          last_sync_count INTEGER DEFAULT 0,
          last_sync_error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
    }

    // Ensure default config exists
    this.db.exec("INSERT OR IGNORE INTO sync_config (id) VALUES ('default')")
  }

  private prepareStatements(): void {
    this.stmts = {
      get: this.db.prepare(`
        SELECT * FROM sync_config WHERE id = 'default'
      `) as unknown as typeof this.stmts.get,

      update: this.db.prepare(`
        UPDATE sync_config
        SET enabled = ?, frequency = ?, interval_ms = ?, updated_at = datetime('now')
        WHERE id = 'default'
      `) as unknown as typeof this.stmts.update,

      setLastSync: this.db.prepare(`
        UPDATE sync_config
        SET last_sync_at = ?, last_sync_count = ?, last_sync_error = NULL, updated_at = datetime('now')
        WHERE id = 'default'
      `) as unknown as typeof this.stmts.setLastSync,

      setLastSyncError: this.db.prepare(`
        UPDATE sync_config
        SET last_sync_error = ?, updated_at = datetime('now')
        WHERE id = 'default'
      `) as unknown as typeof this.stmts.setLastSyncError,

      setNextSync: this.db.prepare(`
        UPDATE sync_config
        SET next_sync_at = ?, updated_at = datetime('now')
        WHERE id = 'default'
      `) as unknown as typeof this.stmts.setNextSync,

      clearError: this.db.prepare(`
        UPDATE sync_config
        SET last_sync_error = NULL, updated_at = datetime('now')
        WHERE id = 'default'
      `) as unknown as typeof this.stmts.clearError,
    }
  }

  private rowToConfig(row: SyncConfigRow): SyncConfig {
    return {
      id: row.id,
      enabled: row.enabled === 1,
      frequency: row.frequency as SyncFrequency,
      intervalMs: row.interval_ms,
      lastSyncAt: row.last_sync_at,
      nextSyncAt: row.next_sync_at,
      lastSyncCount: row.last_sync_count,
      lastSyncError: row.last_sync_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Get current sync configuration
   */
  getConfig(): SyncConfig {
    const row = this.stmts.get.get() as SyncConfigRow | undefined
    if (!row) {
      // Should never happen due to ensureTable(), but handle gracefully
      return {
        id: 'default',
        enabled: true,
        frequency: 'daily',
        intervalMs: FREQUENCY_INTERVALS.daily,
        lastSyncAt: null,
        nextSyncAt: null,
        lastSyncCount: 0,
        lastSyncError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }
    return this.rowToConfig(row)
  }

  /**
   * Update sync configuration
   */
  updateConfig(update: SyncConfigUpdate): SyncConfig {
    const current = this.getConfig()

    const enabled = update.enabled ?? current.enabled
    const frequency = update.frequency ?? current.frequency
    const intervalMs = FREQUENCY_INTERVALS[frequency]

    this.stmts.update.run(enabled ? 1 : 0, frequency, intervalMs)

    // If frequency changed, recalculate next sync
    if (update.frequency && current.lastSyncAt) {
      const nextSync = this.calculateNextSync(current.lastSyncAt, intervalMs)
      this.stmts.setNextSync.run(nextSync)
    }

    return this.getConfig()
  }

  /**
   * Record successful sync completion
   */
  setLastSync(timestamp: string, count: number): void {
    this.stmts.setLastSync.run(timestamp, count)

    // Calculate next sync time
    const config = this.getConfig()
    const nextSync = this.calculateNextSync(timestamp, config.intervalMs)
    this.stmts.setNextSync.run(nextSync)
  }

  /**
   * Record sync error
   */
  setLastSyncError(error: string): void {
    this.stmts.setLastSyncError.run(error)
  }

  /**
   * Clear any stored error
   */
  clearError(): void {
    this.stmts.clearError.run()
  }

  /**
   * Calculate next sync time based on last sync and interval
   */
  calculateNextSync(lastSyncAt: string, intervalMs: number): string {
    const lastSync = new Date(lastSyncAt)
    const nextSync = new Date(lastSync.getTime() + intervalMs)
    return nextSync.toISOString()
  }

  /**
   * Check if sync is due based on current time
   */
  isSyncDue(): boolean {
    const config = this.getConfig()

    // If never synced, it's due
    if (!config.lastSyncAt) {
      return true
    }

    // If no next sync calculated, calculate it
    if (!config.nextSyncAt) {
      const nextSync = this.calculateNextSync(config.lastSyncAt, config.intervalMs)
      this.stmts.setNextSync.run(nextSync)
      return new Date() >= new Date(nextSync)
    }

    return new Date() >= new Date(config.nextSyncAt)
  }

  /**
   * Enable automatic sync
   */
  enable(): SyncConfig {
    return this.updateConfig({ enabled: true })
  }

  /**
   * Disable automatic sync
   */
  disable(): SyncConfig {
    return this.updateConfig({ enabled: false })
  }

  /**
   * Set sync frequency
   */
  setFrequency(frequency: SyncFrequency): SyncConfig {
    return this.updateConfig({ frequency })
  }
}
