/**
 * AnalyticsRepository Helpers
 *
 * Helper functions for transforming database rows to domain objects.
 */

import type {
  UsageEvent,
  UsageEventType,
  Experiment,
  ExperimentStatus,
  ExperimentAssignment,
  ExperimentVariant,
  ExperimentOutcome,
  ROIMetrics,
  ROIMetricType,
} from './types.js'

import type {
  UsageEventRow,
  ExperimentRow,
  ExperimentAssignmentRow,
  ExperimentOutcomeRow,
  ROIMetricsRow,
} from './AnalyticsRepository.types.js'

/**
 * Convert a usage event row to a UsageEvent object
 */
export function rowToUsageEvent(row: UsageEventRow): UsageEvent {
  return {
    id: row.id,
    skillId: row.skill_id,
    userId: row.user_id,
    sessionId: row.session_id,
    eventType: row.event_type as UsageEventType,
    context: row.context ? JSON.parse(row.context) : undefined,
    valueScore: row.value_score ?? undefined,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  }
}

/**
 * Convert a database row to an Experiment object
 */
export function rowToExperiment(row: ExperimentRow): Experiment {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    hypothesis: row.hypothesis ?? undefined,
    status: row.status as ExperimentStatus,
    variantA: JSON.parse(row.variant_a),
    variantB: JSON.parse(row.variant_b),
    startDate: row.start_date ?? undefined,
    endDate: row.end_date ?? undefined,
    targetSampleSize: row.target_sample_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Convert an assignment row to an ExperimentAssignment object
 */
export function rowToAssignment(row: ExperimentAssignmentRow): ExperimentAssignment {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    userId: row.user_id,
    variant: row.variant as ExperimentVariant,
    assignedAt: row.assigned_at,
  }
}

/**
 * Convert an outcome row to an ExperimentOutcome object
 */
export function rowToOutcome(row: ExperimentOutcomeRow): ExperimentOutcome {
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
 * Convert a ROI metrics row to a ROIMetrics object
 */
export function rowToROIMetrics(row: ROIMetricsRow): ROIMetrics {
  return {
    id: row.id,
    metricType: row.metric_type as ROIMetricType,
    entityId: row.entity_id ?? undefined,
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
