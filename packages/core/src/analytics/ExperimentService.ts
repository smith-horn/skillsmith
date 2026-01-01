/**
 * ExperimentService - Epic 4: A/B Testing Infrastructure
 *
 * Implements:
 * - Experiment assignment system with balanced randomization
 * - Outcome tracking and data collection
 * - Basic statistical analysis
 * - Experiment lifecycle management
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { AnalyticsRepository } from './AnalyticsRepository.js'
import type {
  Experiment,
  ExperimentInput,
  ExperimentAssignment,
  ExperimentVariant,
  ExperimentOutcome,
  OutcomeInput,
  ExperimentAnalysis,
} from './types.js'

export class ExperimentService {
  private repo: AnalyticsRepository

  constructor(db: DatabaseType) {
    this.repo = new AnalyticsRepository(db)
  }

  /**
   * Create a new experiment
   */
  createExperiment(input: ExperimentInput): Experiment {
    return this.repo.createExperiment(input)
  }

  /**
   * Start an experiment
   */
  startExperiment(experimentId: string): boolean {
    const experiment = this.repo.getExperiment(experimentId)
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`)
    }

    if (experiment.status !== 'draft') {
      throw new Error(`Cannot start experiment in status: ${experiment.status}`)
    }

    return this.repo.updateExperimentStatus(experimentId, 'active')
  }

  /**
   * Pause an experiment
   */
  pauseExperiment(experimentId: string): boolean {
    return this.repo.updateExperimentStatus(experimentId, 'paused')
  }

  /**
   * Complete an experiment
   */
  completeExperiment(experimentId: string): boolean {
    return this.repo.updateExperimentStatus(experimentId, 'completed')
  }

  /**
   * Assign a user to an experiment (with balanced randomization)
   */
  assignUser(experimentId: string, userId: string): ExperimentAssignment {
    // Check if user is already assigned
    const existing = this.repo.getUserAssignment(experimentId, userId)
    if (existing) {
      return existing
    }

    // Get current assignments to maintain balance
    const assignments = this.repo.getExperimentAssignments(experimentId)
    const controlCount = assignments.filter((a) => a.variant === 'control').length
    const treatmentCount = assignments.filter((a) => a.variant === 'treatment').length

    // Assign to the variant with fewer users, or randomize if equal
    let variant: ExperimentVariant
    if (controlCount < treatmentCount) {
      variant = 'control'
    } else if (treatmentCount < controlCount) {
      variant = 'treatment'
    } else {
      // Equal, randomize
      variant = Math.random() < 0.5 ? 'control' : 'treatment'
    }

    return this.repo.assignUserToExperiment(experimentId, userId, variant)
  }

  /**
   * Get user's variant for an experiment
   */
  getUserVariant(experimentId: string, userId: string): ExperimentVariant | null {
    const assignment = this.repo.getUserAssignment(experimentId, userId)
    return assignment?.variant ?? null
  }

  /**
   * Record an experiment outcome
   */
  recordOutcome(input: OutcomeInput): ExperimentOutcome {
    return this.repo.recordOutcome(input)
  }

  /**
   * Analyze experiment results
   */
  analyzeExperiment(experimentId: string): ExperimentAnalysis {
    const experiment = this.repo.getExperiment(experimentId)
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`)
    }

    const assignments = this.repo.getExperimentAssignments(experimentId)
    const outcomes = this.repo.getExperimentOutcomes(experimentId)

    // Group assignments by variant
    const controlAssignments = assignments.filter((a) => a.variant === 'control')
    const treatmentAssignments = assignments.filter((a) => a.variant === 'treatment')

    // Group outcomes by variant
    const controlOutcomes = outcomes.filter((o) => {
      const assignment = assignments.find((a) => a.id === o.assignmentId)
      return assignment?.variant === 'control'
    })

    const treatmentOutcomes = outcomes.filter((o) => {
      const assignment = assignments.find((a) => a.id === o.assignmentId)
      return assignment?.variant === 'treatment'
    })

    // Calculate statistics for each outcome type
    const outcomeTypes = new Set(outcomes.map((o) => o.outcomeType))
    const controlStats: Record<string, { mean: number; stdDev: number }> = {}
    const treatmentStats: Record<string, { mean: number; stdDev: number }> = {}
    const pValues: Record<string, number> = {}
    const confidenceIntervals: Record<string, { lower: number; upper: number }> = {}

    for (const outcomeType of outcomeTypes) {
      const controlValues = controlOutcomes
        .filter((o) => o.outcomeType === outcomeType)
        .map((o) => o.outcomeValue)
      const treatmentValues = treatmentOutcomes
        .filter((o) => o.outcomeType === outcomeType)
        .map((o) => o.outcomeValue)

      controlStats[outcomeType] = this.calculateStats(controlValues)
      treatmentStats[outcomeType] = this.calculateStats(treatmentValues)

      // Simple t-test (simplified, not production-ready)
      pValues[outcomeType] = this.tTest(controlValues, treatmentValues)

      // 95% confidence interval for difference
      confidenceIntervals[outcomeType] = this.calculateConfidenceInterval(
        controlValues,
        treatmentValues
      )
    }

    // Make recommendation
    const recommendation = this.makeRecommendation(
      pValues,
      controlStats,
      treatmentStats,
      assignments.length,
      experiment.targetSampleSize
    )

    return {
      experimentId,
      experimentName: experiment.name,
      controlGroup: {
        sampleSize: controlAssignments.length,
        outcomes: controlStats,
      },
      treatmentGroup: {
        sampleSize: treatmentAssignments.length,
        outcomes: treatmentStats,
      },
      pValues,
      confidenceIntervals,
      recommendation,
    }
  }

  /**
   * Get all active experiments
   */
  getActiveExperiments(): Experiment[] {
    return this.repo.getActiveExperiments()
  }

  // ==================== Private Statistical Methods ====================

  private calculateStats(values: number[]): { mean: number; stdDev: number } {
    if (values.length === 0) {
      return { mean: 0, stdDev: 0 }
    }

    const mean = values.reduce((sum, val) => sum + val, 0) / values.length
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length
    const stdDev = Math.sqrt(variance)

    return { mean, stdDev }
  }

  /**
   * Simplified t-test (for demonstration purposes)
   * In production, use a proper statistics library
   */
  private tTest(control: number[], treatment: number[]): number {
    if (control.length === 0 || treatment.length === 0) {
      return 1.0 // No difference if no data
    }

    const controlStats = this.calculateStats(control)
    const treatmentStats = this.calculateStats(treatment)

    // Pooled standard deviation
    const pooledStdDev = Math.sqrt(
      (Math.pow(controlStats.stdDev, 2) + Math.pow(treatmentStats.stdDev, 2)) / 2
    )

    if (pooledStdDev === 0) {
      return controlStats.mean === treatmentStats.mean ? 1.0 : 0.0
    }

    // T-statistic
    const t =
      (treatmentStats.mean - controlStats.mean) /
      (pooledStdDev * Math.sqrt(1 / control.length + 1 / treatment.length))

    // Very simplified p-value estimation (not accurate for production)
    // In production, use a proper t-distribution table or library
    const pValue = 2 * (1 - this.normalCDF(Math.abs(t)))

    return Math.max(0, Math.min(1, pValue))
  }

  /**
   * Normal CDF approximation (Zelen & Severo 1964)
   */
  private normalCDF(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z))
    const d = 0.3989423 * Math.exp((-z * z) / 2)
    const prob =
      d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))

    return z > 0 ? 1 - prob : prob
  }

  /**
   * Calculate 95% confidence interval for difference in means
   */
  private calculateConfidenceInterval(
    control: number[],
    treatment: number[]
  ): { lower: number; upper: number } {
    if (control.length === 0 || treatment.length === 0) {
      return { lower: 0, upper: 0 }
    }

    const controlStats = this.calculateStats(control)
    const treatmentStats = this.calculateStats(treatment)
    const diff = treatmentStats.mean - controlStats.mean

    const pooledStdDev = Math.sqrt(
      (Math.pow(controlStats.stdDev, 2) + Math.pow(treatmentStats.stdDev, 2)) / 2
    )
    const standardError = pooledStdDev * Math.sqrt(1 / control.length + 1 / treatment.length)

    // 95% CI using 1.96 (z-score for 95%)
    const margin = 1.96 * standardError

    return {
      lower: diff - margin,
      upper: diff + margin,
    }
  }

  /**
   * Make a recommendation based on statistical analysis
   */
  private makeRecommendation(
    pValues: Record<string, number>,
    controlStats: Record<string, { mean: number; stdDev: number }>,
    treatmentStats: Record<string, { mean: number; stdDev: number }>,
    currentSampleSize: number,
    targetSampleSize: number
  ): ExperimentAnalysis['recommendation'] {
    // Check if we have enough data
    if (currentSampleSize < targetSampleSize) {
      return 'continue'
    }

    // Check for statistical significance (p < 0.05)
    const significantOutcomes = Object.entries(pValues).filter(([_, p]) => p < 0.05)

    if (significantOutcomes.length === 0) {
      return 'inconclusive'
    }

    // Check direction of effect for significant outcomes
    let treatmentBetter = 0
    let controlBetter = 0

    for (const [outcomeType] of significantOutcomes) {
      const controlMean = controlStats[outcomeType].mean
      const treatmentMean = treatmentStats[outcomeType].mean

      if (treatmentMean > controlMean) {
        treatmentBetter++
      } else {
        controlBetter++
      }
    }

    if (treatmentBetter > controlBetter) {
      return 'stop_treatment_wins'
    } else if (controlBetter > treatmentBetter) {
      return 'stop_control_wins'
    } else {
      return 'inconclusive'
    }
  }
}
