/**
 * @fileoverview Context Scoring System for ranking skill suggestion relevance
 * @module @skillsmith/core/triggers/ContextScorer
 * @see Phase 4: Trigger System Architecture
 *
 * Scores the relevance of skill suggestions based on:
 * - Number and type of triggers fired
 * - Confidence levels of triggers
 * - Recency of trigger events
 * - User feedback history
 *
 * @example
 * const scorer = new ContextScorer();
 * const score = scorer.scoreContext(triggers, codebaseContext);
 * if (score.score >= 0.6) {
 *   // High relevance - suggest skills
 * }
 */

import type { DetectedTrigger } from './TriggerDetector.js'
import type { CodebaseContext } from '../analysis/CodebaseAnalyzer.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('ContextScorer')

/**
 * Context score result
 */
export interface ContextScore {
  /** Overall relevance score (0-1) */
  score: number
  /** Confidence in the suggestion (0-1) */
  confidence: number
  /** Which triggers contributed to the score */
  triggers: string[]
  /** Human-readable explanation */
  reason: string
  /** Recommended skill categories */
  recommendedCategories: string[]
}

/**
 * Weights for different trigger types in context scoring
 */
export interface ContextScoringWeights {
  /** Weight for file pattern triggers (default: 0.4) */
  fileWeight: number
  /** Weight for command triggers (default: 0.3) */
  commandWeight: number
  /** Weight for error triggers (default: 0.2) */
  errorWeight: number
  /** Weight for project structure triggers (default: 0.3) */
  projectWeight: number
}

/**
 * Options for context scoring
 */
export interface ContextScorerOptions {
  /** Custom weights for trigger types */
  weights?: Partial<ContextScoringWeights>
  /** Boost score for multiple triggers (default: true) */
  multiTriggerBoost?: boolean
  /** Boost multiplier for multiple triggers (default: 1.2) */
  multiTriggerMultiplier?: number
  /** Enable debug logging */
  debug?: boolean
}

/**
 * Default scoring weights
 */
const DEFAULT_WEIGHTS: ContextScoringWeights = {
  fileWeight: 0.4,
  commandWeight: 0.3,
  errorWeight: 0.2,
  projectWeight: 0.3,
}

/**
 * ContextScorer - Scores skill suggestion relevance
 *
 * Uses a weighted scoring algorithm to determine how relevant
 * skill suggestions would be based on detected triggers.
 */
export class ContextScorer {
  private readonly weights: ContextScoringWeights
  private readonly multiTriggerBoost: boolean
  private readonly multiTriggerMultiplier: number
  private readonly debug: boolean

  constructor(options: ContextScorerOptions = {}) {
    this.weights = {
      ...DEFAULT_WEIGHTS,
      ...options.weights,
    }
    this.multiTriggerBoost = options.multiTriggerBoost ?? true
    this.multiTriggerMultiplier = options.multiTriggerMultiplier ?? 1.2
    this.debug = options.debug ?? false

    if (this.debug) {
      log.info('ContextScorer initialized', {
        weights: this.weights,
        multiTriggerBoost: this.multiTriggerBoost,
        multiTriggerMultiplier: this.multiTriggerMultiplier,
      })
    }
  }

