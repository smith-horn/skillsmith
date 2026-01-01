/**
 * SMI-915: Metrics Aggregator
 *
 * Aggregates skill usage events into actionable metrics for value measurement.
 * Provides:
 * - Per-skill metrics aggregation
 * - Global metrics across all skills
 * - Retention rate calculation
 * - Time-period filtering
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import type { SkillMetrics } from './types.js'

/**
 * Time period for aggregation queries
 */
export interface AggregationPeriod {
  /** Start timestamp in milliseconds */
  start: number
  /** End timestamp in milliseconds */
  end: number
}

/**
 * Global metrics across all skills
 */
export interface GlobalMetrics {
  /** Total number of skill invocations */
  totalInvocations: number
  /** Count of unique users */
  uniqueUsers: number
  /** Overall success rate (0-1) */
  overallSuccessRate: number
  /** Average task duration in milliseconds */
  avgTaskDuration: number
  /** Top skills by invocation count */
  topSkills: Array<{ skillId: string; invocations: number }>
}

/**
 * Row type for skill stats query
 */
interface SkillStatsRow {
  total: number
  successes: number
  avg_duration: number
  unique_users: number
  last_used: number
}

/**
 * Row type for skill ID query
 */
interface SkillIdRow {
  skill_id: string
}

/**
 * Row type for top skills query
 */
interface TopSkillRow {
  skill_id: string
  invocations: number
}

/**
 * Row type for early users query
 */
interface UserIdRow {
  user_id: string
}

/**
 * Row type for count query
 */
interface CountRow {
  count: number
}

/**
 * Aggregates skill usage metrics from the database
 */
export class MetricsAggregator {
  private db: DatabaseType

  /**
   * Create a metrics aggregator
   *
   * @param db - SQLite database instance
   */
  constructor(db: DatabaseType) {
    this.db = db
  }

  /**
   * Get metrics for a specific skill
   *
   * @param skillId - The skill identifier
   * @param period - Optional time period filter
   * @returns Aggregated metrics for the skill
   */
  getSkillMetrics(skillId: string, period?: AggregationPeriod): SkillMetrics {
    const whereClause = period
      ? 'WHERE skill_id = ? AND timestamp >= ? AND timestamp <= ?'
      : 'WHERE skill_id = ?'

    const params = period ? [skillId, period.start, period.end] : [skillId]

    const stats = this.db
      .prepare(
        `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
        AVG(task_duration) as avg_duration,
        COUNT(DISTINCT user_id) as unique_users,
        MAX(timestamp) as last_used
      FROM usage_events
      ${whereClause}
    `
      )
      .get(...params) as SkillStatsRow | undefined

    return {
      skillId,
      totalInvocations: stats?.total || 0,
      successRate: stats && stats.total > 0 ? stats.successes / stats.total : 0,
      avgTaskDuration: Math.round(stats?.avg_duration || 0),
      uniqueUsers: stats?.unique_users || 0,
      lastUsed: stats?.last_used || 0,
    }
  }

  /**
   * Get metrics for all skills
   *
   * @param period - Optional time period filter
   * @returns Array of metrics for each skill
   */
  getAllSkillMetrics(period?: AggregationPeriod): SkillMetrics[] {
    const whereClause = period ? 'WHERE timestamp >= ? AND timestamp <= ?' : ''

    const params = period ? [period.start, period.end] : []

    const skillIds = this.db
      .prepare(`SELECT DISTINCT skill_id FROM usage_events ${whereClause}`)
      .all(...params) as SkillIdRow[]

    return skillIds.map(({ skill_id }) => this.getSkillMetrics(skill_id, period))
  }

  /**
   * Get global metrics across all skills
   *
   * @param period - Optional time period filter
   * @returns Aggregated metrics for all skills
   */
  getGlobalMetrics(period?: AggregationPeriod): GlobalMetrics {
    const whereClause = period ? 'WHERE timestamp >= ? AND timestamp <= ?' : ''

    const params = period ? [period.start, period.end] : []

    const stats = this.db
      .prepare(
        `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
        AVG(task_duration) as avg_duration,
        COUNT(DISTINCT user_id) as unique_users
      FROM usage_events
      ${whereClause}
    `
      )
      .get(...params) as SkillStatsRow | undefined

    const topSkills = this.db
      .prepare(
        `
      SELECT skill_id, COUNT(*) as invocations
      FROM usage_events
      ${whereClause}
      GROUP BY skill_id
      ORDER BY invocations DESC
      LIMIT 10
    `
      )
      .all(...params) as TopSkillRow[]

    return {
      totalInvocations: stats?.total || 0,
      uniqueUsers: stats?.unique_users || 0,
      overallSuccessRate: stats && stats.total > 0 ? stats.successes / stats.total : 0,
      avgTaskDuration: Math.round(stats?.avg_duration || 0),
      topSkills: topSkills.map((s) => ({ skillId: s.skill_id, invocations: s.invocations })),
    }
  }

  /**
   * Calculate retention rate (users who used skill again within N days)
   *
   * @param skillId - The skill identifier
   * @param days - Retention window in days (default: 7)
   * @returns Retention rate (0-1)
   */
  getRetentionRate(skillId: string, days: number = 7): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

    // Get users who used the skill before cutoff
    const earlyUsers = this.db
      .prepare(
        `
      SELECT DISTINCT user_id FROM usage_events
      WHERE skill_id = ? AND timestamp < ?
    `
      )
      .all(skillId, cutoff) as UserIdRow[]

    if (earlyUsers.length === 0) return 0

    // Build parameterized query for returned users
    const placeholders = earlyUsers.map(() => '?').join(',')
    const userIds = earlyUsers.map((u) => u.user_id)

    // Count how many returned after cutoff
    const returnedUsers = this.db
      .prepare(
        `
      SELECT COUNT(DISTINCT user_id) as count FROM usage_events
      WHERE skill_id = ? AND timestamp >= ? AND user_id IN (${placeholders})
    `
      )
      .get(skillId, cutoff, ...userIds) as CountRow

    return returnedUsers.count / earlyUsers.length
  }

  /**
   * Get skills with usage in the specified period
   *
   * @param period - Time period filter
   * @returns Array of skill IDs with usage
   */
  getActiveSkills(period: AggregationPeriod): string[] {
    const skillIds = this.db
      .prepare(
        `
      SELECT DISTINCT skill_id FROM usage_events
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY skill_id
    `
      )
      .all(period.start, period.end) as SkillIdRow[]

    return skillIds.map((row) => row.skill_id)
  }

  /**
   * Get the date range of available data
   *
   * @returns Object with min and max timestamps, or null if no data
   */
  getDataRange(): { minTimestamp: number; maxTimestamp: number } | null {
    const result = this.db
      .prepare(
        `
      SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts
      FROM usage_events
    `
      )
      .get() as { min_ts: number | null; max_ts: number | null }

    if (result.min_ts === null || result.max_ts === null) {
      return null
    }

    return {
      minTimestamp: result.min_ts,
      maxTimestamp: result.max_ts,
    }
  }
}
