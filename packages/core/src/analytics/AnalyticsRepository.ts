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
  ValueAttribution,
  ExperimentVariant,
  ExperimentStatus,
} from './types.js'

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
   */
  recordUsageEvent(input: UsageEventInput): UsageEvent {
    const id = randomUUID()
    const context = input.context ? JSON.stringify(input.context) : null

    const stmt = this.db.prepare(`
      INSERT INTO skill_usage_events (id, skill_id, user_id, session_id, event_type, context, value_score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      id,
      input.skillId,
      input.userId,
      input.sessionId,
      input.eventType,
      context,
      input.valueScore ?? null
    )

    return this.getUsageEvent(id)!
  }

  /**
   * Get a usage event by ID
   */
  getUsageEvent(id: string): UsageEvent | null {
    const row = this.db.prepare('SELECT * FROM skill_usage_events WHERE id = ?').get(id) as any

    if (!row) return null

    return {
      id: row.id,
      skillId: row.skill_id,
      userId: row.user_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      context: row.context ? JSON.parse(row.context) : undefined,
      valueScore: row.value_score,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    }
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
      .all(skillId, startDate, endDate) as any[]

    return rows.map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      userId: row.user_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      context: row.context ? JSON.parse(row.context) : undefined,
      valueScore: row.value_score,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    }))
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
      .all(userId, startDate, endDate) as any[]

    return rows.map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      userId: row.user_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      context: row.context ? JSON.parse(row.context) : undefined,
      valueScore: row.value_score,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    }))
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
      .all(startDate, endDate) as any[]

    return rows.map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      userId: row.user_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      context: row.context ? JSON.parse(row.context) : undefined,
      valueScore: row.value_score,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    }))
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
    const row = this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as any

    if (!row) return null

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      hypothesis: row.hypothesis,
      status: row.status,
      variantA: JSON.parse(row.variant_a),
      variantB: JSON.parse(row.variant_b),
      startDate: row.start_date,
      endDate: row.end_date,
      targetSampleSize: row.target_sample_size,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Get experiment by name
   */
  getExperimentByName(name: string): Experiment | null {
    const row = this.db.prepare('SELECT * FROM experiments WHERE name = ?').get(name) as any

    if (!row) return null

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      hypothesis: row.hypothesis,
      status: row.status,
      variantA: JSON.parse(row.variant_a),
      variantB: JSON.parse(row.variant_b),
      startDate: row.start_date,
      endDate: row.end_date,
      targetSampleSize: row.target_sample_size,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
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
      .all() as any[]

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      hypothesis: row.hypothesis,
      status: row.status,
      variantA: JSON.parse(row.variant_a),
      variantB: JSON.parse(row.variant_b),
      startDate: row.start_date,
      endDate: row.end_date,
      targetSampleSize: row.target_sample_size,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
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
      .get(experimentId, userId) as any

    return {
      id: row.id,
      experimentId: row.experiment_id,
      userId: row.user_id,
      variant: row.variant,
      assignedAt: row.assigned_at,
    }
  }

  /**
   * Get user's assignment for an experiment
   */
  getUserAssignment(experimentId: string, userId: string): ExperimentAssignment | null {
    const row = this.db
      .prepare('SELECT * FROM experiment_assignments WHERE experiment_id = ? AND user_id = ?')
      .get(experimentId, userId) as any

    if (!row) return null

    return {
      id: row.id,
      experimentId: row.experiment_id,
      userId: row.user_id,
      variant: row.variant,
      assignedAt: row.assigned_at,
    }
  }

  /**
   * Get all assignments for an experiment
   */
  getExperimentAssignments(experimentId: string): ExperimentAssignment[] {
    const rows = this.db
      .prepare('SELECT * FROM experiment_assignments WHERE experiment_id = ?')
      .all(experimentId) as any[]

    return rows.map((row) => ({
      id: row.id,
      experimentId: row.experiment_id,
      userId: row.user_id,
      variant: row.variant,
      assignedAt: row.assigned_at,
    }))
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

    const row = this.db.prepare('SELECT * FROM experiment_outcomes WHERE id = ?').get(id) as any

    return {
      id: row.id,
      experimentId: row.experiment_id,
      assignmentId: row.assignment_id,
      outcomeType: row.outcome_type,
      outcomeValue: row.outcome_value,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      measuredAt: row.measured_at,
      createdAt: row.created_at,
    }
  }

  /**
   * Get outcomes for an experiment
   */
  getExperimentOutcomes(experimentId: string): ExperimentOutcome[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM experiment_outcomes WHERE experiment_id = ? ORDER BY measured_at DESC'
      )
      .all(experimentId) as any[]

    return rows.map((row) => ({
      id: row.id,
      experimentId: row.experiment_id,
      assignmentId: row.assignment_id,
      outcomeType: row.outcome_type,
      outcomeValue: row.outcome_value,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      measuredAt: row.measured_at,
      createdAt: row.created_at,
    }))
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

    const row = this.db.prepare('SELECT * FROM roi_metrics WHERE id = ?').get(id) as any

    return this.rowToROIMetrics(row)
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
      .all(metricType, startDate, endDate) as any[]

    return rows.map((row) => this.rowToROIMetrics(row))
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
      .all(entityId, startDate, endDate) as any[]

    return rows.map((row) => this.rowToROIMetrics(row))
  }

  private rowToROIMetrics(row: any): ROIMetrics {
    return {
      id: row.id,
      metricType: row.metric_type,
      entityId: row.entity_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      totalActivations: row.total_activations,
      totalInvocations: row.total_invocations,
      totalSuccesses: row.total_successes,
      totalFailures: row.total_failures,
      avgValueScore: row.avg_value_score,
      estimatedTimeSaved: row.estimated_time_saved,
      estimatedValueUsd: row.estimated_value_usd,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      computedAt: row.computed_at,
      createdAt: row.created_at,
    }
  }
}
