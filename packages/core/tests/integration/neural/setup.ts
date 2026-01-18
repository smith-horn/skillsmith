/**
 * SMI-1535: Neural Test Infrastructure - Setup
 *
 * Provides test context factory and mock implementations for
 * the Recommendation Learning Loop integration tests.
 *
 * @see packages/core/src/learning/interfaces.ts
 * @see packages/core/src/learning/types.ts
 */

import { randomUUID } from 'node:crypto'
import type {
  ISignalCollector,
  IPreferenceLearner,
  IPersonalizationEngine,
  IPrivacyManager,
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
  type UserDataExport,
  type AggregateStats,
  SignalType,
  SkillCategory,
  DEFAULT_LEARNING_CONFIG,
  SIGNAL_WEIGHTS,
  COLD_START_WEIGHTS,
} from '../../../src/learning/types.js'

/**
 * Neural test context containing all mock service instances
 */
export interface NeuralTestContext {
  signalCollector: MockSignalCollector
  preferenceLearner: MockPreferenceLearner
  personalizationEngine: MockPersonalizationEngine
  privacyManager: MockPrivacyManager
  profileRepository: MockUserPreferenceRepository
}

/**
 * Create a fresh neural test context with all mock services
 */
export function createNeuralTestContext(): NeuralTestContext {
  const profileRepository = new MockUserPreferenceRepository()
  const signalCollector = new MockSignalCollector()
  const preferenceLearner = new MockPreferenceLearner()
  const personalizationEngine = new MockPersonalizationEngine(
    preferenceLearner,
    profileRepository,
    signalCollector
  )
  const privacyManager = new MockPrivacyManager(signalCollector, profileRepository)

  return {
    signalCollector,
    preferenceLearner,
    personalizationEngine,
    privacyManager,
    profileRepository,
  }
}

/**
 * Clean up a neural test context (release resources)
 */
export async function cleanupNeuralTestContext(ctx: NeuralTestContext): Promise<void> {
  // Clear all stored data
  ctx.signalCollector.clear()
  ctx.profileRepository.clear()
}

/**
 * Create a default empty user preference profile
 */
export function createDefaultProfile(): UserPreferenceProfile {
  return {
    version: 1,
    last_updated: Date.now(),
    signal_count: 0,
    category_weights: { ...COLD_START_WEIGHTS.category_weights },
    trust_tier_weights: { ...COLD_START_WEIGHTS.trust_tier_weights },
    keyword_weights: {},
    negative_patterns: {
      keywords: [],
      categories: [],
      skill_ids: [],
    },
    usage_patterns: {
      avg_time_to_first_use_ms: 0,
      utilization_rate: 0,
      top_categories: [],
    },
  }
}

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
    private profileRepo: MockUserPreferenceRepository,
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

/**
 * Mock implementation of IPrivacyManager for testing
 */
export class MockPrivacyManager implements IPrivacyManager {
  private auditLog: Array<{ operation: string; timestamp: number; details?: string }> = []

  constructor(
    private signalCollector: MockSignalCollector,
    private profileRepo: MockUserPreferenceRepository
  ) {}

  async purgeOldSignals(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const deleted = this.signalCollector.removeOldSignals(cutoff)
    this.auditLog.push({
      operation: 'purgeOldSignals',
      timestamp: Date.now(),
      details: `Deleted ${deleted} signals older than ${retentionDays} days`,
    })
    return deleted
  }

  async exportUserData(): Promise<UserDataExport> {
    const profile = (await this.profileRepo.getProfile()) ?? createDefaultProfile()
    const signals = this.signalCollector.getAllSignals()

    this.auditLog.push({
      operation: 'exportUserData',
      timestamp: Date.now(),
    })

    return {
      exported_at: Date.now(),
      version: profile.version,
      profile,
      signals,
      stats: [], // Simplified for testing
    }
  }

  async wipeAllData(): Promise<number> {
    const signalCount = await this.signalCollector.getSignalCount()
    this.signalCollector.clear()
    await this.profileRepo.deleteProfile()

    this.auditLog.push({
      operation: 'wipeAllData',
      timestamp: Date.now(),
      details: `Wiped ${signalCount} signals and profile`,
    })

    return signalCount + 1 // signals + profile
  }

  async anonymizeForAnalytics(): Promise<AggregateStats> {
    const signals = this.signalCollector.getAllSignals()
    const signalCounts: Partial<Record<SignalType, number>> = {}
    const categoryCounts = new Map<SkillCategory, number>()

    for (const signal of signals) {
      signalCounts[signal.type] = (signalCounts[signal.type] ?? 0) + 1
      const cat = signal.context.category as SkillCategory | undefined
      if (cat) {
        categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
      }
    }

    const acceptCount = signalCounts[SignalType.ACCEPT] ?? 0
    const dismissCount = signalCounts[SignalType.DISMISS] ?? 0
    const acceptRate =
      acceptCount + dismissCount > 0 ? acceptCount / (acceptCount + dismissCount) : 0

    return {
      date: new Date().toISOString().split('T')[0],
      total_signals: signals.length,
      signal_counts: signalCounts,
      avg_accept_rate: acceptRate,
      avg_utilization_rate: 0, // Simplified
      popular_categories: Array.from(categoryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([category, count]) => ({ category, count })),
    }
  }

  async getStorageSize(): Promise<number> {
    const signals = this.signalCollector.getAllSignals()
    return JSON.stringify(signals).length // Approximate size in bytes
  }

  async verifyPrivacy(): Promise<boolean> {
    // For mock, always return true (no PII leakage in test context)
    return true
  }

  // Test helper to get audit log
  getAuditLog(): Array<{ operation: string; timestamp: number; details?: string }> {
    return [...this.auditLog]
  }
}

/**
 * Mock implementation of IUserPreferenceRepository for testing
 */
export class MockUserPreferenceRepository implements IUserPreferenceRepository {
  private profiles = new Map<string, UserPreferenceProfile>()
  private readonly defaultUserId = 'default'

  async getProfile(userId?: string): Promise<UserPreferenceProfile | null> {
    return this.profiles.get(userId ?? this.defaultUserId) ?? null
  }

  async saveProfile(profile: UserPreferenceProfile, userId?: string): Promise<void> {
    this.profiles.set(userId ?? this.defaultUserId, { ...profile })
  }

  async deleteProfile(userId?: string): Promise<void> {
    this.profiles.delete(userId ?? this.defaultUserId)
  }

  async exists(userId?: string): Promise<boolean> {
    return this.profiles.has(userId ?? this.defaultUserId)
  }

  // Test helper
  clear(): void {
    this.profiles.clear()
  }
}
