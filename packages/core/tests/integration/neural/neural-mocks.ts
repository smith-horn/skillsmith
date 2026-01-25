/**
 * SMI-1535: Neural Test Infrastructure - Mock Implementations
 *
 * Mock implementations of learning interfaces for testing.
 *
 * @see packages/core/src/learning/interfaces.ts
 * @see packages/core/src/learning/types.ts
 */

import { randomUUID } from 'node:crypto'
import type {
  ISignalCollector,
  IPreferenceLearner,
  IPersonalizationEngine,
  IUserPreferenceRepository,
} from '../../../src/learning/interfaces.js'
import {
  type SignalEvent,
  type SignalFilter,
  type RecommendationContext,
  type SignalMetadata,
  type DismissReason,
  type UserPreferenceProfile,
  type LearningConfig,
  type PersonalizedRecommendation,
  SignalType,
  SkillCategory,
  DEFAULT_LEARNING_CONFIG,
  SIGNAL_WEIGHTS,
} from '../../../src/learning/types.js'
import { createDefaultProfile } from './neural-fixtures.js'

// Re-export privacy mocks
export { MockPrivacyManager, MockUserPreferenceRepository } from './neural-mocks-privacy.js'

/**
 * Mock implementation of ISignalCollector for testing
 */
export class MockSignalCollector implements ISignalCollector {
  private signals: SignalEvent[] = []

  async recordAccept(
    skillId: string,
    context: RecommendationContext,
    metadata?: SignalMetadata
  ): Promise<void> {
    this.signals.push({
      id: randomUUID(),
      type: SignalType.ACCEPT,
      skill_id: skillId,
      timestamp: Date.now(),
      context,
      metadata,
    })
  }

  async recordDismiss(
    skillId: string,
    context: RecommendationContext,
    reason?: DismissReason
  ): Promise<void> {
    this.signals.push({
      id: randomUUID(),
      type: SignalType.DISMISS,
      skill_id: skillId,
      timestamp: Date.now(),
      context,
      dismiss_reason: reason,
    })
  }

  async recordUsage(skillId: string, frequency: 'daily' | 'weekly'): Promise<void> {
    const type = frequency === 'daily' ? SignalType.USAGE_DAILY : SignalType.USAGE_WEEKLY
    this.signals.push({
      id: randomUUID(),
      type,
      skill_id: skillId,
      timestamp: Date.now(),
      context: { installed_skills: [], original_score: 0 },
    })
  }

  async recordAbandonment(skillId: string, daysSinceInstall: number): Promise<void> {
    this.signals.push({
      id: randomUUID(),
      type: SignalType.ABANDONED,
      skill_id: skillId,
      timestamp: Date.now(),
      context: { installed_skills: [], original_score: 0 },
      metadata: { extra: { days_since_install: daysSinceInstall } },
    })
  }

  async recordUninstall(skillId: string, daysSinceInstall: number): Promise<void> {
    this.signals.push({
      id: randomUUID(),
      type: SignalType.UNINSTALL,
      skill_id: skillId,
      timestamp: Date.now(),
      context: { installed_skills: [], original_score: 0 },
      metadata: { extra: { days_since_install: daysSinceInstall } },
    })
  }

  async getSignals(filter: SignalFilter, limit?: number): Promise<SignalEvent[]> {
    let result = [...this.signals]

    if (filter.skill_id) {
      result = result.filter((s) => s.skill_id === filter.skill_id)
    }

    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type]
      result = result.filter((s) => types.includes(s.type))
    }

    if (filter.time_range) {
      result = result.filter(
        (s) => s.timestamp >= filter.time_range!.start && s.timestamp <= filter.time_range!.end
      )
    }

    if (filter.category) {
      result = result.filter((s) => s.context.category === filter.category)
    }

    if (limit) {
      result = result.slice(0, limit)
    }

    return result
  }

  async getSignalCount(): Promise<number> {
    return this.signals.length
  }

  async getSignalsForSkill(skillId: string): Promise<SignalEvent[]> {
    return this.signals.filter((s) => s.skill_id === skillId)
  }

  // Test helpers
  clear(): void {
    this.signals = []
  }

  getAllSignals(): SignalEvent[] {
    return [...this.signals]
  }

  addSignal(signal: SignalEvent): void {
    this.signals.push(signal)
  }

  removeOldSignals(cutoffTimestamp: number): number {
    const before = this.signals.length
    this.signals = this.signals.filter((s) => s.timestamp >= cutoffTimestamp)
    return before - this.signals.length
  }
}

