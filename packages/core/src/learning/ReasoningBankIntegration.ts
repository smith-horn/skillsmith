/**
 * @fileoverview ReasoningBank Integration for Learning Loop
 * @module @skillsmith/core/learning/ReasoningBankIntegration
 * @see SMI-1520: Integrate learning loop with V3 intelligence module
 *
 * Provides integration between Skillsmith's signal collection and
 * Claude-Flow V3's ReasoningBank for pattern storage and learning.
 */

import type { ISignalCollector } from './interfaces.js'
import type {
  SignalEvent,
  SignalFilter,
  RecommendationContext,
  SignalMetadata,
  DismissReason,
} from './types.js'

// Re-export types for public API
export type {
  IntelligenceConfig,
  TrajectoryStep,
  TrajectoryVerdict,
  SimilarPattern,
  PatternSearchOptions,
  IReasoningBank,
  SkillVerdict,
  BatchVerdictResult,
  ReasoningBankIntegrationConfig,
} from './ReasoningBankIntegration.types.js'
export {
  TRAJECTORY_REWARDS,
  CONFIDENCE_THRESHOLDS,
  DEFAULT_CONFIG,
} from './ReasoningBankIntegration.types.js'

// Re-export helpers
export {
  hasConfidentVerdict,
  indicatesPreference,
  indicatesRejection,
} from './ReasoningBankIntegration.helpers.js'

// Internal imports
import type {
  TrajectoryStep,
  TrajectoryVerdict,
  SimilarPattern,
  IReasoningBank,
  SkillVerdict,
  BatchVerdictResult,
  ReasoningBankIntegrationConfig,
} from './ReasoningBankIntegration.types.js'
import { TRAJECTORY_REWARDS, DEFAULT_CONFIG } from './ReasoningBankIntegration.types.js'
import {
  getRewardForAction,
  extractSkillIdFromPattern,
  calculateConfidenceFromPatterns,
  createEmptyVerdict,
  createVerdict,
  createStubReasoningBank,
} from './ReasoningBankIntegration.helpers.js'

// ============================================================================
// Main Integration Class
// ============================================================================

/**
 * ReasoningBankIntegration bridges Skillsmith's learning loop with V3's intelligence module.
 *
 * This class:
 * 1. Implements ISignalCollector for drop-in replacement
 * 2. Converts user signals to ReasoningBank trajectories
 * 3. Provides verdict queries for learned skill confidence
 * 4. Maintains backwards compatibility via dual-write mode
 *
 * @example
 * ```typescript
 * const integration = new ReasoningBankIntegration({
 *   intelligenceConfig: { enableNeural: true },
 *   enableDualWrite: true,
 * })
 * await integration.initialize()
 *
 * await integration.recordAccept('anthropic/commit', context)
 * const verdict = await integration.getVerdict('anthropic/commit')
 * ```
 */
export class ReasoningBankIntegration implements ISignalCollector {
  private config: Required<ReasoningBankIntegrationConfig>
  private reasoningBank: IReasoningBank | null = null
  private legacyCollector: ISignalCollector | null = null
  private initialized = false

  constructor(config: ReasoningBankIntegrationConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      intelligenceConfig: {
        ...DEFAULT_CONFIG.intelligenceConfig,
        ...config.intelligenceConfig,
      },
    }
    this.legacyCollector = config.signalCollector ?? null
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return

