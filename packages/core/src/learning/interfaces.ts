/**
 * @fileoverview Service interfaces for Recommendation Learning Loop
 * @module @skillsmith/core/learning/interfaces
 * @see docs/phase4/epic1/recommendation-learning-loop-design.md
 *
 * Defines contracts for:
 * - SignalCollector: Recording user interactions
 * - PreferenceLearner: Learning from signals
 * - PrivacyManager: Data lifecycle management
 * - PersonalizationEngine: Applying learned preferences
 */

import type {
  SignalEvent,
  SignalFilter,
  RecommendationContext,
  SignalMetadata,
  DismissReason,
  UserPreferenceProfile,
  LearningConfig,
  PersonalizedRecommendation,
  UserDataExport,
  AggregateStats,
} from './types.js'

/**
 * Service for collecting user interaction signals
 *
 * Responsibilities:
 * - Record accept/dismiss/usage events
 * - Store signals in local SQLite database
 * - Query signals for learning algorithm
 *
 * @example
 * ```typescript
 * const collector = new SignalCollector(dbPath)
 * await collector.recordAccept('anthropic/commit', {
 *   installed_skills: ['anthropic/review-pr'],
 *   original_score: 0.85
 * })
 * ```
 */
export interface ISignalCollector {
  /**
   * Record user accepting a recommendation
   *
   * @param skillId - Skill that was accepted
   * @param context - Context when skill was recommended
   * @param metadata - Optional metadata (timing, suggestion count)
   * @throws {SkillsmithError} If database write fails
   */
  recordAccept(
    skillId: string,
    context: RecommendationContext,
    metadata?: SignalMetadata
  ): Promise<void>

  /**
   * Record user dismissing a recommendation
   *
   * @param skillId - Skill that was dismissed
   * @param context - Context when skill was recommended
   * @param reason - Optional reason for dismissal
   * @throws {SkillsmithError} If database write fails
   */
  recordDismiss(
    skillId: string,
    context: RecommendationContext,
    reason?: DismissReason
  ): Promise<void>

  /**
   * Record skill usage event
   *
   * Called by usage tracker to record daily/weekly usage
   *
   * @param skillId - Skill that was used
   * @param frequency - Usage frequency (daily or weekly)
   * @throws {SkillsmithError} If database write fails
   */
  recordUsage(skillId: string, frequency: 'daily' | 'weekly'): Promise<void>

  /**
   * Record skill abandonment (installed but never used)
   *
   * @param skillId - Skill that was abandoned
   * @param daysSinceInstall - Days since installation
   * @throws {SkillsmithError} If database write fails
   */
  recordAbandonment(skillId: string, daysSinceInstall: number): Promise<void>

  /**
   * Record skill uninstallation
   *
   * @param skillId - Skill that was uninstalled
   * @param daysSinceInstall - Days since installation
   * @throws {SkillsmithError} If database write fails
   */
  recordUninstall(skillId: string, daysSinceInstall: number): Promise<void>

  /**
   * Query signals with filtering
   *
   * @param filter - Filter criteria
   * @param limit - Maximum results to return
   * @returns Array of matching signal events
   * @throws {SkillsmithError} If database query fails
   */
  getSignals(filter: SignalFilter, limit?: number): Promise<SignalEvent[]>

  /**
   * Get total signal count
   *
   * @returns Total number of signals recorded
   */
  getSignalCount(): Promise<number>

  /**
   * Get signals for specific skill
   *
   * @param skillId - Skill identifier
   * @returns All signals for this skill
   */
  getSignalsForSkill(skillId: string): Promise<SignalEvent[]>
}

/**
 * Service for learning user preferences from signals
 *
 * Responsibilities:
 * - Update preference weights based on signals
 * - Apply time decay to old signals
 * - Maintain weight bounds
 * - Calculate personalized scores
 *
 * @example
 * ```typescript
 * const learner = new PreferenceLearner(config)
 * const updatedProfile = await learner.updateProfile(
 *   currentProfile,
 *   newSignalEvent
 * )
 * ```
 */
export interface IPreferenceLearner {
  /**
   * Update user profile based on new signal
   *
   * Applies learning algorithm to adjust weights:
   * - Category weights
   * - Trust tier weights
   * - Keyword weights
   * - Negative patterns
   *
   * @param profile - Current user profile
   * @param signal - New signal event to learn from
   * @returns Updated profile with adjusted weights
   */
  updateProfile(profile: UserPreferenceProfile, signal: SignalEvent): Promise<UserPreferenceProfile>

  /**
   * Batch update profile from multiple signals
   *
   * More efficient than individual updates for bulk processing
   *
   * @param profile - Current user profile
   * @param signals - Array of signal events
   * @returns Updated profile
   */
  batchUpdateProfile(
    profile: UserPreferenceProfile,
    signals: SignalEvent[]
  ): Promise<UserPreferenceProfile>

  /**
   * Apply time decay to weights
   *
   * Reduces influence of old signals to allow preference evolution
   *
   * @param profile - Current user profile
   * @param decayFactor - Decay multiplier (0.8-1.0)
   * @returns Profile with decayed weights
   */
  decayWeights(profile: UserPreferenceProfile, decayFactor?: number): Promise<UserPreferenceProfile>

