/**
 * SMI-914: Analytics Storage with SQLite
 *
 * Provides persistent storage for skill usage events with:
 * - SQLite database in ~/.skillsmith/analytics.db
 * - 30-day rolling window for data retention
 * - Efficient indexes for querying by skill and timestamp
 */

import Database from 'better-sqlite3'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync } from 'fs'
import type { SkillUsageEvent, SkillMetrics } from './types.js'
import { RETENTION_DAYS, MS_PER_DAY } from './constants.js'

/**
 * Default directory for analytics data
 */
const ANALYTICS_DIR = join(homedir(), '.skillsmith')

/**
 * Default database file path
 */
const ANALYTICS_DB = join(ANALYTICS_DIR, 'analytics.db')

/**
 * SQLite storage for skill usage analytics
 */
export class AnalyticsStorage {
  private db: Database.Database

  /**
   * Create an analytics storage instance
   *
   * @param dbPath - Optional custom database path (defaults to ~/.skillsmith/analytics.db)
   */
  constructor(dbPath: string = ANALYTICS_DB) {
    // Ensure directory exists
    const dir = dbPath === ANALYTICS_DB ? ANALYTICS_DIR : join(dbPath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.initSchema()
  }

  /**
   * Initialize database schema
   */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        task_duration INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'error', 'abandoned')),
        context_hash TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_id ON usage_events(skill_id);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_user_id ON usage_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_outcome ON usage_events(outcome);
    `)
  }

  /**
   * Record a skill usage event
   *
   * @param event - The usage event to record
   */
  recordEvent(event: SkillUsageEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO usage_events (skill_id, user_id, timestamp, task_duration, outcome, context_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      event.skillId,
      event.userId,
      event.timestamp,
      event.taskDuration,
      event.outcome,
      event.contextHash
    )
  }

  /**
   * Get all events for a skill
   *
   * @param skillId - The skill identifier
   * @param limit - Maximum number of events to return
   * @returns Array of usage events
   */
  getEventsForSkill(skillId: string, limit: number = 100): SkillUsageEvent[] {
    const stmt = this.db.prepare(`
      SELECT id, skill_id as skillId, user_id as userId, timestamp,
             task_duration as taskDuration, outcome, context_hash as contextHash
      FROM usage_events
      WHERE skill_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    return stmt.all(skillId, limit) as SkillUsageEvent[]
  }

  /**
   * Get aggregated metrics for a skill
   *
   * @param skillId - The skill identifier
   * @returns Aggregated metrics or null if no data
   */
  getMetricsForSkill(skillId: string): SkillMetrics | null {
    const stmt = this.db.prepare(`
      SELECT
        skill_id as skillId,
        COUNT(*) as totalInvocations,
        CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as successRate,
        AVG(task_duration) as avgTaskDuration,
        COUNT(DISTINCT user_id) as uniqueUsers,
        MAX(timestamp) as lastUsed
      FROM usage_events
      WHERE skill_id = ?
      GROUP BY skill_id
    `)
    const result = stmt.get(skillId) as SkillMetrics | undefined
    return result ?? null
  }

  /**
   * Delete events older than retention period
   *
   * @returns Number of deleted events
   */
  cleanup(): number {
    const cutoff = Date.now() - RETENTION_DAYS * MS_PER_DAY
    const result = this.db.prepare('DELETE FROM usage_events WHERE timestamp < ?').run(cutoff)
    return result.changes
  }

  /**
   * Get total event count
   *
   * @returns Number of stored events
   */
  getEventCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM usage_events').get() as {
      count: number
    }
    return result?.count ?? 0
  }

  /**
   * Get event count by outcome
   *
   * @returns Object with counts per outcome type
   */
  getOutcomeCounts(): Record<string, number> {
    const stmt = this.db.prepare(`
      SELECT outcome, COUNT(*) as count
      FROM usage_events
      GROUP BY outcome
    `)
    const rows = stmt.all() as Array<{ outcome: string; count: number }>
    return rows.reduce(
      (acc, row) => {
        acc[row.outcome] = row.count
        return acc
      },
      {} as Record<string, number>
    )
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close()
  }
}