    try {
      // TODO: SMI-1520 - Uncomment when V3 intelligence module is available
      // const { initializeIntelligence, getReasoningBank } = await import(
      //   'claude-flow/v3/@claude-flow/cli/dist/src/intelligence/index.js'
      // )
      // await initializeIntelligence(this.config.intelligenceConfig)
      // this.reasoningBank = await getReasoningBank()

      this.reasoningBank = createStubReasoningBank()
      this.initialized = true
    } catch (error) {
      throw new Error(
        `Failed to initialize ReasoningBankIntegration: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  isInitialized(): boolean {
    return this.initialized
  }

  // ==========================================================================
  // ISignalCollector Implementation
  // ==========================================================================

  async recordAccept(
    skillId: string,
    context: RecommendationContext,
    metadata?: SignalMetadata
  ): Promise<void> {
    this.ensureInitialized()

    const trajectoryMeta = metadata ? ({ ...metadata } as Record<string, unknown>) : undefined
    const trajectory = this.createTrajectory(skillId, 'accept', context, trajectoryMeta)
    const verdict = createVerdict(true, TRAJECTORY_REWARDS.ACCEPT)

    await this.recordTrajectoryInternal(trajectory, verdict)

    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordAccept(skillId, context, metadata)
    }
  }

  async recordDismiss(
    skillId: string,
    context: RecommendationContext,
    reason?: DismissReason
  ): Promise<void> {
    this.ensureInitialized()

    const trajectory = this.createTrajectory(skillId, 'dismiss', context, { reason })
    const verdict = createVerdict(false, Math.abs(TRAJECTORY_REWARDS.DISMISS))

    await this.recordTrajectoryInternal(trajectory, verdict)

    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordDismiss(skillId, context, reason)
    }
  }

  async recordUsage(skillId: string, frequency: 'daily' | 'weekly'): Promise<void> {
    this.ensureInitialized()

    const trajectory = this.createTrajectory(
      skillId,
      'usage',
      { installed_skills: [skillId], original_score: 1.0 },
      { frequency }
    )
    const verdict = createVerdict(true, TRAJECTORY_REWARDS.USAGE)

    await this.recordTrajectoryInternal(trajectory, verdict)

    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordUsage(skillId, frequency)
    }
  }

  async recordAbandonment(skillId: string, daysSinceInstall: number): Promise<void> {
    this.ensureInitialized()

    const trajectory = this.createTrajectory(
      skillId,
      'abandonment',
      { installed_skills: [skillId], original_score: 0.5 },
      { daysSinceInstall }
    )
    const verdict = createVerdict(false, Math.abs(TRAJECTORY_REWARDS.ABANDONMENT))

    await this.recordTrajectoryInternal(trajectory, verdict)

    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordAbandonment(skillId, daysSinceInstall)
    }
  }

  async recordUninstall(skillId: string, daysSinceInstall: number): Promise<void> {
    this.ensureInitialized()

    const trajectory = this.createTrajectory(
      skillId,
      'uninstall',
      { installed_skills: [], original_score: 0 },
      { daysSinceInstall }
    )
    const verdict = createVerdict(false, Math.abs(TRAJECTORY_REWARDS.UNINSTALL))

    await this.recordTrajectoryInternal(trajectory, verdict)

    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordUninstall(skillId, daysSinceInstall)
    }
  }

  async getSignals(filter: SignalFilter, limit?: number): Promise<SignalEvent[]> {
    if (this.legacyCollector) {
      return this.legacyCollector.getSignals(filter, limit)
    }
    return []
  }

  async getSignalCount(): Promise<number> {
    if (this.legacyCollector) {
      return this.legacyCollector.getSignalCount()
    }
    if (this.reasoningBank) {
      return this.reasoningBank.getPatternCount()
    }
    return 0
  }

  async getSignalsForSkill(skillId: string): Promise<SignalEvent[]> {
    if (this.legacyCollector) {
      return this.legacyCollector.getSignalsForSkill(skillId)
    }
    return []
  }

  // ==========================================================================
  // Verdict Queries
  // ==========================================================================

  async getVerdict(skillId: string): Promise<SkillVerdict> {
    this.ensureInitialized()

    if (!this.reasoningBank) {
      return createEmptyVerdict(skillId)
    }

    const patterns = await this.reasoningBank.findSimilarPatterns(`skill:${skillId}`, {
      limit: 50,
      minSimilarity: this.config.patternSimilarityThreshold,
    })

    if (patterns.length < this.config.minPatternsForVerdict) {
      return createEmptyVerdict(skillId)
    }

    const { confidence, breakdown } = calculateConfidenceFromPatterns(patterns)

    return {
      skillId,
      confidence,
      patternCount: patterns.length,
      hasEnoughData: patterns.length >= this.config.minPatternsForVerdict,
      signalBreakdown: breakdown,
    }
  }

  async getBatchVerdicts(skillIds: string[]): Promise<BatchVerdictResult> {
    const startTime = Date.now()
    const verdicts = await Promise.all(skillIds.map((skillId) => this.getVerdict(skillId)))

    return {
      verdicts,
      totalPatterns: verdicts.reduce((sum, v) => sum + v.patternCount, 0),
      latencyMs: Date.now() - startTime,
    }
  }

  async getTopSkillsByConfidence(limit: number = 10): Promise<SkillVerdict[]> {
    this.ensureInitialized()

    if (!this.reasoningBank) {
      return []
    }

    const allPatterns = await this.reasoningBank.findSimilarPatterns('skill:*', {
      limit: 1000,
      minSimilarity: 0.1,
    })

    const skillMap = new Map<string, SimilarPattern[]>()
    for (const pattern of allPatterns) {
      const skillId = extractSkillIdFromPattern(pattern)
      if (skillId) {
        const existing = skillMap.get(skillId) || []
        existing.push(pattern)
        skillMap.set(skillId, existing)
      }
    }

    const verdicts: SkillVerdict[] = []
    skillMap.forEach((patterns, skillId) => {
      if (patterns.length >= this.config.minPatternsForVerdict) {
        const { confidence, breakdown } = calculateConfidenceFromPatterns(patterns)
        verdicts.push({
          skillId,
          confidence,
          patternCount: patterns.length,
          hasEnoughData: true,
          signalBreakdown: breakdown,
        })
      }
    })

    return verdicts.sort((a, b) => b.confidence - a.confidence).slice(0, limit)
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ReasoningBankIntegration not initialized. Call initialize() first.')
    }
  }

  private createTrajectory(
    skillId: string,
    action: string,
    context: RecommendationContext,
    metadata?: Record<string, unknown>
  ): TrajectoryStep[] {
    const timestamp = Date.now()

    return [
      {
        id: `${skillId}-${action}-${timestamp}`,
        action: `skill:${action}`,
        observation: JSON.stringify({
          skill_id: skillId,
          context,
          ...metadata,
        }),
        reward: getRewardForAction(action),
        metadata: {
          skillId,
          timestamp,
          ...metadata,
        },
      },
    ]
  }

  private async recordTrajectoryInternal(
    steps: TrajectoryStep[],
    verdict: TrajectoryVerdict
  ): Promise<void> {
    if (!this.reasoningBank) return
    await this.reasoningBank.recordTrajectory(steps, verdict)
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create and initialize a ReasoningBankIntegration instance
 */
export async function createReasoningBankIntegration(
  config: ReasoningBankIntegrationConfig = {}
): Promise<ReasoningBankIntegration> {
  const integration = new ReasoningBankIntegration(config)
  await integration.initialize()
  return integration
}
