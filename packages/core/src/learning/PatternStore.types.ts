/**
 * @fileoverview PatternStore type definitions and constants
 * @module @skillsmith/core/learning/PatternStore.types
 *
 * Types for EWC++ (Elastic Weight Consolidation++) pattern storage.
 */

// ============================================================================
// EWC++ Configuration Types
// ============================================================================

/**
 * EWC++ algorithm configuration
 *
 * @see https://arxiv.org/abs/1801.10112 (Progress & Compress)
 */
export interface EWCConfig {
  /**
   * Lambda (regularization strength).
   * Higher values = stronger preservation of old patterns.
   *
   * - 0.1-1.0: Allows more plasticity (learning new patterns)
   * - 1.0-10.0: Balanced preservation and learning
   * - 10.0-100.0: Strong preservation (minimal forgetting)
   *
   * @default 5.0
   */
  lambda: number

  /**
   * Decay factor for online Fisher Information updates.
   * Applied to running sum before adding new gradient squared.
   *
   * - 0.9: Fast decay, recent patterns dominate
   * - 0.99: Slow decay, historical patterns preserved longer
   * - 1.0: No decay (original EWC, not recommended)
   *
   * @default 0.95
   */
  fisherDecay: number

  /**
   * Minimum importance threshold for pattern preservation.
   * Patterns below this threshold are eligible for overwriting.
   *
   * @default 0.01
   */
  importanceThreshold: number

  /**
   * Number of patterns to sample for Fisher Information estimation.
   * Higher values = more accurate importance estimates but slower.
   *
   * @default 100
   */
  fisherSampleSize: number

  /**
   * Consolidation trigger threshold.
   * Consolidate when (new_patterns / total_patterns) exceeds this.
   *
   * @default 0.1 (10%)
   */
  consolidationThreshold: number

  /**
   * Maximum patterns to retain before pruning low-importance ones.
   *
   * @default 10000
   */
  maxPatterns: number
}

/**
 * PatternStore configuration
 */
export interface PatternStoreConfig {
  /**
   * Path to SQLite database for pattern storage.
   * If not provided, uses in-memory database.
   */
  dbPath?: string

  /**
   * EWC++ algorithm parameters.
   */
  ewc?: Partial<EWCConfig>

  /**
   * Embedding dimensions (must match embedding model).
   * @default 384 (all-MiniLM-L6-v2)
   */
  dimensions?: number

  /**
   * Enable automatic consolidation on pattern insertion.
   * @default true
   */
  autoConsolidate?: boolean

  /**
   * Enable pattern access tracking for importance boosting.
   * @default true
   */
  trackAccess?: boolean

  /**
   * Enable V3 ReasoningBank integration.
   * @default true (auto-detect)
   */
  useV3Integration?: boolean
}

// ============================================================================
// Default Configuration Constants
// ============================================================================

/**
 * Default EWC++ configuration
 */
export const DEFAULT_EWC_CONFIG: EWCConfig = {
  lambda: 5.0,
  fisherDecay: 0.95,
  importanceThreshold: 0.01,
  fisherSampleSize: 100,
  consolidationThreshold: 0.1,
  maxPatterns: 10000,
}

/**
 * Default PatternStore configuration
 */
export const DEFAULT_PATTERN_STORE_CONFIG: Required<Omit<PatternStoreConfig, 'dbPath'>> & {
  dbPath?: string
} = {
  dbPath: undefined,
  ewc: DEFAULT_EWC_CONFIG,
  dimensions: 384,
  autoConsolidate: true,
  trackAccess: true,
  useV3Integration: true,
}

// ============================================================================
// Pattern Types
// ============================================================================

/**
 * Pattern outcome types aligned with ReasoningBankIntegration rewards
 *
 * @see ReasoningBankIntegration.TRAJECTORY_REWARDS
 */
export type PatternOutcomeType =
  | 'accept' // User accepted recommendation (+1.0)
  | 'usage' // User actively uses skill (+0.3)
  | 'frequent' // User uses skill frequently (+0.5)
  | 'dismiss' // User dismissed recommendation (-0.5)
  | 'abandonment' // Skill installed but unused (-0.3)
  | 'uninstall' // User removed skill (-0.7)

/**
 * Outcome result for a pattern
 */
export interface PatternOutcome {
  /** Type of outcome */
  type: PatternOutcomeType

  /** Reward value [-1.0, 1.0] */
  reward: number

  /** Confidence in this outcome (for partial observations) */
  confidence?: number

  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Reward values for pattern outcomes
 * Matches ReasoningBankIntegration.TRAJECTORY_REWARDS
 */
export const PATTERN_REWARDS: Record<PatternOutcomeType, number> = {
  accept: 1.0,
  usage: 0.3,
  frequent: 0.5,
  dismiss: -0.5,
  abandonment: -0.3,
  uninstall: -0.7,
}

/**
 * Context that led to a recommendation
 */
export interface PatternRecommendationContext {
  /** User's current installed skills */
  installedSkills: string[]

