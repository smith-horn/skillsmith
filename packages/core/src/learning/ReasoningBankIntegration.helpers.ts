/**
 * ReasoningBank Integration Helper Functions
 * @module @skillsmith/core/learning/ReasoningBankIntegration.helpers
 */

import type {
  SkillVerdict,
  SimilarPattern,
  TrajectoryStep,
  TrajectoryVerdict,
  IReasoningBank,
  PatternSearchOptions,
} from './ReasoningBankIntegration.types.js'
import { TRAJECTORY_REWARDS, CONFIDENCE_THRESHOLDS } from './ReasoningBankIntegration.types.js'

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a verdict has sufficient data for personalization
 */
export function hasConfidentVerdict(verdict: SkillVerdict): boolean {
  return verdict.hasEnoughData && Math.abs(verdict.confidence) >= CONFIDENCE_THRESHOLDS.MINIMUM
}

/**
 * Check if verdict indicates user preference (positive confidence)
 */
export function indicatesPreference(verdict: SkillVerdict): boolean {
  return verdict.confidence > CONFIDENCE_THRESHOLDS.LOW && verdict.hasEnoughData
}

/**
 * Check if verdict indicates user rejection (negative confidence)
 */
export function indicatesRejection(verdict: SkillVerdict): boolean {
  return verdict.confidence < -CONFIDENCE_THRESHOLDS.LOW && verdict.hasEnoughData
}

// ============================================================================
// Reward Helpers
// ============================================================================

/**
 * Get reward value for action type
 */
export function getRewardForAction(action: string): number {
  switch (action) {
    case 'accept':
      return TRAJECTORY_REWARDS.ACCEPT
    case 'dismiss':
      return TRAJECTORY_REWARDS.DISMISS
    case 'usage':
      return TRAJECTORY_REWARDS.USAGE
    case 'abandonment':
      return TRAJECTORY_REWARDS.ABANDONMENT
    case 'uninstall':
      return TRAJECTORY_REWARDS.UNINSTALL
    default:
      return 0
  }
}

// ============================================================================
// Pattern Helpers
// ============================================================================

/**
 * Extract skill ID from pattern
 */
export function extractSkillIdFromPattern(pattern: SimilarPattern): string | null {
  const step = pattern.trajectory[0]
  if (step?.metadata?.skillId) {
    return step.metadata.skillId as string
  }
  return null
}

/**
 * Extract action type from pattern
 */
export function extractActionFromPattern(pattern: SimilarPattern): string | null {
  const step = pattern.trajectory[0]
  if (step?.action) {
    return step.action.replace('skill:', '')
  }
  return null
}

/**
 * Calculate confidence score from patterns
 */
export function calculateConfidenceFromPatterns(patterns: SimilarPattern[]): {
  confidence: number
  breakdown: SkillVerdict['signalBreakdown']
} {
  let positiveWeight = 0
  let negativeWeight = 0
  const breakdown = {
    accepts: 0,
    dismisses: 0,
    usages: 0,
    abandonments: 0,
    uninstalls: 0,
  }

  for (const pattern of patterns) {
    const weight = pattern.similarity * pattern.verdict.confidence
    const action = extractActionFromPattern(pattern)

    switch (action) {
      case 'accept':
        positiveWeight += weight * TRAJECTORY_REWARDS.ACCEPT
        breakdown.accepts++
        break
      case 'dismiss':
        negativeWeight += weight * Math.abs(TRAJECTORY_REWARDS.DISMISS)
        breakdown.dismisses++
        break
      case 'usage':
        positiveWeight += weight * TRAJECTORY_REWARDS.USAGE
        breakdown.usages++
        break
      case 'abandonment':
        negativeWeight += weight * Math.abs(TRAJECTORY_REWARDS.ABANDONMENT)
        breakdown.abandonments++
        break
      case 'uninstall':
        negativeWeight += weight * Math.abs(TRAJECTORY_REWARDS.UNINSTALL)
        breakdown.uninstalls++
        break
    }
  }

  // Normalize confidence to [-1, 1] range
  const totalWeight = positiveWeight + negativeWeight
  const confidence = totalWeight > 0 ? (positiveWeight - negativeWeight) / totalWeight : 0

  return { confidence, breakdown }
}

/**
 * Create empty verdict for skill with insufficient data
 */
export function createEmptyVerdict(skillId: string): SkillVerdict {
  return {
    skillId,
    confidence: 0,
    patternCount: 0,
    hasEnoughData: false,
  }
}

/**
 * Create verdict from action success and reward
 */
export function createVerdict(success: boolean, confidenceFromReward: number): TrajectoryVerdict {
  return {
    success,
    confidence: Math.min(1.0, Math.abs(confidenceFromReward)),
    reasoning: success
      ? 'User action indicates positive preference'
      : 'User action indicates negative preference',
  }
}

// ============================================================================
// Stub ReasoningBank
// ============================================================================

/**
 * Create stub ReasoningBank for when V3 module is unavailable
 */
export function createStubReasoningBank(): IReasoningBank {
  const patterns: Map<string, SimilarPattern> = new Map()

  return {
    async recordTrajectory(steps: TrajectoryStep[], verdict: TrajectoryVerdict): Promise<string> {
      const id = `pattern-${Date.now()}-${Math.random().toString(36).slice(2)}`
      patterns.set(id, { id, similarity: 1.0, trajectory: steps, verdict })
      return id
    },

    async findSimilarPatterns(
      query: string,
      options?: PatternSearchOptions
    ): Promise<SimilarPattern[]> {
      const limit = options?.limit ?? 10
      const minSimilarity = options?.minSimilarity ?? 0.5

      return Array.from(patterns.values())
        .filter((p) => {
          // Simple query matching for stub
          if (query.startsWith('skill:')) {
            const skillId = query.replace('skill:', '')
            const patternSkillId = p.trajectory[0]?.metadata?.skillId as string | undefined
            return skillId === '*' || patternSkillId === skillId
          }
          return true
        })
        .filter((p) => p.similarity >= minSimilarity)
        .slice(0, limit)
    },

    async getPattern(id: string): Promise<SimilarPattern | null> {
      return patterns.get(id) ?? null
    },

    async clear(): Promise<void> {
      patterns.clear()
    },

    async getPatternCount(): Promise<number> {
      return patterns.size
    },
  }
}
