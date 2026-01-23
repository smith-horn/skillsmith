/**
 * ReasoningBank Integration Type Definitions
 * @module @skillsmith/core/learning/ReasoningBankIntegration.types
 */

import type { ISignalCollector } from './interfaces.js'

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