  /** Frameworks/languages detected in project */
  frameworks?: string[]

  /** Keywords from user query or context */
  keywords?: string[]

  /** Time of day (for temporal patterns) */
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night'

  /** Day type (for usage patterns) */
  dayType?: 'weekday' | 'weekend'

  /** Session duration in minutes */
  sessionDuration?: number

  /** Number of recommendations shown in session */
  recommendationsShown?: number
}

/**
 * Skill features used in pattern matching
 */
export interface SkillFeatures {
  /** Skill identifier (author/name format) */
  skillId: string

  /** Skill category */
  category?: string

  /** Trust tier (verified, community, experimental) */
  trustTier?: string

  /** Skill keywords/tags */
  keywords?: string[]

  /** Trigger phrases */
  triggerPhrases?: string[]

  /** Quality score [0-100] */
  qualityScore?: number

  /** Install count */
  installCount?: number
}

/**
 * Complete pattern definition
 */
export interface Pattern {
  /** Unique pattern identifier (auto-generated if not provided) */
  id?: string

  /** Recommendation context that led to this match */
  context: PatternRecommendationContext

  /** Skill that was recommended */
  skill: SkillFeatures

  /** Original recommendation score [0-1] */
  originalScore: number

  /** Source of the recommendation (search, recommend, install) */
  source: 'search' | 'recommend' | 'install' | 'compare'
}

/**
 * Stored pattern with computed fields
 */
export interface StoredPattern extends Pattern {
  /** Pattern ID (guaranteed after storage) */
  id: string

  /** Context embedding vector */
  contextEmbedding: Float32Array

  /** Pattern outcome */
  outcome: PatternOutcome

  /** Pattern importance (from Fisher Information) */
  importance: number

  /** Number of times this pattern was accessed */
  accessCount: number

  /** Creation timestamp */
  createdAt: Date

  /** Last access timestamp */
  lastAccessedAt: Date
}

/**
 * Pattern query for similarity search
 */
export interface PatternQuery {
  /** Context to match against */
  context: PatternRecommendationContext

  /** Optional skill to filter by */
  skillId?: string

  /** Optional category filter */
  category?: string

  /** Minimum importance threshold */
  minImportance?: number

  /** Outcome type filter */
  outcomeType?: PatternOutcomeType

  /** Only positive outcomes (accept, usage, frequent) */
  positiveOnly?: boolean
}

/**
 * Similar pattern result
 */
export interface SimilarPattern {
  /** The matched pattern */
  pattern: StoredPattern

  /** Similarity score [0-1] */
  similarity: number

  /** Importance-weighted similarity */
  weightedSimilarity: number

  /** Rank in results */
  rank: number
}

/**
 * Consolidation operation result
 */
export interface ConsolidationResult {
  /** Whether consolidation was performed */
  consolidated: boolean

  /** Patterns processed during consolidation */
  patternsProcessed: number

  /** Patterns preserved (importance above threshold) */
  patternsPreserved: number

  /** Patterns pruned (importance below threshold) */
  patternsPruned: number

  /** Preservation rate (should be >= 0.95) */
  preservationRate: number

  /** Time taken in milliseconds */
  durationMs: number

  /** New average importance after consolidation */
  averageImportance: number
}

/**
 * PatternStore metrics for monitoring
 */
export interface PatternStoreMetrics {
  /** Total patterns stored */
  totalPatterns: number

  /** Patterns by outcome type */
  patternsByOutcome: Record<PatternOutcomeType, number>

  /** Average pattern importance */
  averageImportance: number

  /** High importance patterns (above 90th percentile) */
  highImportancePatterns: number

  /** Consolidation statistics */
  consolidation: {
    totalConsolidations: number
    lastConsolidation: Date | null
    averagePreservationRate: number
    patternsPruned: number
  }

  /** Storage statistics */
  storage: {
    sizeBytes: number
    fisherMatrixSizeBytes: number
  }

  /** Query performance */
  queryPerformance: {
    averageLatencyMs: number
    queriesPerformed: number
  }
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Internal consolidation state
 */
export interface ConsolidationState {
  lastConsolidation: Date | null
  patternsSinceLastConsolidation: number
  totalPatterns: number
}

/**
 * Database row type for pattern queries
 */
export interface PatternRow {
  pattern_id: string
  context_embedding: Buffer
  skill_id: string
  skill_features: string
  context_data: string
  outcome_type: string
  outcome_reward: number
  importance: number
  original_score: number
  source: string
  access_count: number
  created_at: number
  last_accessed_at: number
}