  /**
   * Score the context based on detected triggers
   *
   * @param triggers - Detected triggers from TriggerDetector
   * @param codebaseContext - Optional codebase analysis
   * @returns Context score with recommendations
   */
  scoreContext(
    triggers: DetectedTrigger[],
    codebaseContext?: CodebaseContext | null
  ): ContextScore {
    if (triggers.length === 0) {
      return {
        score: 0,
        confidence: 0,
        triggers: [],
        reason: 'No triggers detected',
        recommendedCategories: [],
      }
    }

    // Group triggers by type
    const triggersByType = this.groupTriggersByType(triggers)

    // Calculate weighted score
    let totalScore = 0
    let totalWeight = 0

    // File triggers
    if (triggersByType.file.length > 0) {
      const fileScore = this.calculateTypeScore(triggersByType.file)
      totalScore += fileScore * this.weights.fileWeight
      totalWeight += this.weights.fileWeight
    }

    // Command triggers
    if (triggersByType.command.length > 0) {
      const commandScore = this.calculateTypeScore(triggersByType.command)
      totalScore += commandScore * this.weights.commandWeight
      totalWeight += this.weights.commandWeight
    }

    // Error triggers
    if (triggersByType.error.length > 0) {
      const errorScore = this.calculateTypeScore(triggersByType.error)
      totalScore += errorScore * this.weights.errorWeight
      totalWeight += this.weights.errorWeight
    }

    // Project triggers
    if (triggersByType.project.length > 0) {
      const projectScore = this.calculateTypeScore(triggersByType.project)
      totalScore += projectScore * this.weights.projectWeight
      totalWeight += this.weights.projectWeight
    }

    // Normalize by total weight
    let finalScore = totalWeight > 0 ? totalScore / totalWeight : 0

    // Apply multi-trigger boost
    const uniqueTriggerTypes = Object.keys(triggersByType).filter(
      (type) => triggersByType[type as keyof typeof triggersByType].length > 0
    )

    if (this.multiTriggerBoost && uniqueTriggerTypes.length > 1) {
      const boostFactor = Math.min(
        this.multiTriggerMultiplier,
        1 + (uniqueTriggerTypes.length - 1) * 0.1
      )
      finalScore = Math.min(1, finalScore * boostFactor)

      if (this.debug) {
        log.debug('Applied multi-trigger boost', {
          uniqueTriggerTypes: uniqueTriggerTypes.length,
          boostFactor,
          originalScore: totalScore / totalWeight,
          boostedScore: finalScore,
        })
      }
    }

    // Calculate confidence
    const confidence = this.calculateConfidence(
      triggers,
      uniqueTriggerTypes.length,
      codebaseContext
    )

    // Extract recommended categories
    const recommendedCategories = this.extractRecommendedCategories(triggers)

    // Generate reason
    const reason = this.generateReason(triggers, triggersByType, finalScore)

    return {
      score: Math.round(finalScore * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      triggers: uniqueTriggerTypes,
      reason,
      recommendedCategories,
    }
  }

  /**
   * Group triggers by type
   */
  private groupTriggersByType(triggers: DetectedTrigger[]): {
    file: DetectedTrigger[]
    command: DetectedTrigger[]
    error: DetectedTrigger[]
    project: DetectedTrigger[]
  } {
    const grouped = {
      file: [] as DetectedTrigger[],
      command: [] as DetectedTrigger[],
      error: [] as DetectedTrigger[],
      project: [] as DetectedTrigger[],
    }

    for (const trigger of triggers) {
      grouped[trigger.type].push(trigger)
    }

    return grouped
  }

  /**
   * Calculate score for a specific trigger type
   */
  private calculateTypeScore(triggers: DetectedTrigger[]): number {
    if (triggers.length === 0) return 0

    // Take the maximum confidence from this type
    const maxConfidence = Math.max(...triggers.map((t) => t.confidence))

    // If multiple triggers of same type, boost slightly
    const countBoost = triggers.length > 1 ? 1.1 : 1.0

    return Math.min(1, maxConfidence * countBoost)
  }

  /**
   * Calculate confidence in the suggestion
   */
  private calculateConfidence(
    triggers: DetectedTrigger[],
    uniqueTypeCount: number,
    codebaseContext?: CodebaseContext | null
  ): number {
    // Base confidence on average trigger confidence
    const avgConfidence = triggers.reduce((sum, t) => sum + t.confidence, 0) / triggers.length

    // Boost for multiple trigger types
    const diversityBoost = uniqueTypeCount > 1 ? 0.1 * (uniqueTypeCount - 1) : 0

    // Boost for codebase analysis
    const contextBoost = codebaseContext && codebaseContext.frameworks.length > 0 ? 0.1 : 0

    return Math.min(1, avgConfidence + diversityBoost + contextBoost)
  }

  /**
   * Extract recommended skill categories from triggers
   */
  private extractRecommendedCategories(triggers: DetectedTrigger[]): string[] {
    const categories = new Set<string>()

    for (const trigger of triggers) {
      for (const category of trigger.categories) {
        categories.add(category)
      }
    }

    return Array.from(categories)
  }

  /**
   * Generate human-readable reason for the score
   */
  private generateReason(
    allTriggers: DetectedTrigger[],
    triggersByType: ReturnType<typeof this.groupTriggersByType>,
    score: number
  ): string {
    const parts: string[] = []

    if (triggersByType.file.length > 0) {
      const fileNames = triggersByType.file
        .map((t) => t.source?.split('/').pop() || 'files')
        .slice(0, 2)
      parts.push(`Working with ${fileNames.join(', ')}`)
    }

    if (triggersByType.command.length > 0) {
      const commands = triggersByType.command
        .map((t) => t.source?.split(' ')[0] || 'commands')
        .slice(0, 2)
      parts.push(`Running ${commands.join(', ')} commands`)
    }

    if (triggersByType.error.length > 0) {
      parts.push('Encountered relevant errors')
    }

    if (triggersByType.project.length > 0) {
      const frameworks = allTriggers
        .filter((t) => t.type === 'project')
        .flatMap((t) => t.categories)
        .slice(0, 2)
      parts.push(`Detected ${frameworks.join(', ')} in project`)
    }

    if (parts.length === 0) {
      return 'Context analysis suggests relevant skills'
    }

    const contextSummary = parts.join('; ')

    if (score >= 0.8) {
      return `Strong match: ${contextSummary}`
    } else if (score >= 0.6) {
      return `Good match: ${contextSummary}`
    } else if (score >= 0.4) {
      return `Moderate match: ${contextSummary}`
    } else {
      return `Weak match: ${contextSummary}`
    }
  }

  /**
   * Determine if score meets threshold for suggestion
   *
   * @param score - Context score result
   * @returns Whether to suggest skills
   */
  shouldSuggest(score: ContextScore): boolean {
    // High relevance: always suggest
    if (score.score >= 0.6) {
      return true
    }

    // Medium relevance: suggest if high confidence
    if (score.score >= 0.4 && score.confidence >= 0.7) {
      return true
    }

    // Otherwise don't suggest
    return false
  }

  /**
   * Get suggestion urgency level
   *
   * @param score - Context score result
   * @returns Urgency level
   */
  getUrgency(score: ContextScore): 'high' | 'medium' | 'low' {
    if (score.score >= 0.8) {
      return 'high'
    } else if (score.score >= 0.6) {
      return 'medium'
    } else {
      return 'low'
    }
  }
}

export default ContextScorer