  /**
   * Calculate personalized score for a skill
   *
   * @param skillData - Skill metadata (category, keywords, etc.)
   * @param baseScore - Base recommendation score [0-1]
   * @param profile - User preference profile
   * @returns Personalized recommendation with score breakdown
   */
  calculatePersonalizedScore(
    skillData: {
      id: string
      category?: string
      trustTier?: string
      keywords?: string[]
      triggerPhrases?: string[]
    },
    baseScore: number,
    profile: UserPreferenceProfile
  ): PersonalizedRecommendation

  /**
   * Get learning configuration
   */
  getConfig(): LearningConfig

  /**
   * Update learning configuration
   *
   * @param config - Partial config to merge
   */
  setConfig(config: Partial<LearningConfig>): void
}

/**
 * Service for managing data privacy and lifecycle
 *
 * Responsibilities:
 * - Purge old signals (retention policy)
 * - Export user data (GDPR compliance)
 * - Complete data wipe
 * - Anonymize for analytics
 *
 * @example
 * ```typescript
 * const privacy = new PrivacyManager(dbPath)
 * const deleted = await privacy.purgeOldSignals(90) // 90 day retention
 * console.log(`Deleted ${deleted} old signals`)
 * ```
 */
export interface IPrivacyManager {
  /**
   * Purge signals older than retention period
   *
   * @param retentionDays - Keep signals from last N days
   * @returns Number of signals deleted
   * @throws {SkillsmithError} If database operation fails
   */
  purgeOldSignals(retentionDays: number): Promise<number>

  /**
   * Export all user data (GDPR-style)
   *
   * Includes:
   * - User preference profile
   * - All signal events
   * - Aggregate statistics
   *
   * @returns Complete user data export
   * @throws {SkillsmithError} If export fails
   */
  exportUserData(): Promise<UserDataExport>

  /**
   * Complete data wipe (user request)
   *
   * Deletes:
   * - All signals
   * - User profile
   * - Aggregate stats
   *
   * @returns Number of records deleted
   * @throws {SkillsmithError} If wipe fails
   */
  wipeAllData(): Promise<number>

  /**
   * Anonymize signals for aggregate analysis
   *
   * Strips all PII and creates aggregate statistics
   *
   * @returns Anonymized aggregate stats
   */
  anonymizeForAnalytics(): Promise<AggregateStats>

  /**
   * Get current storage size
   *
   * @returns Database size in bytes
   */
  getStorageSize(): Promise<number>

  /**
   * Verify no data leaks (for testing)
   *
   * Checks that no PII is in aggregate tables
   *
   * @returns True if privacy-preserving
   */
  verifyPrivacy(): Promise<boolean>
}

/**
 * Service for applying personalization to recommendations
 *
 * Responsibilities:
 * - Load user profile
 * - Apply personalized scoring
 * - Handle cold start
 * - Re-rank recommendations
 *
 * @example
 * ```typescript
 * const engine = new PersonalizationEngine(learner, profileStore)
 * const personalized = await engine.personalizeRecommendations(
 *   baseRecommendations,
 *   userContext
 * )
 * ```
 */
export interface IPersonalizationEngine {
  /**
   * Personalize recommendation results
   *
   * @param baseRecommendations - Recommendations with base scores
   * @param userId - User identifier (for profile lookup)
   * @returns Re-ranked recommendations with personalized scores
   */
  personalizeRecommendations(
    baseRecommendations: Array<{
      skill_id: string
      base_score: number
      skill_data: {
        category?: string
        trustTier?: string
        keywords?: string[]
      }
    }>,
    userId?: string
  ): Promise<PersonalizedRecommendation[]>

  /**
   * Check if user has enough data for personalization
   *
   * @param userId - User identifier
   * @returns True if personalization should be applied
   */
  shouldPersonalize(userId?: string): Promise<boolean>

  /**
   * Get user preference profile
   *
   * @param userId - User identifier
   * @returns User profile or default cold start profile
   */
  getUserProfile(userId?: string): Promise<UserPreferenceProfile>

  /**
   * Reset to cold start (clear personalization)
   *
   * @param userId - User identifier
   */
  resetToDefault(userId?: string): Promise<void>
}

/**
 * Repository interface for user preference storage
 *
 * Abstraction over SQLite for testability
 */
export interface IUserPreferenceRepository {
  /**
   * Get user preference profile
   *
   * @param userId - User identifier (default: 'default')
   * @returns Profile or null if not exists
   */
  getProfile(userId?: string): Promise<UserPreferenceProfile | null>

  /**
   * Save user preference profile
   *
   * @param profile - Profile to save
   * @param userId - User identifier (default: 'default')
   */
  saveProfile(profile: UserPreferenceProfile, userId?: string): Promise<void>

  /**
   * Delete user profile
   *
   * @param userId - User identifier
   */
  deleteProfile(userId?: string): Promise<void>

  /**
   * Check if profile exists
   *
   * @param userId - User identifier
   */
  exists(userId?: string): Promise<boolean>
}
