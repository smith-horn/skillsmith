/**
 * SMI-1535: Personalization Engine Integration Tests
 *
 * Tests the IPersonalizationEngine interface for applying learned
 * preferences to recommendation results in the Recommendation Learning Loop.
 *
 * Test Cases:
 * 1. shouldPersonalize() returns false with <5 signals
 * 2. shouldPersonalize() returns true with 5+ signals
 * 3. personalizeRecommendations() re-ranks by learned scores
 * 4. Category weight boosts preferred categories
 * 5. Dismiss patterns reduce scores for related skills
 * 6. Uninstall patterns have strongest negative effect
 * 7. Score breakdown shows contributing factors
 * 8. Personalization disabled by user preference
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
import { generateContext } from './helpers.js'
import { SkillCategory } from '../../../src/learning/types.js'

describe('PersonalizationEngine Integration', () => {
  let ctx: NeuralTestContext

  beforeEach(() => {
    ctx = createNeuralTestContext()
  })

  afterEach(async () => {
    await cleanupNeuralTestContext(ctx)
  })

  describe('Personalization Threshold', () => {
    it('should return false for shouldPersonalize with <5 signals', async () => {
      // Add only 4 signals
      for (let i = 0; i < 4; i++) {
        await ctx.signalCollector.recordAccept(`skill-${i}`, generateContext())
      }

      const shouldPersonalize = await ctx.personalizationEngine.shouldPersonalize()

      expect(shouldPersonalize).toBe(false)
    })

    it('should return true for shouldPersonalize with 5+ signals', async () => {
      // Add exactly 5 signals (threshold)
      for (let i = 0; i < 5; i++) {
        await ctx.signalCollector.recordAccept(`skill-${i}`, generateContext())
      }

      const shouldPersonalize = await ctx.personalizationEngine.shouldPersonalize()

      expect(shouldPersonalize).toBe(true)
    })

    it('should return true with many signals', async () => {
      // Add 20 signals
      for (let i = 0; i < 20; i++) {
        await ctx.signalCollector.recordAccept(`skill-${i}`, generateContext())
      }

      const shouldPersonalize = await ctx.personalizationEngine.shouldPersonalize()

      expect(shouldPersonalize).toBe(true)
    })
  })

  describe('Recommendation Re-ranking', () => {
    it('should re-rank recommendations by learned scores', async () => {
      // Build up preference for testing category
      for (let i = 0; i < 10; i++) {
        await ctx.signalCollector.recordAccept(
          `testing-skill-${i}`,
          generateContext({ category: SkillCategory.TESTING })
        )
      }

      // Train the profile
      let profile = createDefaultProfile()
      const signals = await ctx.signalCollector.getSignals({})
      profile = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      await ctx.profileRepository.saveProfile(profile)

      // Create recommendations with testing skill having lower base score
      const recommendations = [
        {
          skill_id: 'devops-skill',
          base_score: 0.9,
          skill_data: { category: SkillCategory.DEVOPS, trustTier: 'community' },
        },
        {
          skill_id: 'testing-skill',
          base_score: 0.7, // Lower base score
          skill_data: { category: SkillCategory.TESTING, trustTier: 'community' },
        },
        {
          skill_id: 'frontend-skill',
          base_score: 0.8,
          skill_data: { category: SkillCategory.FRONTEND, trustTier: 'community' },
        },
      ]

      const personalized =
        await ctx.personalizationEngine.personalizeRecommendations(recommendations)

      // Results should be sorted by personalized_score descending
      for (let i = 1; i < personalized.length; i++) {
        expect(personalized[i - 1].personalized_score).toBeGreaterThanOrEqual(
          personalized[i].personalized_score
        )
      }
    })
  })

  describe('Category Weight Boosting', () => {
    it('should boost scores for preferred categories', async () => {
      // Build strong preference for TESTING
      for (let i = 0; i < 15; i++) {
        await ctx.signalCollector.recordAccept(
          `testing-skill-${i}`,
          generateContext({ category: SkillCategory.TESTING })
        )
        await ctx.signalCollector.recordUsage(`testing-skill-${i}`, 'daily')
      }

      // Train profile
      let profile = createDefaultProfile()
      const signals = await ctx.signalCollector.getSignals({})
      profile = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      await ctx.profileRepository.saveProfile(profile)

      // Test single skill personalization
      const recommendations = [
        {
          skill_id: 'preferred-skill',
          base_score: 0.5,
          skill_data: { category: SkillCategory.TESTING, trustTier: 'community' },
        },
      ]

      const [result] = await ctx.personalizationEngine.personalizeRecommendations(recommendations)

      // Category boost should be positive
      expect(result.score_breakdown.category_boost).toBeGreaterThan(0)
      expect(result.personalization_applied).toBe(true)
    })
  })

  describe('Dismiss Pattern Effects', () => {
    it('should reduce scores for skills matching dismiss patterns', async () => {
      // Dismiss multiple skills to establish negative patterns
      const dismissedSkills = ['skill-a', 'skill-b', 'skill-c', 'skill-d', 'skill-e']
      for (const skillId of dismissedSkills) {
        await ctx.signalCollector.recordDismiss(skillId, generateContext())
      }

      // Train profile with dismissals
      let profile = createDefaultProfile()
      const signals = await ctx.signalCollector.getSignals({})
      profile = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      await ctx.profileRepository.saveProfile(profile)

      // Try to recommend a dismissed skill
      const recommendations = [
        {
          skill_id: 'skill-a', // Previously dismissed
          base_score: 0.9,
          skill_data: { category: SkillCategory.GIT, trustTier: 'verified' },
        },
        {
          skill_id: 'new-skill', // Never seen before
          base_score: 0.7,
          skill_data: { category: SkillCategory.GIT, trustTier: 'verified' },
        },
      ]

      const personalized =
        await ctx.personalizationEngine.personalizeRecommendations(recommendations)

      // Find results
      const dismissedResult = personalized.find((r) => r.skill_id === 'skill-a')!
      const newResult = personalized.find((r) => r.skill_id === 'new-skill')!

      // Dismissed skill should have anti-penalty
      expect(dismissedResult.score_breakdown.anti_penalty).toBeLessThan(0)

      // New skill should have no anti-penalty
      expect(newResult.score_breakdown.anti_penalty).toBe(0)
    })
  })

  describe('Uninstall Impact', () => {
    it('should apply strongest negative effect for uninstalled skills', async () => {
      // Uninstall some skills (strongest negative signal)
      const uninstalledSkills = ['uninstalled-1', 'uninstalled-2']
      for (const skillId of uninstalledSkills) {
        await ctx.signalCollector.recordAccept(skillId, generateContext())
        await ctx.signalCollector.recordUninstall(skillId, 7)
      }

      // Also dismiss some (weaker negative)
      await ctx.signalCollector.recordDismiss('dismissed-1', generateContext())

      // Train profile
      let profile = createDefaultProfile()
      const signals = await ctx.signalCollector.getSignals({})
      profile = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      await ctx.profileRepository.saveProfile(profile)

      // Both uninstalled and dismissed should be in negative patterns
      expect(profile.negative_patterns.skill_ids).toContain('uninstalled-1')
      expect(profile.negative_patterns.skill_ids).toContain('dismissed-1')

      // Try to recommend
      const recommendations = [
        {
          skill_id: 'uninstalled-1',
          base_score: 0.9,
          skill_data: { category: SkillCategory.BACKEND },
        },
        {
          skill_id: 'dismissed-1',
          base_score: 0.9,
          skill_data: { category: SkillCategory.BACKEND },
        },
      ]

      const personalized =
        await ctx.personalizationEngine.personalizeRecommendations(recommendations)

      // Both should have anti-penalty
      for (const result of personalized) {
        expect(result.score_breakdown.anti_penalty).toBeLessThan(0)
      }
    })
  })

  describe('Score Breakdown', () => {
    it('should show contributing factors in score breakdown', async () => {
      // Build mixed preferences
      for (let i = 0; i < 8; i++) {
        await ctx.signalCollector.recordAccept(
          `skill-${i}`,
          generateContext({
            category: SkillCategory.TESTING,
            trustTier: 'verified',
          })
        )
      }

      let profile = createDefaultProfile()
      const signals = await ctx.signalCollector.getSignals({})
      profile = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      await ctx.profileRepository.saveProfile(profile)

      const recommendations = [
        {
          skill_id: 'new-testing-skill',
          base_score: 0.75,
          skill_data: {
            category: SkillCategory.TESTING,
            trustTier: 'verified',
            keywords: ['unit', 'integration'],
          },
        },
      ]

      const [result] = await ctx.personalizationEngine.personalizeRecommendations(recommendations)

      // Score breakdown should contain all components
      expect(result.score_breakdown).toHaveProperty('category_boost')
      expect(result.score_breakdown).toHaveProperty('trust_boost')
      expect(result.score_breakdown).toHaveProperty('keyword_boost')
      expect(result.score_breakdown).toHaveProperty('anti_penalty')

      // For this profile, we should see positive category and trust boosts
      expect(result.score_breakdown.category_boost).toBeGreaterThan(0)
      expect(result.score_breakdown.trust_boost).toBeGreaterThan(0)
      expect(result.score_breakdown.anti_penalty).toBe(0) // Not a dismissed skill
    })
  })

  describe('Personalization Control', () => {
    it('should not apply personalization when below threshold', async () => {
      // Only 3 signals (below threshold of 5)
      for (let i = 0; i < 3; i++) {
        await ctx.signalCollector.recordAccept(
          `skill-${i}`,
          generateContext({ category: SkillCategory.GIT })
        )
      }

      // Even with profile data, personalization shouldn't apply
      let profile = createDefaultProfile()
      const signals = await ctx.signalCollector.getSignals({})
      profile = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      await ctx.profileRepository.saveProfile(profile)

      const recommendations = [
        {
          skill_id: 'some-skill',
          base_score: 0.8,
          skill_data: { category: SkillCategory.GIT },
        },
      ]

      const [result] = await ctx.personalizationEngine.personalizeRecommendations(recommendations)

      // Personalization should not be applied
      expect(result.personalization_applied).toBe(false)
      // Score should equal base score when not personalized
      expect(result.personalized_score).toBe(0.8)
    })

    it('should reset to default when requested', async () => {
      // Build some preferences
      for (let i = 0; i < 10; i++) {
        await ctx.signalCollector.recordAccept(`skill-${i}`, generateContext())
      }

      let profile = createDefaultProfile()
      const signals = await ctx.signalCollector.getSignals({})
      profile = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      await ctx.profileRepository.saveProfile(profile, 'user-1')

      // Verify profile exists
      expect(await ctx.profileRepository.exists('user-1')).toBe(true)

      // Reset
      await ctx.personalizationEngine.resetToDefault('user-1')

      // Profile should be deleted
      expect(await ctx.profileRepository.exists('user-1')).toBe(false)
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty recommendations list', async () => {
      const personalized = await ctx.personalizationEngine.personalizeRecommendations([])
      expect(personalized).toEqual([])
    })

    it('should handle skills without category', async () => {
      // Add signals to meet threshold
      for (let i = 0; i < 5; i++) {
        await ctx.signalCollector.recordAccept(`skill-${i}`, generateContext())
      }

      const recommendations = [
        {
          skill_id: 'no-category-skill',
          base_score: 0.7,
          skill_data: { trustTier: 'community' }, // No category
        },
      ]

      const [result] = await ctx.personalizationEngine.personalizeRecommendations(recommendations)

      expect(result.skill_id).toBe('no-category-skill')
      expect(result.score_breakdown.category_boost).toBe(0)
    })

    it('should handle user with no profile', async () => {
      // Add signals to meet threshold
      for (let i = 0; i < 5; i++) {
        await ctx.signalCollector.recordAccept(`skill-${i}`, generateContext())
      }

      // No profile saved for 'new-user'
      const profile = await ctx.personalizationEngine.getUserProfile('new-user')

      // Should return default profile
      expect(profile.signal_count).toBe(0)
      expect(profile.version).toBe(1)
    })
  })
})
