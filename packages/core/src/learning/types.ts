/**
 * @fileoverview Type definitions for Recommendation Learning Loop
 * @module @skillsmith/core/learning/types
 * @see docs/phase4/epic1/recommendation-learning-loop-design.md
 *
 * Epic 1 - Sub-issue 5: Build Recommendation Learning Loop
 * Owner: Data Scientist
 *
 * Provides type-safe interfaces for:
 * - Signal collection (accept/dismiss/usage)
 * - User preference profiles
 * - Learning algorithm configuration
 * - Privacy-preserving storage
 */

/**
 * User interaction signal types for recommendation learning
 */
export enum SignalType {
  /** User accepted and installed recommended skill */
  ACCEPT = 'accept',
  /** User explicitly dismissed recommendation */
  DISMISS = 'dismiss',
  /** User actively uses installed skill (daily usage) */
  USAGE_DAILY = 'usage_daily',
  /** User rarely uses installed skill (weekly usage) */
  USAGE_WEEKLY = 'usage_weekly',
  /** Skill installed but never used (30+ days) */
  ABANDONED = 'abandoned',
  /** User uninstalled previously accepted skill */
  UNINSTALL = 'uninstall',
}

/**
 * Signal strength weights for learning algorithm
 * Range: [-1.0, 1.0] where:
 * - Positive = user preference signal
 * - Negative = user rejection signal
 */
export const SIGNAL_WEIGHTS: Readonly<Record<SignalType, number>> = {
  [SignalType.ACCEPT]: 0.5,
  [SignalType.DISMISS]: -0.3,
  [SignalType.USAGE_DAILY]: 1.0,
  [SignalType.USAGE_WEEKLY]: 0.3,
  [SignalType.ABANDONED]: -0.7,
  [SignalType.UNINSTALL]: -1.0,
} as const

/**
 * Reason for dismissing a recommendation
 */
export enum DismissReason {
  /** Not relevant to current work */
  NOT_RELEVANT = 'not_relevant',
  /** Already have similar functionality */
  DUPLICATE = 'duplicate',
  /** Don't trust the source */
  TRUST_ISSUE = 'trust_issue',
  /** Too complex/heavyweight */
  TOO_COMPLEX = 'too_complex',
  /** No specific reason */
  OTHER = 'other',
}

/**
 * Skill category enum (aligned with skill schema)
 */
export enum SkillCategory {
  GIT = 'git',
  TESTING = 'testing',
  DOCUMENTATION = 'documentation',
  DEVOPS = 'devops',
  FRONTEND = 'frontend',
  BACKEND = 'backend',
  DATABASE = 'database',
  SECURITY = 'security',
  PRODUCTIVITY = 'productivity',
  ANALYSIS = 'analysis',
}

/**
 * Context when skill was recommended
 */
export interface RecommendationContext {
  /** Skills installed at recommendation time */
  installed_skills: string[]
  /** Project context used for recommendation */
  project_context?: string
  /** Similarity score at recommendation time */
  original_score: number
  /** Trust tier of recommended skill */
  trust_tier?: string
  /** Category of recommended skill */
  category?: string
}

/**
 * Optional metadata for signal events
 */
export interface SignalMetadata {
  /** Time between recommendation and action (ms) */
  time_to_action?: number
  /** Number of times skill was suggested before action */
  suggestion_count?: number
  /** Additional context-specific data */
  extra?: Record<string, unknown>
}

/**
 * Individual signal event stored in database
 */
export interface SignalEvent {
  /** Unique event ID (UUID) */
  id: string
  /** Signal type */
  type: SignalType
  /** Skill that was recommended/interacted with */
  skill_id: string
  /** Unix timestamp (ms) of event */
  timestamp: number
  /** Recommendation context when skill was suggested */
  context: RecommendationContext
  /** Optional metadata */
  metadata?: SignalMetadata
  /** Dismiss reason (only for DISMISS signals) */
  dismiss_reason?: DismissReason
}

/**
 * Filter for querying signal events
 */
export interface SignalFilter {
  /** Filter by skill ID */
  skill_id?: string
  /** Filter by signal type */
  type?: SignalType | SignalType[]
  /** Filter by time range */
  time_range?: {
    start: number
    end: number
  }
  /** Filter by category */
  category?: SkillCategory
}

/**
 * User-specific preference profile (local storage only)
 * PRIVACY: This data never leaves the local machine
 */
export interface UserPreferenceProfile {
  /** Profile schema version for migrations */
  version: number
  /** Last updated timestamp (ms) */
  last_updated: number
  /** Total signals collected */
  signal_count: number

