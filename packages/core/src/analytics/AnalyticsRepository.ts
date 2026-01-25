/**
 * AnalyticsRepository - CRUD operations for analytics data
 *
 * Provides type-safe access to:
 * - Usage event tracking
 * - Experiment management
 * - ROI metrics storage
 * - Value attribution
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  UsageEvent,
  UsageEventInput,
  Experiment,
  ExperimentInput,
  ExperimentAssignment,
  ExperimentOutcome,
  OutcomeInput,
  ROIMetrics,
  ExperimentVariant,
  ExperimentStatus,
} from './types.js'

// Re-export row types for testing
export type {
  UsageEventRow,
  ExperimentRow,
  ExperimentAssignmentRow,
  ExperimentOutcomeRow,
  ROIMetricsRow,
} from './AnalyticsRepository.types.js'

// Internal imports
import type {
  UsageEventRow,
  ExperimentRow,
  ExperimentAssignmentRow,
  ROIMetricsRow,
} from './AnalyticsRepository.types.js'

import {
  rowToUsageEvent,
  rowToExperiment,
  rowToAssignment,
  rowToOutcome,
  rowToROIMetrics,
} from './AnalyticsRepository.helpers.js'

/**
 * Repository for analytics operations
 */
export class AnalyticsRepository {
  private db: DatabaseType

  constructor(db: DatabaseType) {
    this.db = db
  }

  // ==================== Usage Events ====================

  /**
   * Record a skill usage event
   * SMI-992: Explicitly set timestamp from JS Date for fake timer compatibility
   */
  recordUsageEvent(input: UsageEventInput): UsageEvent {
    const id = randomUUID()
    const context = input.context ? JSON.stringify(input.context) : null
    // SMI-992: Use JavaScript Date instead of SQLite datetime('now') for testability
    const timestamp = new Date().toISOString()

    const stmt = this.db.prepare(`
      INSERT INTO skill_usage_events (id, skill_id, user_id, session_id, event_type, context, value_score, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      id,
      input.skillId,
      input.userId,
      input.sessionId,
      input.eventType,
      context,
      input.valueScore ?? null,
      timestamp
    )

    return this.getUsageEvent(id)!
  }

  /**
   * Get a usage event by ID
   */
  getUsageEvent(id: string): UsageEvent | null {
    const row = this.db.prepare('SELECT * FROM skill_usage_events WHERE id = ?').get(id) as
      | UsageEventRow
      | undefined

    if (!row) return null
    return rowToUsageEvent(row)
  }

  /**
   * Get usage events for a skill within a time period
   */
  getUsageEventsForSkill(skillId: string, startDate: string, endDate: string): UsageEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_usage_events
         WHERE skill_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp DESC`
      )
      .all(skillId, startDate, endDate) as UsageEventRow[]

    return rows.map(rowToUsageEvent)
  }

