/**
 * AnalyticsRepository Internal Types
 *
 * Raw database row types used for type-safe parsing of external database data.
 * These are internal types for the repository implementation.
 */

/**
 * Raw database row type for skill_usage_events table
 * Used for type-safe parsing of external database data
 */
export interface UsageEventRow {
  id: string
  skill_id: string
  user_id: string
  session_id: string
  event_type: string
  context: string | null
  value_score: number | null
  timestamp: string
  created_at: string
}

/**
 * Raw database row type for experiments table
 */
export interface ExperimentRow {
  id: string
  name: string
  description: string | null
  hypothesis: string | null
  status: string
  variant_a: string
  variant_b: string
  start_date: string | null
  end_date: string | null
  target_sample_size: number
  created_at: string
  updated_at: string
}

/**
 * Raw database row type for experiment_assignments table
 */
export interface ExperimentAssignmentRow {
  id: string
  experiment_id: string
  user_id: string
  variant: string
  assigned_at: string
}

/**
 * Raw database row type for experiment_outcomes table
 */
export interface ExperimentOutcomeRow {
  id: string
  experiment_id: string
  assignment_id: string
  outcome_type: string
  outcome_value: number
  metadata: string | null
  measured_at: string
  created_at: string
}

/**
 * Raw database row type for roi_metrics table
 */
export interface ROIMetricsRow {
  id: string
  metric_type: string
  entity_id: string | null
  period_start: string
  period_end: string
  total_activations: number
  total_invocations: number
  total_successes: number
  total_failures: number
  avg_value_score: number
  estimated_time_saved: number
  estimated_value_usd: number
  metadata: string | null
  computed_at: string
  created_at: string
}
