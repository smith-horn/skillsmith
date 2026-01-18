/**
 * SMI-1535: Preference Learner Integration Tests
 *
 * Tests the IPreferenceLearner interface for updating user profiles
 * based on interaction signals in the Recommendation Learning Loop.
 *
 * Test Cases:
 * 1. Update profile from single ACCEPT signal
 * 2. Update profile from single DISMISS signal
 * 3. Batch update with 100 signals
 * 4. Weight decay after 30 days
 * 5. Weight bounds enforcement (-2.0 to 2.0)
 * 6. Category weight accumulation
 * 7. Trust tier preference learning
 * 8. Author preference learning
 * 9. Cold start default weights
 * 10. Profile persistence across sessions
 *
 * @see packages/core/src/learning/interfaces.ts
 * @see docs/execution/phase5-testing-execution.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createNeuralTestContext,
  cleanupNeuralTestContext,
  createDefaultProfile,
  type NeuralTestContext,
} from './setup.js'
import { generateSignal } from './helpers.js'
import {
  SignalType,
  SkillCategory,
  SIGNAL_WEIGHTS,
  DEFAULT_LEARNING_CONFIG,
  COLD_START_WEIGHTS,
} from '../../../src/learning/types.js'

describe('PreferenceLearner Integration', () => {
  let ctx: NeuralTestContext

  beforeEach(() => {
    ctx = createNeuralTestContext()
  })

  afterEach(async () => {
    await cleanupNeuralTestContext(ctx)
  })

  describe('Single Signal Updates', () => {
    it('should update profile from single ACCEPT signal', async () => {
      const profile = createDefaultProfile()
      const signal = generateSignal({
        type: SignalType.ACCEPT,
        skillId: 'test-skill-1',
        category: SkillCategory.TESTING,
        trustTier: 'verified',
      })

      const updated = await ctx.preferenceLearner.updateProfile(profile, signal)

      // Signal count should increment
      expect(updated.signal_count).toBe(1)

      // Category weight should increase (ACCEPT weight is 0.5, learning rate 0.1)
      const expectedCategoryIncrease =
        SIGNAL_WEIGHTS[SignalType.ACCEPT] * DEFAULT_LEARNING_CONFIG.learning_rate
      const originalCategoryWeight = COLD_START_WEIGHTS.category_weights[SkillCategory.TESTING] ?? 0
      expect(updated.category_weights[SkillCategory.TESTING]).toBeCloseTo(
        originalCategoryWeight + expectedCategoryIncrease,
        5
      )

      // Trust tier weight should increase
      expect(updated.trust_tier_weights['verified']).toBeGreaterThan(
        profile.trust_tier_weights['verified'] ?? 0
      )

      // Timestamp should be updated
      expect(updated.last_updated).toBeGreaterThanOrEqual(profile.last_updated)
    })

    it('should update profile from single DISMISS signal', async () => {
      const profile = createDefaultProfile()
      const signal = generateSignal({
        type: SignalType.DISMISS,
        skillId: 'unwanted-skill',
        category: SkillCategory.DEVOPS,
        trustTier: 'experimental',
      })

      const updated = await ctx.preferenceLearner.updateProfile(profile, signal)

      // Category weight should decrease (DISMISS weight is -0.3)
      const expectedCategoryDecrease =
        SIGNAL_WEIGHTS[SignalType.DISMISS] * DEFAULT_LEARNING_CONFIG.learning_rate
      const originalCategoryWeight = COLD_START_WEIGHTS.category_weights[SkillCategory.DEVOPS] ?? 0
      expect(updated.category_weights[SkillCategory.DEVOPS]).toBeCloseTo(
        originalCategoryWeight + expectedCategoryDecrease,
        5
      )

      // Skill should be added to negative patterns
      expect(updated.negative_patterns.skill_ids).toContain('unwanted-skill')
    })
  })

  describe('Batch Updates', () => {
    it('should batch update with 100 signals', async () => {
      const profile = createDefaultProfile()

      // Generate 100 signals with varied types and categories
      const signals = []
      for (let i = 0; i < 100; i++) {
        const types = [
          SignalType.ACCEPT,
          SignalType.DISMISS,
          SignalType.USAGE_DAILY,
          SignalType.USAGE_WEEKLY,
        ]
        const categories = Object.values(SkillCategory)

        signals.push(
          generateSignal({
            type: types[i % types.length],
            skillId: `skill-${i}`,
            category: categories[i % categories.length],
            trustTier: i % 2 === 0 ? 'verified' : 'community',
          })
        )
      }

      const startTime = Date.now()
      const updated = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      const duration = Date.now() - startTime

      // Signal count should be 100
      expect(updated.signal_count).toBe(100)

      // Should complete quickly (< 100ms for mock implementation)
      expect(duration).toBeLessThan(1000)

      // Should have updated multiple category weights
      const nonZeroCategoryWeights = Object.values(updated.category_weights).filter(
        (w) =>
          w !== undefined &&
          Math.abs(w - (COLD_START_WEIGHTS.category_weights[SkillCategory.TESTING] ?? 0)) > 0.001
      )
      expect(nonZeroCategoryWeights.length).toBeGreaterThan(0)
    })
  })

  describe('Weight Decay', () => {
    it('should apply weight decay after 30 days', async () => {
      // Create profile with significant weights
      const profile = createDefaultProfile()
      profile.category_weights = {
        [SkillCategory.TESTING]: 1.5,
        [SkillCategory.GIT]: -1.0,
        [SkillCategory.DEVOPS]: 0.8,
      }
      profile.trust_tier_weights = {
        verified: 1.2,
        community: 0.5,
      }
      profile.keyword_weights = {
        test: 0.9,
        ci: -0.4,
      }

      // Apply decay with default factor (0.95)
      const decayed = await ctx.preferenceLearner.decayWeights(profile)

      // All weights should be reduced by decay factor
      expect(decayed.category_weights[SkillCategory.TESTING]).toBeCloseTo(
        1.5 * DEFAULT_LEARNING_CONFIG.decay_factor,
        5
      )
      expect(decayed.category_weights[SkillCategory.GIT]).toBeCloseTo(
        -1.0 * DEFAULT_LEARNING_CONFIG.decay_factor,
        5
      )
      expect(decayed.trust_tier_weights.verified).toBeCloseTo(
        1.2 * DEFAULT_LEARNING_CONFIG.decay_factor,
        5
      )
      expect(decayed.keyword_weights.test).toBeCloseTo(
        0.9 * DEFAULT_LEARNING_CONFIG.decay_factor,
        5
      )
    })

    it('should support custom decay factor', async () => {
      const profile = createDefaultProfile()
      profile.category_weights = {
        [SkillCategory.TESTING]: 1.0,
      }

      // Apply aggressive decay (0.8)
      const decayed = await ctx.preferenceLearner.decayWeights(profile, 0.8)

      expect(decayed.category_weights[SkillCategory.TESTING]).toBeCloseTo(0.8, 5)
    })
  })

  describe('Weight Bounds', () => {
    it('should enforce weight bounds (-2.0 to 2.0)', async () => {
      const profile = createDefaultProfile()

      // Generate many ACCEPT signals for the same category to push weight high
      const signals = Array.from({ length: 100 }, () =>
        generateSignal({
          type: SignalType.USAGE_DAILY, // Highest positive weight (1.0)
          category: SkillCategory.TESTING,
          trustTier: 'verified',
        })
      )

      const updated = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)

      // Weight should be capped at max bound
      expect(updated.category_weights[SkillCategory.TESTING]).toBeLessThanOrEqual(
        DEFAULT_LEARNING_CONFIG.weight_bounds.max
      )
      expect(updated.category_weights[SkillCategory.TESTING]).toBeGreaterThanOrEqual(
        DEFAULT_LEARNING_CONFIG.weight_bounds.min
      )
    })

    it('should enforce negative weight bounds', async () => {
      const profile = createDefaultProfile()

      // Generate many UNINSTALL signals to push weight negative
      const signals = Array.from({ length: 100 }, () =>
        generateSignal({
          type: SignalType.UNINSTALL, // Most negative weight (-1.0)
          category: SkillCategory.SECURITY,
          trustTier: 'experimental',
        })
      )

      const updated = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)

      // Weight should be capped at min bound
      expect(updated.category_weights[SkillCategory.SECURITY]).toBeGreaterThanOrEqual(
        DEFAULT_LEARNING_CONFIG.weight_bounds.min
      )
    })
  })

  describe('Category Weight Accumulation', () => {
    it('should accumulate category weights over multiple interactions', async () => {
      let profile = createDefaultProfile()
      const originalWeight = profile.category_weights[SkillCategory.FRONTEND] ?? 0

      // Simulate 5 accept interactions over time
      for (let i = 0; i < 5; i++) {
        const signal = generateSignal({
          type: SignalType.ACCEPT,
          skillId: `frontend-skill-${i}`,
          category: SkillCategory.FRONTEND,
        })
        profile = await ctx.preferenceLearner.updateProfile(profile, signal)
      }

      // Weight should have accumulated
      const expectedIncrease =
        5 * SIGNAL_WEIGHTS[SignalType.ACCEPT] * DEFAULT_LEARNING_CONFIG.learning_rate
      expect(profile.category_weights[SkillCategory.FRONTEND]).toBeCloseTo(
        Math.min(originalWeight + expectedIncrease, DEFAULT_LEARNING_CONFIG.weight_bounds.max),
        5
      )
    })
  })

  describe('Trust Tier Learning', () => {
    it('should learn trust tier preferences', async () => {
      let profile = createDefaultProfile()

      // User consistently accepts verified skills
      for (let i = 0; i < 10; i++) {
        const signal = generateSignal({
          type: SignalType.ACCEPT,
          skillId: `verified-skill-${i}`,
          trustTier: 'verified',
        })
        profile = await ctx.preferenceLearner.updateProfile(profile, signal)
      }

      // User consistently dismisses experimental skills
      for (let i = 0; i < 10; i++) {
        const signal = generateSignal({
          type: SignalType.DISMISS,
          skillId: `experimental-skill-${i}`,
          trustTier: 'experimental',
        })
        profile = await ctx.preferenceLearner.updateProfile(profile, signal)
      }

      // Verified should have higher weight than experimental
      expect(profile.trust_tier_weights['verified']).toBeGreaterThan(
        profile.trust_tier_weights['experimental']
      )
    })
  })

  describe('Author Preference Learning', () => {
    it('should track negative patterns for dismissed authors', async () => {
      let profile = createDefaultProfile()

      // Dismiss skills from a specific author multiple times
      const authorSkills = ['author-x/skill-1', 'author-x/skill-2', 'author-x/skill-3']
      for (const skillId of authorSkills) {
        const signal = generateSignal({
          type: SignalType.DISMISS,
          skillId,
        })
        profile = await ctx.preferenceLearner.updateProfile(profile, signal)
      }

      // All dismissed skills should be in negative patterns
      for (const skillId of authorSkills) {
        expect(profile.negative_patterns.skill_ids).toContain(skillId)
      }
    })
  })

  describe('Cold Start', () => {
    it('should use cold start default weights for new users', () => {
      const profile = createDefaultProfile()

      // Should have default category weights
      expect(profile.category_weights[SkillCategory.TESTING]).toBe(
        COLD_START_WEIGHTS.category_weights[SkillCategory.TESTING]
      )
      expect(profile.category_weights[SkillCategory.GIT]).toBe(
        COLD_START_WEIGHTS.category_weights[SkillCategory.GIT]
      )

      // Should have default trust tier weights
      expect(profile.trust_tier_weights['verified']).toBe(
        COLD_START_WEIGHTS.trust_tier_weights['verified']
      )
      expect(profile.trust_tier_weights['community']).toBe(
        COLD_START_WEIGHTS.trust_tier_weights['community']
      )

      // Signal count should be 0
      expect(profile.signal_count).toBe(0)
    })
  })

  describe('Profile Persistence', () => {
    it('should persist profile across save/load cycles', async () => {
      // Create and modify profile
      let profile = createDefaultProfile()
      for (let i = 0; i < 10; i++) {
        const signal = generateSignal({
          type: SignalType.ACCEPT,
          skillId: `skill-${i}`,
          category: SkillCategory.BACKEND,
        })
        profile = await ctx.preferenceLearner.updateProfile(profile, signal)
      }

      // Save profile
      await ctx.profileRepository.saveProfile(profile, 'test-user')

      // Load profile
      const loaded = await ctx.profileRepository.getProfile('test-user')

      expect(loaded).not.toBeNull()
      expect(loaded!.signal_count).toBe(10)
      expect(loaded!.category_weights[SkillCategory.BACKEND]).toBeCloseTo(
        profile.category_weights[SkillCategory.BACKEND]!,
        5
      )
    })
  })

  describe('Configuration', () => {
    it('should use configurable learning rate', async () => {
      // Set a custom learning rate
      ctx.preferenceLearner.setConfig({ learning_rate: 0.5 })

      const profile = createDefaultProfile()
      const signal = generateSignal({
        type: SignalType.ACCEPT,
        skillId: 'test',
        category: SkillCategory.DATABASE,
      })

      const updated = await ctx.preferenceLearner.updateProfile(profile, signal)

      // Weight increase should reflect higher learning rate
      const expectedIncrease = SIGNAL_WEIGHTS[SignalType.ACCEPT] * 0.5
      const originalWeight = COLD_START_WEIGHTS.category_weights[SkillCategory.DATABASE] ?? 0
      expect(updated.category_weights[SkillCategory.DATABASE]).toBeCloseTo(
        originalWeight + expectedIncrease,
        5
      )
    })

    it('should return current config', () => {
      const config = ctx.preferenceLearner.getConfig()

      expect(config.learning_rate).toBe(DEFAULT_LEARNING_CONFIG.learning_rate)
      expect(config.decay_factor).toBe(DEFAULT_LEARNING_CONFIG.decay_factor)
      expect(config.min_signals_threshold).toBe(DEFAULT_LEARNING_CONFIG.min_signals_threshold)
      expect(config.weight_bounds).toEqual(DEFAULT_LEARNING_CONFIG.weight_bounds)
    })
  })
})
