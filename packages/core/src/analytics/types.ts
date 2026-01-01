/**
 * Type definitions for Analytics Infrastructure
 *
 * Covers:
 * - Skill usage events and attribution
 * - A/B testing experiments
 * - ROI metrics and dashboards
 */

/**
 * Skill usage event types
 */
export type UsageEventType = 'activation' | 'invocation' | 'success' | 'failure'

/**
 * Skill usage event
 */
export interface UsageEvent {
  id: string
  skillId: string
  userId: string
  sessionId: string
  eventType: UsageEventType
  context?: Record<string, unknown>
  valueScore?: number
  timestamp: string
  createdAt: string
}

/**
 * Input for creating a usage event
 */
export interface UsageEventInput {
  skillId: string
  userId: string
  sessionId: string
  eventType: UsageEventType
  context?: Record<string, unknown>
  valueScore?: number
}

/**
 * Experiment status
 */
export type ExperimentStatus = 'draft' | 'active' | 'paused' | 'completed'

/**
 * Experiment variant
 */
export type ExperimentVariant = 'control' | 'treatment'

/**
 * A/B testing experiment
 */
export interface Experiment {
  id: string
  name: string
  description?: string
  hypothesis?: string
  status: ExperimentStatus
  variantA: Record<string, unknown> // Control group config
  variantB: Record<string, unknown> // Treatment group config
  startDate?: string
  endDate?: string
  targetSampleSize: number
  createdAt: string
  updatedAt: string
}

/**
 * Input for creating an experiment
 */
export interface ExperimentInput {
  name: string
  description?: string
  hypothesis?: string
  variantA: Record<string, unknown>
  variantB: Record<string, unknown>
  targetSampleSize?: number
}

/**
 * Experiment assignment
 */
export interface ExperimentAssignment {
  id: string
  experimentId: string
  userId: string
  variant: ExperimentVariant
  assignedAt: string
}

/**
 * Experiment outcome measurement
 */
export interface ExperimentOutcome {
  id: string
  experimentId: string
  assignmentId: string
  outcomeType: string
  outcomeValue: number
  metadata?: Record<string, unknown>
  measuredAt: string
  createdAt: string
}

/**
 * Input for recording an outcome
 */
export interface OutcomeInput {
  experimentId: string
  assignmentId: string
  outcomeType: string
  outcomeValue: number
  metadata?: Record<string, unknown>
}

/**
 * ROI metric types
 */
export type ROIMetricType = 'daily' | 'weekly' | 'monthly' | 'user' | 'skill'

/**
 * ROI metrics
 */
export interface ROIMetrics {
  id: string
  metricType: ROIMetricType
  entityId?: string // user_id or skill_id
  periodStart: string
  periodEnd: string
  totalActivations: number
  totalInvocations: number
  totalSuccesses: number
  totalFailures: number
  avgValueScore: number
  estimatedTimeSaved: number // minutes
  estimatedValueUsd: number
  metadata?: Record<string, unknown>
  computedAt: string
  createdAt: string
}

/**
 * Value attribution types
 */
export type AttributionType = 'inline' | 'metadata' | 'session'

/**
 * Value dimensions for ROI calculation
 */
export type ValueDimension = 'time_saved' | 'quality_improved' | 'error_prevented'

/**
 * Value attribution
 */
export interface ValueAttribution {
  id: string
  usageEventId: string
  skillId: string
  attributionType: AttributionType
  valueDimension: ValueDimension
  valueAmount: number
  confidence: number // 0-1
  metadata?: Record<string, unknown>
  createdAt: string
}

/**
 * Usage analytics summary for a time period
 */
export interface UsageAnalyticsSummary {
  periodStart: string
  periodEnd: string
  totalEvents: number
  eventsByType: Record<UsageEventType, number>
  uniqueUsers: number
  uniqueSkills: number
  avgValueScore: number
  topSkills: Array<{ skillId: string; count: number }>
}

/**
 * Experiment analysis results
 */
export interface ExperimentAnalysis {
  experimentId: string
  experimentName: string
  controlGroup: {
    sampleSize: number
    outcomes: Record<string, { mean: number; stdDev: number }>
  }
  treatmentGroup: {
    sampleSize: number
    outcomes: Record<string, { mean: number; stdDev: number }>
  }
  pValues: Record<string, number>
  confidenceIntervals: Record<string, { lower: number; upper: number }>
  recommendation: 'continue' | 'stop_control_wins' | 'stop_treatment_wins' | 'inconclusive'
}

/**
 * ROI dashboard data
 */
export interface ROIDashboard {
  user?: {
    userId: string
    totalTimeSaved: number // minutes
    estimatedValueUsd: number
    topSkills: Array<{ skillId: string; skillName: string; timeSaved: number }>
    weeklyTrend: Array<{ week: string; timeSaved: number }>
  }
  stakeholder?: {
    totalUsers: number
    totalActivations: number
    avgTimeSavedPerUser: number
    totalEstimatedValue: number
    adoptionRate: number // percentage
    skillLeaderboard: Array<{
      skillId: string
      skillName: string
      userCount: number
      totalValue: number
    }>
  }
}

/**
 * Export format options
 */
export type ExportFormat = 'json' | 'csv' | 'pdf'

/**
 * Export options
 */
export interface ExportOptions {
  format: ExportFormat
  startDate?: string
  endDate?: string
  includeCharts?: boolean // for PDF exports
}