  /** Category preferences learned from signals
   * Range: [-2.0, 2.0] where:
   * - Positive = user prefers this category
   * - Negative = user avoids this category
   */
  category_weights: Partial<Record<SkillCategory, number>>

  /** Trust tier preferences
   * Range: [-2.0, 2.0]
   */
  trust_tier_weights: Record<string, number>

  /** Keyword/tag preferences
   * Range: [-2.0, 2.0]
   */
  keyword_weights: Record<string, number>

  /** Anti-preferences (things user consistently dismisses) */
  negative_patterns: {
    /** Keywords user doesn't like */
    keywords: string[]
    /** Categories user avoids */
    categories: SkillCategory[]
    /** Specific skills user explicitly doesn't want */
    skill_ids: string[]
  }

  /** Usage pattern insights */
  usage_patterns: {
    /** Average time from install to first use (ms) */
    avg_time_to_first_use_ms: number
    /** Percentage of accepted skills actually used (0-1) */
    utilization_rate: number
    /** Most used skill categories (ordered by frequency) */
    top_categories: SkillCategory[]
  }
}

/**
 * Learning hyperparameters (tunable)
 */
export interface LearningConfig {
  /** Base learning rate for weight updates (default: 0.1)
   * Range: [0.01, 0.5]
   */
  learning_rate: number

  /** Time decay factor for old signals (default: 0.95/month)
   * Range: [0.8, 1.0] where 1.0 = no decay
   */
  decay_factor: number

  /** Minimum signals before personalization kicks in */
  min_signals_threshold: number

  /** Weight clipping bounds to prevent extreme values */
  weight_bounds: {
    min: number
    max: number
  }

  /** Data retention period (days) */
  signal_retention_days: number
}

/**
 * Default learning configuration
 */
export const DEFAULT_LEARNING_CONFIG: Readonly<LearningConfig> = {
  learning_rate: 0.1,
  decay_factor: 0.95,
  min_signals_threshold: 5,
  weight_bounds: {
    min: -2.0,
    max: 2.0,
  },
  signal_retention_days: 90,
} as const

/**
 * Cold start default weights (before personalization)
 * Based on aggregate popularity data
 */
export const COLD_START_WEIGHTS: Readonly<{
  category_weights: Partial<Record<SkillCategory, number>>
  trust_tier_weights: Record<string, number>
}> = {
  category_weights: {
    [SkillCategory.TESTING]: 0.3,
    [SkillCategory.GIT]: 0.3,
    [SkillCategory.DEVOPS]: 0.2,
    [SkillCategory.DOCUMENTATION]: 0.1,
    [SkillCategory.FRONTEND]: 0.2,
    [SkillCategory.BACKEND]: 0.2,
  },
  trust_tier_weights: {
    verified: 0.2,
    community: 0.0,
    standard: -0.1,
    unverified: -0.3,
  },
} as const

/**
 * Personalized recommendation result
 */
export interface PersonalizedRecommendation {
  /** Skill identifier */
  skill_id: string
  /** Base similarity score [0-1] */
  base_score: number
  /** Personalized score after learning adjustments [0-1] */
  personalized_score: number
  /** Whether personalization was applied */
  personalization_applied: boolean
  /** Breakdown of score adjustments */
  score_breakdown: {
    category_boost: number
    trust_boost: number
    keyword_boost: number
    anti_penalty: number
  }
}

/**
 * Aggregate statistics (anonymized, no PII)
 */
export interface AggregateStats {
  /** Date (YYYY-MM-DD) */
  date: string
  /** Total signals recorded */
  total_signals: number
  /** Breakdown by signal type */
  signal_counts: Partial<Record<SignalType, number>>
  /** Average accept rate */
  avg_accept_rate: number
  /** Average utilization rate */
  avg_utilization_rate: number
  /** Popular categories */
  popular_categories: Array<{
    category: SkillCategory
    count: number
  }>
}

/**
 * User data export (GDPR-style)
 */
export interface UserDataExport {
  /** Export timestamp */
  exported_at: number
  /** Profile version */
  version: number
  /** User preference profile */
  profile: UserPreferenceProfile
  /** All signal events */
  signals: SignalEvent[]
  /** Aggregate stats */
  stats: AggregateStats[]
}

/**
 * Events emitted by learning system
 */
export interface LearningEvents {
  /** Signal recorded successfully */
  'signal:recorded': {
    signal_id: string
    type: SignalType
    skill_id: string
  }

  /** Profile updated */
  'profile:updated': {
    signal_count: number
    personalization_active: boolean
  }

  /** Data purged (privacy cleanup) */
  'data:purged': {
    signals_deleted: number
    retention_days: number
  }
}
