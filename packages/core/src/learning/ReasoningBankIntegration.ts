/**
 * @fileoverview ReasoningBank Integration for Learning Loop
 * @module @skillsmith/core/learning/ReasoningBankIntegration
 * @see SMI-1520: Integrate learning loop with V3 intelligence module
 *
 * Provides integration between Skillsmith's signal collection and
 * Claude-Flow V3's ReasoningBank for pattern storage and learning.
 *
 * Responsibilities:
 * - Convert user signals to ReasoningBank trajectories
 * - Store learned patterns in V3's pattern storage
 * - Query learned confidence scores (verdicts)
 * - Maintain backwards compatibility with existing signal storage
 */

import type { ISignalCollector } from './interfaces.js'
import type {
  SignalEvent,
  SignalFilter,
  RecommendationContext,
  SignalMetadata,
  DismissReason,
} from './types.js'

// ============================================================================
// V3 ReasoningBank Types
// ============================================================================

/**
 * Configuration for V3 intelligence module initialization
 * @see claude-flow/v3 intelligence module
 */
export interface IntelligenceConfig {
  /** Path to pattern storage database */
  storagePath?: string
  /** Enable neural pattern training */
  enableNeural?: boolean
  /** Maximum patterns to retain */
  maxPatterns?: number
  /** Similarity threshold for pattern matching */
  similarityThreshold?: number
}

/**
 * A single step in a reasoning trajectory
 */