/**
 * Mock implementation of IPreferenceLearner for testing
 */
export class MockPreferenceLearner implements IPreferenceLearner {
  private config: LearningConfig = { ...DEFAULT_LEARNING_CONFIG }

  async updateProfile(
    profile: UserPreferenceProfile,
    signal: SignalEvent
  ): Promise<UserPreferenceProfile> {
    const weight = SIGNAL_WEIGHTS[signal.type]
    const category = signal.context.category as SkillCategory | undefined
    const trustTier = signal.context.trust_tier

    const updated = { ...profile }
    updated.last_updated = Date.now()
    updated.signal_count++

    // Update category weight
    if (category) {
      const currentWeight = updated.category_weights[category] ?? 0
      const newWeight = this.clampWeight(currentWeight + weight * this.config.learning_rate)
      updated.category_weights = { ...updated.category_weights, [category]: newWeight }
    }

    // Update trust tier weight
    if (trustTier) {
      const currentWeight = updated.trust_tier_weights[trustTier] ?? 0
      const newWeight = this.clampWeight(currentWeight + weight * this.config.learning_rate)
      updated.trust_tier_weights = { ...updated.trust_tier_weights, [trustTier]: newWeight }
    }

    // Track negative patterns for dismiss/uninstall
    if (signal.type === SignalType.DISMISS || signal.type === SignalType.UNINSTALL) {
      if (!updated.negative_patterns.skill_ids.includes(signal.skill_id)) {
        updated.negative_patterns = {
          ...updated.negative_patterns,
          skill_ids: [...updated.negative_patterns.skill_ids, signal.skill_id],
        }
      }
    }

    return updated
  }

  async batchUpdateProfile(
    profile: UserPreferenceProfile,
    signals: SignalEvent[]
  ): Promise<UserPreferenceProfile> {
    let updated = profile
    for (const signal of signals) {
      updated = await this.updateProfile(updated, signal)
    }
    return updated
  }