  /**
   * Get usage events for a user
   */
  getUsageEventsForUser(userId: string, startDate: string, endDate: string): UsageEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_usage_events
         WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp DESC`
      )
      .all(userId, startDate, endDate) as UsageEventRow[]

    return rows.map(rowToUsageEvent)
  }

  /**
   * Get all usage events within a time period
   */
  getAllUsageEvents(startDate: string, endDate: string): UsageEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_usage_events
         WHERE timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp DESC`
      )
      .all(startDate, endDate) as UsageEventRow[]

    return rows.map(rowToUsageEvent)
  }

  /**
   * Delete usage events older than the retention period (30 days default)
   */
  cleanupOldEvents(retentionDays: number = 30): number {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
    const cutoff = cutoffDate.toISOString()

    const result = this.db.prepare('DELETE FROM skill_usage_events WHERE timestamp < ?').run(cutoff)

    return result.changes
  }

  // ==================== Experiments ====================

  /**
   * Create a new experiment
   */
  createExperiment(input: ExperimentInput): Experiment {
    const id = randomUUID()
    const variantA = JSON.stringify(input.variantA)
    const variantB = JSON.stringify(input.variantB)

    const stmt = this.db.prepare(`
      INSERT INTO experiments (id, name, description, hypothesis, variant_a, variant_b, target_sample_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      id,
      input.name,
      input.description ?? null,
      input.hypothesis ?? null,
      variantA,
      variantB,
      input.targetSampleSize ?? 100
    )

    return this.getExperiment(id)!
  }

  /**
   * Get an experiment by ID
   */
  getExperiment(id: string): Experiment | null {
    const row = this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as
      | ExperimentRow
      | undefined

    if (!row) return null
    return rowToExperiment(row)
  }

  /**
   * Get experiment by name
   */
  getExperimentByName(name: string): Experiment | null {
    const row = this.db.prepare('SELECT * FROM experiments WHERE name = ?').get(name) as
      | ExperimentRow
      | undefined

    if (!row) return null
    return rowToExperiment(row)
  }

  /**
   * Update experiment status
   */
  updateExperimentStatus(id: string, status: ExperimentStatus): boolean {
    const result = this.db
      .prepare("UPDATE experiments SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id)

    return result.changes > 0
  }

  /**
   * Get all active experiments
   */
  getActiveExperiments(): Experiment[] {
    const rows = this.db
      .prepare("SELECT * FROM experiments WHERE status = 'active' ORDER BY created_at DESC")
      .all() as ExperimentRow[]

    return rows.map(rowToExperiment)
  }

  // ==================== Experiment Assignments ====================

  /**
   * Assign a user to an experiment variant
   */
  assignUserToExperiment(
    experimentId: string,
    userId: string,
    variant: ExperimentVariant
  ): ExperimentAssignment {
    const id = randomUUID()

    const stmt = this.db.prepare(`
      INSERT INTO experiment_assignments (id, experiment_id, user_id, variant)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(experiment_id, user_id) DO UPDATE SET variant = excluded.variant
    `)

    stmt.run(id, experimentId, userId, variant)

    const row = this.db
      .prepare('SELECT * FROM experiment_assignments WHERE experiment_id = ? AND user_id = ?')
      .get(experimentId, userId) as ExperimentAssignmentRow

    return rowToAssignment(row)
  }

  /**
   * Get user's assignment for an experiment
   */
  getUserAssignment(experimentId: string, userId: string): ExperimentAssignment | null {
    const row = this.db
      .prepare('SELECT * FROM experiment_assignments WHERE experiment_id = ? AND user_id = ?')
      .get(experimentId, userId) as ExperimentAssignmentRow | undefined

    if (!row) return null
    return rowToAssignment(row)
  }

  /**
   * Get all assignments for an experiment
   */
  getExperimentAssignments(experimentId: string): ExperimentAssignment[] {
    const rows = this.db
      .prepare('SELECT * FROM experiment_assignments WHERE experiment_id = ?')
      .all(experimentId) as ExperimentAssignmentRow[]

    return rows.map(rowToAssignment)
  }

  // ==================== Experiment Outcomes ====================

  /**
   * Record an experiment outcome
   */
  recordOutcome(input: OutcomeInput): ExperimentOutcome {
    const id = randomUUID()
    const metadata = input.metadata ? JSON.stringify(input.metadata) : null

    const stmt = this.db.prepare(`
      INSERT INTO experiment_outcomes (id, experiment_id, assignment_id, outcome_type, outcome_value, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      id,
      input.experimentId,
      input.assignmentId,
      input.outcomeType,
      input.outcomeValue,
      metadata
    )

    const row = this.db
      .prepare('SELECT * FROM experiment_outcomes WHERE id = ?')
      .get(id) as import('./AnalyticsRepository.types.js').ExperimentOutcomeRow

    return rowToOutcome(row)
  }

  /**
   * Get outcomes for an experiment
   */
  getExperimentOutcomes(experimentId: string): ExperimentOutcome[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM experiment_outcomes WHERE experiment_id = ? ORDER BY measured_at DESC'
      )
      .all(experimentId) as import('./AnalyticsRepository.types.js').ExperimentOutcomeRow[]

    return rows.map(rowToOutcome)
  }

  // ==================== ROI Metrics ====================

  /**
   * Store computed ROI metrics
   */
  storeROIMetrics(metrics: Omit<ROIMetrics, 'id' | 'createdAt'>): ROIMetrics {
    const id = randomUUID()
    const metadata = metrics.metadata ? JSON.stringify(metrics.metadata) : null

    const stmt = this.db.prepare(`
      INSERT INTO roi_metrics (
        id, metric_type, entity_id, period_start, period_end,
        total_activations, total_invocations, total_successes, total_failures,
        avg_value_score, estimated_time_saved, estimated_value_usd, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      id,
      metrics.metricType,
      metrics.entityId ?? null,
      metrics.periodStart,
      metrics.periodEnd,
      metrics.totalActivations,
      metrics.totalInvocations,
      metrics.totalSuccesses,
      metrics.totalFailures,
      metrics.avgValueScore,
      metrics.estimatedTimeSaved,
      metrics.estimatedValueUsd,
      metadata
    )

    const row = this.db.prepare('SELECT * FROM roi_metrics WHERE id = ?').get(id) as ROIMetricsRow
    return rowToROIMetrics(row)
  }

  /**
   * Get ROI metrics for a period
   */
  getROIMetrics(metricType: string, startDate: string, endDate: string): ROIMetrics[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM roi_metrics
         WHERE metric_type = ? AND period_start >= ? AND period_end <= ?
         ORDER BY period_start DESC`
      )
      .all(metricType, startDate, endDate) as ROIMetricsRow[]

    return rows.map(rowToROIMetrics)
  }

  /**
   * Get ROI metrics for a specific entity (user or skill)
   */
  getEntityROIMetrics(entityId: string, startDate: string, endDate: string): ROIMetrics[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM roi_metrics
         WHERE entity_id = ? AND period_start >= ? AND period_end <= ?
         ORDER BY period_start DESC`
      )
      .all(entityId, startDate, endDate) as ROIMetricsRow[]

    return rows.map(rowToROIMetrics)
  }
}