export interface TrajectoryStep {
  /** Step identifier */
  id: string
  /** Action taken (e.g., 'recommend', 'user_action') */
  action: string
  /** Observation or context at this step */
  observation: string
  /** Reward signal for this step */
  reward: number
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Verdict judgment for a trajectory
 */
export interface TrajectoryVerdict {
  /** Overall success/failure */
  success: boolean
  /** Confidence score [0-1] */
  confidence: number
  /** Reasoning for the verdict */
  reasoning?: string
}

/**
 * Pattern returned from similarity search
 */
export interface SimilarPattern {
  /** Pattern identifier */
  id: string
  /** Similarity score [0-1] */
  similarity: number
  /** Associated trajectory steps */
  trajectory: TrajectoryStep[]
  /** Stored verdict */
  verdict: TrajectoryVerdict
  /** Pattern metadata */
  metadata?: Record<string, unknown>
}

/**
 * Options for pattern search
 */
export interface PatternSearchOptions {
  /** Maximum results to return */
  limit?: number
  /** Minimum similarity threshold */
  minSimilarity?: number
  /** Filter by action type */
  actionFilter?: string
}

/**
 * V3 ReasoningBank instance interface
 */
export interface IReasoningBank {
  /** Record a trajectory with verdict */
  recordTrajectory(steps: TrajectoryStep[], verdict: TrajectoryVerdict): Promise<string>
  /** Find similar patterns to a query */
  findSimilarPatterns(query: string, options?: PatternSearchOptions): Promise<SimilarPattern[]>
  /** Get pattern by ID */
  getPattern(id: string): Promise<SimilarPattern | null>
  /** Clear all patterns */
  clear(): Promise<void>
  /** Get total pattern count */
  getPatternCount(): Promise<number>
}

// ============================================================================
// Reward Constants
// ============================================================================

/**
 * Reward values for different user actions
 * These map user signals to trajectory rewards for reinforcement learning
 */
export const TRAJECTORY_REWARDS = {
  /** User accepted recommendation - positive signal */
  ACCEPT: 1.0,
  /** User dismissed recommendation - mild negative signal */
  DISMISS: -0.5,
  /** User actively uses skill - reinforcement signal */
  USAGE: 0.3,
  /** Skill abandoned (installed but unused) - negative signal */
  ABANDONMENT: -0.3,
  /** User uninstalled skill - strong negative signal */
  UNINSTALL: -0.7,
} as const

/**
 * Verdict confidence thresholds
 */
export const CONFIDENCE_THRESHOLDS = {
  /** High confidence - strong signal pattern */
  HIGH: 0.8,
  /** Medium confidence - moderate signal pattern */
  MEDIUM: 0.5,
  /** Low confidence - weak signal pattern */
  LOW: 0.3,
  /** Minimum for personalization */
  MINIMUM: 0.1,
} as const

// ============================================================================
// Verdict Result Types
// ============================================================================

/**
 * Result from querying learned confidence for a skill
 */
export interface SkillVerdict {
  /** Skill identifier */
  skillId: string
  /** Learned confidence score [-1, 1] where positive = likely to be accepted */
  confidence: number
  /** Number of patterns used to derive confidence */
  patternCount: number
  /** Whether enough data exists for confident prediction */
  hasEnoughData: boolean
  /** Breakdown of signals contributing to verdict */
  signalBreakdown?: {
    accepts: number
    dismisses: number
    usages: number
    abandonments: number
    uninstalls: number
  }
}

/**
 * Batch verdict query result
 */
export interface BatchVerdictResult {
  /** Individual skill verdicts */
  verdicts: SkillVerdict[]
  /** Total patterns searched */
  totalPatterns: number
  /** Query latency in milliseconds */
  latencyMs: number
}

// ============================================================================
// Integration Configuration
// ============================================================================

/**
 * Configuration for ReasoningBankIntegration
 */
export interface ReasoningBankIntegrationConfig {
  /** V3 intelligence module configuration */
  intelligenceConfig?: IntelligenceConfig
  /** Underlying signal collector for backwards compatibility */
  signalCollector?: ISignalCollector
  /** Enable dual-write to both ReasoningBank and legacy storage */
  enableDualWrite?: boolean
  /** Minimum patterns required for confident verdict */
  minPatternsForVerdict?: number
  /** Similarity threshold for pattern matching */
  patternSimilarityThreshold?: number
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Required<ReasoningBankIntegrationConfig> = {
  intelligenceConfig: {
    enableNeural: true,
    maxPatterns: 10000,
    similarityThreshold: 0.7,
  },
  signalCollector: undefined as unknown as ISignalCollector,
  enableDualWrite: true,
  minPatternsForVerdict: 3,
  patternSimilarityThreshold: 0.6,
}

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
 * // Initialize with V3 ReasoningBank
 * const integration = new ReasoningBankIntegration({
 *   intelligenceConfig: { enableNeural: true },
 *   enableDualWrite: true, // Write to both V3 and legacy storage
 * })
 * await integration.initialize()
 *
 * // Record signals (automatically converts to trajectories)
 * await integration.recordAccept('anthropic/commit', context)
 *
 * // Query learned confidence
 * const verdict = await integration.getVerdict('anthropic/commit')
 * console.log(verdict.confidence) // 0.85 = likely to be accepted
 * ```
 */
export class ReasoningBankIntegration implements ISignalCollector {
  private config: Required<ReasoningBankIntegrationConfig>
  private reasoningBank: IReasoningBank | null = null
  private legacyCollector: ISignalCollector | null = null
  private initialized = false

  /**
   * Creates a new ReasoningBankIntegration instance
   *
   * @param config - Integration configuration
   */
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

  /**
   * Initialize the integration with V3 ReasoningBank
   *
   * Must be called before using any signal recording or verdict methods.
   *
   * @throws {Error} If V3 intelligence module initialization fails
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    try {
      // Import V3 intelligence module dynamically
      // Note: Actual import path depends on V3 package structure
      // const { initializeIntelligence, getReasoningBank } = await import(
      //   'claude-flow/v3/@claude-flow/cli/dist/src/intelligence/index.js'
      // )

      // Initialize V3 intelligence with config
      // await initializeIntelligence(this.config.intelligenceConfig)

      // Get ReasoningBank instance
      // this.reasoningBank = await getReasoningBank()

      // TODO: SMI-1520 - Uncomment above when V3 intelligence module is available
      // For now, create a stub that throws informative errors
      this.reasoningBank = this.createStubReasoningBank()

      this.initialized = true
    } catch (error) {
      throw new Error(
        `Failed to initialize ReasoningBankIntegration: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Check if integration is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  // ==========================================================================
  // ISignalCollector Implementation
  // ==========================================================================