  async decayWeights(
    profile: UserPreferenceProfile,
    decayFactor?: number
  ): Promise<UserPreferenceProfile> {
    const factor = decayFactor ?? this.config.decay_factor
    const updated = { ...profile }

    // Decay category weights
    const newCategoryWeights: Partial<Record<SkillCategory, number>> = {}
    for (const [cat, weight] of Object.entries(updated.category_weights)) {
      newCategoryWeights[cat as SkillCategory] = weight * factor
    }
    updated.category_weights = newCategoryWeights

    // Decay trust tier weights
    const newTrustWeights: Record<string, number> = {}
    for (const [tier, weight] of Object.entries(updated.trust_tier_weights)) {
      newTrustWeights[tier] = weight * factor
    }
    updated.trust_tier_weights = newTrustWeights

    // Decay keyword weights
    const newKeywordWeights: Record<string, number> = {}
    for (const [keyword, weight] of Object.entries(updated.keyword_weights)) {
      newKeywordWeights[keyword] = weight * factor
    }
    updated.keyword_weights = newKeywordWeights

    updated.last_updated = Date.now()
    return updated
  }

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
  ): PersonalizedRecommendation {
    let categoryBoost = 0
    let trustBoost = 0
    let keywordBoost = 0
    let antiPenalty = 0

    // Category boost
    if (skillData.category) {
      categoryBoost = profile.category_weights[skillData.category as SkillCategory] ?? 0
    }

    // Trust tier boost
    if (skillData.trustTier) {
      trustBoost = profile.trust_tier_weights[skillData.trustTier] ?? 0
    }

    // Keyword boost
    if (skillData.keywords) {
      for (const kw of skillData.keywords) {
        keywordBoost += profile.keyword_weights[kw] ?? 0
      }
    }

    // Anti-penalty for skills in negative patterns
    if (profile.negative_patterns.skill_ids.includes(skillData.id)) {
      antiPenalty = -0.5 // Strong penalty
    }

    // Calculate personalized score, clamped to [0, 1]
    const totalAdjustment = (categoryBoost + trustBoost + keywordBoost + antiPenalty) * 0.1
    const personalizedScore = Math.max(0, Math.min(1, baseScore + totalAdjustment))

    return {
      skill_id: skillData.id,
      base_score: baseScore,
      personalized_score: personalizedScore,
      personalization_applied: profile.signal_count >= this.config.min_signals_threshold,
      score_breakdown: {
        category_boost: categoryBoost,
        trust_boost: trustBoost,
        keyword_boost: keywordBoost,
        anti_penalty: antiPenalty,
      },
    }
  }

  getConfig(): LearningConfig {
    return { ...this.config }
  }

  setConfig(config: Partial<LearningConfig>): void {
    this.config = { ...this.config, ...config }
  }

  private clampWeight(weight: number): number {
    return Math.max(this.config.weight_bounds.min, Math.min(this.config.weight_bounds.max, weight))
  }
}

/**
 * Mock implementation of IPersonalizationEngine for testing
 */
export class MockPersonalizationEngine implements IPersonalizationEngine {
  constructor(
    private learner: MockPreferenceLearner,
    private profileRepo: IUserPreferenceRepository,
    private signalCollector: MockSignalCollector
  ) {}

  async personalizeRecommendations(
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
  ): Promise<PersonalizedRecommendation[]> {
    const profile = await this.getUserProfile(userId)
    const shouldApply = await this.shouldPersonalize(userId)

    const results = baseRecommendations.map((rec) => {
      const result = this.learner.calculatePersonalizedScore(
        { id: rec.skill_id, ...rec.skill_data },
        rec.base_score,
        profile
      )
      // Only apply personalization if threshold met
      if (!shouldApply) {
        return {
          ...result,
          personalized_score: rec.base_score,
          personalization_applied: false,
        }
      }
      return result
    })

    // Sort by personalized score descending
    return results.sort((a, b) => b.personalized_score - a.personalized_score)
  }

  /**
   * Determine if personalization should be applied.
   *
   * IMPORTANT: Mock Implementation Limitation
   * -----------------------------------------
   * This mock checks the GLOBAL signal count across all users, not the
   * per-user signal count. This is a simplification for testing purposes.
   *
   * In a real implementation, shouldPersonalize should:
   * 1. Look up the user's profile by userId
   * 2. Check that user's individual signal_count against the threshold
   * 3. Return true only if that specific user has enough signals
   *
   * The mock behavior works for single-user test scenarios but does not
   * accurately model multi-user environments where each user has their
   * own signal history and personalization threshold.
   *
   * @param _userId - User ID (ignored in mock - uses global count)
   * @returns Promise<boolean> - True if global signal count meets threshold
   */
  async shouldPersonalize(_userId?: string): Promise<boolean> {
    const count = await this.signalCollector.getSignalCount()
    return count >= this.learner.getConfig().min_signals_threshold
  }

  async getUserProfile(userId?: string): Promise<UserPreferenceProfile> {
    const profile = await this.profileRepo.getProfile(userId)
    return profile ?? createDefaultProfile()
  }

  async resetToDefault(userId?: string): Promise<void> {
    await this.profileRepo.deleteProfile(userId)
  }
}