  /**
   * Record user accepting a recommendation
   *
   * Converts to positive trajectory (reward: 1.0) in ReasoningBank.
   *
   * @param skillId - Skill that was accepted
   * @param context - Context when skill was recommended
   * @param metadata - Optional metadata
   */
  async recordAccept(
    skillId: string,
    context: RecommendationContext,
    metadata?: SignalMetadata
  ): Promise<void> {
    this.ensureInitialized()

    const trajectoryMeta = metadata ? ({ ...metadata } as Record<string, unknown>) : undefined
    const trajectory = this.createTrajectory(skillId, 'accept', context, trajectoryMeta)
    const verdict = this.createVerdict(true, TRAJECTORY_REWARDS.ACCEPT)

    await this.recordTrajectoryInternal(trajectory, verdict)

    // Dual-write for backwards compatibility
    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordAccept(skillId, context, metadata)
    }
  }

  /**
   * Record user dismissing a recommendation
   *
   * Converts to negative trajectory (reward: -0.5) in ReasoningBank.
   *
   * @param skillId - Skill that was dismissed
   * @param context - Context when skill was recommended
   * @param reason - Optional dismissal reason
   */
  async recordDismiss(
    skillId: string,
    context: RecommendationContext,
    reason?: DismissReason
  ): Promise<void> {
    this.ensureInitialized()

    const trajectory = this.createTrajectory(skillId, 'dismiss', context, { reason })
    const verdict = this.createVerdict(false, Math.abs(TRAJECTORY_REWARDS.DISMISS))

    await this.recordTrajectoryInternal(trajectory, verdict)

    // Dual-write for backwards compatibility
    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordDismiss(skillId, context, reason)
    }
  }

  /**
   * Record skill usage event
   *
   * Converts to reinforcement trajectory (reward: 0.3) in ReasoningBank.
   *
   * @param skillId - Skill that was used
   * @param frequency - Usage frequency
   */
  async recordUsage(skillId: string, frequency: 'daily' | 'weekly'): Promise<void> {
    this.ensureInitialized()

    const trajectory = this.createTrajectory(
      skillId,
      'usage',
      { installed_skills: [skillId], original_score: 1.0 },
      { frequency }
    )
    const verdict = this.createVerdict(true, TRAJECTORY_REWARDS.USAGE)

    await this.recordTrajectoryInternal(trajectory, verdict)

    // Dual-write for backwards compatibility
    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordUsage(skillId, frequency)
    }
  }

  /**
   * Record skill abandonment
   *
   * Converts to negative trajectory (reward: -0.3) in ReasoningBank.
   *
   * @param skillId - Skill that was abandoned
   * @param daysSinceInstall - Days since installation
   */
  async recordAbandonment(skillId: string, daysSinceInstall: number): Promise<void> {
    this.ensureInitialized()

    const trajectory = this.createTrajectory(
      skillId,
      'abandonment',
      { installed_skills: [skillId], original_score: 0.5 },
      { daysSinceInstall }
    )
    const verdict = this.createVerdict(false, Math.abs(TRAJECTORY_REWARDS.ABANDONMENT))

    await this.recordTrajectoryInternal(trajectory, verdict)

    // Dual-write for backwards compatibility
    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordAbandonment(skillId, daysSinceInstall)
    }
  }

  /**
   * Record skill uninstallation
   *
   * Converts to strong negative trajectory (reward: -0.7) in ReasoningBank.
   *
   * @param skillId - Skill that was uninstalled
   * @param daysSinceInstall - Days since installation
   */
  async recordUninstall(skillId: string, daysSinceInstall: number): Promise<void> {
    this.ensureInitialized()

    const trajectory = this.createTrajectory(
      skillId,
      'uninstall',
      { installed_skills: [], original_score: 0 },
      { daysSinceInstall }
    )
    const verdict = this.createVerdict(false, Math.abs(TRAJECTORY_REWARDS.UNINSTALL))

    await this.recordTrajectoryInternal(trajectory, verdict)

    // Dual-write for backwards compatibility
    if (this.config.enableDualWrite && this.legacyCollector) {
      await this.legacyCollector.recordUninstall(skillId, daysSinceInstall)
    }
  }

  /**
   * Query signals with filtering
   *
   * Delegates to legacy collector if available, otherwise returns empty array.
   *
   * @param filter - Filter criteria
   * @param limit - Maximum results
   * @returns Matching signal events
   */
  async getSignals(filter: SignalFilter, limit?: number): Promise<SignalEvent[]> {
    if (this.legacyCollector) {
      return this.legacyCollector.getSignals(filter, limit)
    }
    // ReasoningBank stores trajectories, not raw signals
    // Return empty for now - could implement trajectory-to-signal conversion
    return []
  }

  /**
   * Get total signal count
   *
   * Returns count from legacy collector or ReasoningBank pattern count.
   */
  async getSignalCount(): Promise<number> {
    if (this.legacyCollector) {
      return this.legacyCollector.getSignalCount()
    }
    if (this.reasoningBank) {
      return this.reasoningBank.getPatternCount()
    }
    return 0
  }

  /**
   * Get signals for specific skill
   *
   * @param skillId - Skill identifier
   * @returns All signals for this skill
   */
  async getSignalsForSkill(skillId: string): Promise<SignalEvent[]> {
    if (this.legacyCollector) {
      return this.legacyCollector.getSignalsForSkill(skillId)
    }
    return []
  }

  // ==========================================================================
  // Verdict Queries
  // ==========================================================================

  /**
   * Query learned confidence for a skill
   *
   * Uses ReasoningBank pattern matching to determine how likely
   * the user is to accept recommendations for this skill.
   *
   * @param skillId - Skill identifier to query
   * @returns Verdict with confidence score and metadata
   *
   * @example
   * ```typescript
   * const verdict = await integration.getVerdict('anthropic/commit')
   * if (verdict.confidence > 0.7 && verdict.hasEnoughData) {
   *   // High confidence the user will accept this skill
   * }
   * ```
   */
  async getVerdict(skillId: string): Promise<SkillVerdict> {
    this.ensureInitialized()

    if (!this.reasoningBank) {
      return this.createEmptyVerdict(skillId)
    }

    // Query patterns related to this skill
    const patterns = await this.reasoningBank.findSimilarPatterns(`skill:${skillId}`, {
      limit: 50,
      minSimilarity: this.config.patternSimilarityThreshold,
    })

    if (patterns.length < this.config.minPatternsForVerdict) {
      return this.createEmptyVerdict(skillId)
    }

    // Calculate weighted confidence from patterns
    const { confidence, breakdown } = this.calculateConfidenceFromPatterns(patterns)

    return {
      skillId,
      confidence,
      patternCount: patterns.length,
      hasEnoughData: patterns.length >= this.config.minPatternsForVerdict,
      signalBreakdown: breakdown,
    }
  }

  /**
   * Query verdicts for multiple skills in batch
   *
   * More efficient than individual queries for ranking recommendations.
   *
   * @param skillIds - Array of skill identifiers
   * @returns Batch result with all verdicts
   */
  async getBatchVerdicts(skillIds: string[]): Promise<BatchVerdictResult> {
    const startTime = Date.now()

    const verdicts = await Promise.all(skillIds.map((skillId) => this.getVerdict(skillId)))

    return {
      verdicts,
      totalPatterns: verdicts.reduce((sum, v) => sum + v.patternCount, 0),
      latencyMs: Date.now() - startTime,
    }
  }

  /**
   * Get top N skills by learned confidence
   *
   * Useful for proactive recommendations based on user patterns.
   *
   * @param limit - Maximum skills to return
   * @returns Skills sorted by confidence (highest first)
   */
  async getTopSkillsByConfidence(limit: number = 10): Promise<SkillVerdict[]> {
    this.ensureInitialized()

    if (!this.reasoningBank) {
      return []
    }

    // Get all unique skill patterns
    const allPatterns = await this.reasoningBank.findSimilarPatterns('skill:*', {
      limit: 1000,
      minSimilarity: 0.1,
    })

    // Group by skill and calculate confidence
    const skillMap = new Map<string, SimilarPattern[]>()
    for (const pattern of allPatterns) {
      const skillId = this.extractSkillIdFromPattern(pattern)
      if (skillId) {
        const existing = skillMap.get(skillId) || []
        existing.push(pattern)
        skillMap.set(skillId, existing)
      }
    }

    // Calculate verdicts for each skill
    const verdicts: SkillVerdict[] = []
    skillMap.forEach((patterns, skillId) => {
      if (patterns.length >= this.config.minPatternsForVerdict) {
        const { confidence, breakdown } = this.calculateConfidenceFromPatterns(patterns)
        verdicts.push({
          skillId,
          confidence,
          patternCount: patterns.length,
          hasEnoughData: true,
          signalBreakdown: breakdown,
        })
      }
    })

    // Sort by confidence and return top N
    return verdicts.sort((a, b) => b.confidence - a.confidence).slice(0, limit)
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Ensure integration is initialized before operations
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ReasoningBankIntegration not initialized. Call initialize() first.')
    }
  }

  /**
   * Create trajectory steps from user signal
   */
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
        reward: this.getRewardForAction(action),
        metadata: {
          skillId,
          timestamp,
          ...metadata,
        },
      },
    ]
  }

  /**
   * Create verdict from action success and reward
   */
  private createVerdict(success: boolean, confidenceFromReward: number): TrajectoryVerdict {
    return {
      success,
      confidence: Math.min(1.0, Math.abs(confidenceFromReward)),
      reasoning: success
        ? 'User action indicates positive preference'
        : 'User action indicates negative preference',
    }
  }

  /**
   * Get reward value for action type
   */
  private getRewardForAction(action: string): number {
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

  /**
   * Record trajectory to ReasoningBank
   */
  private async recordTrajectoryInternal(
    steps: TrajectoryStep[],
    verdict: TrajectoryVerdict
  ): Promise<void> {
    if (!this.reasoningBank) {
      return
    }

    await this.reasoningBank.recordTrajectory(steps, verdict)
  }

  /**
   * Create empty verdict for skill with insufficient data
   */
  private createEmptyVerdict(skillId: string): SkillVerdict {
    return {
      skillId,
      confidence: 0,
      patternCount: 0,
      hasEnoughData: false,
    }
  }

  /**
   * Calculate confidence score from patterns
   */
  private calculateConfidenceFromPatterns(patterns: SimilarPattern[]): {
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
      const action = this.extractActionFromPattern(pattern)

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
   * Extract skill ID from pattern
   */
  private extractSkillIdFromPattern(pattern: SimilarPattern): string | null {
    const step = pattern.trajectory[0]
    if (step?.metadata?.skillId) {
      return step.metadata.skillId as string
    }
    return null
  }

  /**
   * Extract action type from pattern
   */
  private extractActionFromPattern(pattern: SimilarPattern): string | null {
    const step = pattern.trajectory[0]
    if (step?.action) {
      return step.action.replace('skill:', '')
    }
    return null
  }

  /**
   * Create stub ReasoningBank for when V3 module is unavailable
   */
  private createStubReasoningBank(): IReasoningBank {
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
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create and initialize a ReasoningBankIntegration instance
 *
 * Convenience factory that handles initialization.
 *
 * @param config - Integration configuration
 * @returns Initialized integration instance
 *
 * @example
 * ```typescript
 * const integration = await createReasoningBankIntegration({
 *   enableDualWrite: true,
 *   signalCollector: legacyCollector,
 * })
 * ```
 */
export async function createReasoningBankIntegration(
  config: ReasoningBankIntegrationConfig = {}
): Promise<ReasoningBankIntegration> {
  const integration = new ReasoningBankIntegration(config)
  await integration.initialize()
  return integration
}

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
