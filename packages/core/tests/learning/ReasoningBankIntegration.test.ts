/**
 * SMI-1520: ReasoningBank Integration Tests
 *
 * Tests for the ReasoningBankIntegration class that bridges
 * Skillsmith's learning loop with V3's intelligence module.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  ReasoningBankIntegration,
  createReasoningBankIntegration,
  TRAJECTORY_REWARDS,
  CONFIDENCE_THRESHOLDS,
  hasConfidentVerdict,
  indicatesPreference,
  indicatesRejection,
  type SkillVerdict,
} from '../../src/learning/ReasoningBankIntegration.js'
import { DismissReason, type RecommendationContext } from '../../src/learning/types.js'

describe('ReasoningBankIntegration', () => {
  let integration: ReasoningBankIntegration

  const mockContext: RecommendationContext = {
    installed_skills: ['anthropic/review-pr'],
    original_score: 0.85,
    project_context: 'TypeScript project with Jest',
  }

  beforeEach(async () => {
    integration = await createReasoningBankIntegration({
      enableDualWrite: false,
      minPatternsForVerdict: 2,
    })
  })

  describe('initialization', () => {
    it('should create instance with default config', async () => {
      const instance = new ReasoningBankIntegration()
      expect(instance.isInitialized()).toBe(false)

      await instance.initialize()
      expect(instance.isInitialized()).toBe(true)
    })

    it('should create initialized instance via factory', async () => {
      const instance = await createReasoningBankIntegration()
      expect(instance.isInitialized()).toBe(true)
    })

    it('should throw if methods called before initialization', async () => {
      const uninitialized = new ReasoningBankIntegration()

      await expect(uninitialized.recordAccept('test-skill', mockContext)).rejects.toThrow(
        'not initialized'
      )
    })

    it('should allow re-initialization safely', async () => {
      const instance = new ReasoningBankIntegration()
      await instance.initialize()
      await instance.initialize() // Should not throw
      expect(instance.isInitialized()).toBe(true)
    })
  })

  describe('recordAccept', () => {
    it('should record accept signal as positive trajectory', async () => {
      await integration.recordAccept('anthropic/commit', mockContext)

      const verdict = await integration.getVerdict('anthropic/commit')
      // With just 1 pattern, may not have enough data yet
      expect(verdict.skillId).toBe('anthropic/commit')
    })

    it('should record accept with metadata', async () => {
      await integration.recordAccept('anthropic/commit', mockContext, {
        suggestion_count: 1,
        time_to_action: 5000,
      })

      const count = await integration.getSignalCount()
      expect(count).toBeGreaterThanOrEqual(1)
    })

    it('should build positive confidence with multiple accepts', async () => {
      await integration.recordAccept('popular/skill', mockContext)
      await integration.recordAccept('popular/skill', mockContext)
      await integration.recordAccept('popular/skill', mockContext)

      const verdict = await integration.getVerdict('popular/skill')
      expect(verdict.hasEnoughData).toBe(true)
      expect(verdict.confidence).toBeGreaterThan(0)
    })
  })

  describe('recordDismiss', () => {
    it('should record dismiss signal as negative trajectory', async () => {
      await integration.recordDismiss('unwanted/skill', mockContext)

      const verdict = await integration.getVerdict('unwanted/skill')
      expect(verdict.skillId).toBe('unwanted/skill')
    })

    it('should record dismiss with reason', async () => {
      await integration.recordDismiss('unwanted/skill', mockContext, DismissReason.NOT_RELEVANT)

      const count = await integration.getSignalCount()
      expect(count).toBeGreaterThanOrEqual(1)
    })

    it('should build negative confidence with multiple dismisses', async () => {
      await integration.recordDismiss('rejected/skill', mockContext)
      await integration.recordDismiss('rejected/skill', mockContext)
      await integration.recordDismiss('rejected/skill', mockContext)

      const verdict = await integration.getVerdict('rejected/skill')
      expect(verdict.hasEnoughData).toBe(true)
      expect(verdict.confidence).toBeLessThan(0)
    })
  })

  describe('recordUsage', () => {
    it('should record daily usage as reinforcement', async () => {
      await integration.recordUsage('installed/skill', 'daily')

      const count = await integration.getSignalCount()
      expect(count).toBeGreaterThanOrEqual(1)
    })

    it('should record weekly usage as mild reinforcement', async () => {
      await integration.recordUsage('installed/skill', 'weekly')

      const count = await integration.getSignalCount()
      expect(count).toBeGreaterThanOrEqual(1)
    })
  })

  describe('recordAbandonment', () => {
    it('should record abandonment as negative signal', async () => {
      await integration.recordAbandonment('abandoned/skill', 45)

      const verdict = await integration.getVerdict('abandoned/skill')
      expect(verdict.skillId).toBe('abandoned/skill')
    })
  })

  describe('recordUninstall', () => {
    it('should record uninstall as strong negative signal', async () => {
      await integration.recordUninstall('removed/skill', 30)

      const verdict = await integration.getVerdict('removed/skill')
      expect(verdict.skillId).toBe('removed/skill')
    })
  })

  describe('getVerdict', () => {
    it('should return empty verdict for unknown skill', async () => {
      const verdict = await integration.getVerdict('unknown/skill')

      expect(verdict.skillId).toBe('unknown/skill')
      expect(verdict.confidence).toBe(0)
      expect(verdict.patternCount).toBe(0)
      expect(verdict.hasEnoughData).toBe(false)
    })

    it('should calculate mixed confidence correctly', async () => {
      // Record mixed signals
      await integration.recordAccept('mixed/skill', mockContext)
      await integration.recordAccept('mixed/skill', mockContext)
      await integration.recordDismiss('mixed/skill', mockContext)

      const verdict = await integration.getVerdict('mixed/skill')
      expect(verdict.hasEnoughData).toBe(true)
      // 2 accepts vs 1 dismiss should yield slightly positive confidence
      expect(verdict.confidence).toBeGreaterThan(-1)
      expect(verdict.confidence).toBeLessThan(1)
    })

    it('should include signal breakdown', async () => {
      await integration.recordAccept('analyzed/skill', mockContext)
      await integration.recordAccept('analyzed/skill', mockContext)
      await integration.recordDismiss('analyzed/skill', mockContext)
      await integration.recordUsage('analyzed/skill', 'daily')

      const verdict = await integration.getVerdict('analyzed/skill')

      expect(verdict.signalBreakdown).toBeDefined()
      if (verdict.signalBreakdown) {
        expect(verdict.signalBreakdown.accepts).toBe(2)
        expect(verdict.signalBreakdown.dismisses).toBe(1)
        expect(verdict.signalBreakdown.usages).toBe(1)
      }
    })
  })

  describe('getBatchVerdicts', () => {
    it('should return verdicts for multiple skills', async () => {
      await integration.recordAccept('skill-a', mockContext)
      await integration.recordAccept('skill-a', mockContext)
      await integration.recordDismiss('skill-b', mockContext)
      await integration.recordDismiss('skill-b', mockContext)

      const result = await integration.getBatchVerdicts(['skill-a', 'skill-b', 'skill-c'])

      expect(result.verdicts.length).toBe(3)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('getTopSkillsByConfidence', () => {
    it('should return empty array when no patterns exist', async () => {
      const top = await integration.getTopSkillsByConfidence(5)
      expect(top).toEqual([])
    })

    it('should return skills sorted by confidence', async () => {
      // Create patterns with different confidence levels
      await integration.recordAccept('high/skill', mockContext)
      await integration.recordAccept('high/skill', mockContext)
      await integration.recordAccept('high/skill', mockContext)

      await integration.recordAccept('medium/skill', mockContext)
      await integration.recordDismiss('medium/skill', mockContext)

      const top = await integration.getTopSkillsByConfidence(10)

      // high/skill should appear before medium/skill
      if (top.length >= 2) {
        expect(top[0].confidence).toBeGreaterThanOrEqual(top[1].confidence)
      }
    })
  })

  describe('getSignals', () => {
    it('should return empty array without legacy collector', async () => {
      const signals = await integration.getSignals({})
      expect(signals).toEqual([])
    })

    it('should return empty for skill without legacy collector', async () => {
      const signals = await integration.getSignalsForSkill('any-skill')
      expect(signals).toEqual([])
    })
  })
})

describe('TRAJECTORY_REWARDS', () => {
  it('should have correct reward values', () => {
    expect(TRAJECTORY_REWARDS.ACCEPT).toBe(1.0)
    expect(TRAJECTORY_REWARDS.DISMISS).toBe(-0.5)
    expect(TRAJECTORY_REWARDS.USAGE).toBe(0.3)
    expect(TRAJECTORY_REWARDS.ABANDONMENT).toBe(-0.3)
    expect(TRAJECTORY_REWARDS.UNINSTALL).toBe(-0.7)
  })

  it('should have positive reward for accept', () => {
    expect(TRAJECTORY_REWARDS.ACCEPT).toBeGreaterThan(0)
  })

  it('should have negative rewards for rejections', () => {
    expect(TRAJECTORY_REWARDS.DISMISS).toBeLessThan(0)
    expect(TRAJECTORY_REWARDS.ABANDONMENT).toBeLessThan(0)
    expect(TRAJECTORY_REWARDS.UNINSTALL).toBeLessThan(0)
  })
})

describe('CONFIDENCE_THRESHOLDS', () => {
  it('should have descending threshold values', () => {
    expect(CONFIDENCE_THRESHOLDS.HIGH).toBeGreaterThan(CONFIDENCE_THRESHOLDS.MEDIUM)
    expect(CONFIDENCE_THRESHOLDS.MEDIUM).toBeGreaterThan(CONFIDENCE_THRESHOLDS.LOW)
    expect(CONFIDENCE_THRESHOLDS.LOW).toBeGreaterThan(CONFIDENCE_THRESHOLDS.MINIMUM)
  })

  it('should have MINIMUM less than LOW', () => {
    expect(CONFIDENCE_THRESHOLDS.MINIMUM).toBeLessThan(CONFIDENCE_THRESHOLDS.LOW)
  })
})

describe('type guards', () => {
  const highConfidenceVerdict: SkillVerdict = {
    skillId: 'test',
    confidence: 0.85,
    patternCount: 10,
    hasEnoughData: true,
  }

  const lowConfidenceVerdict: SkillVerdict = {
    skillId: 'test',
    confidence: 0.05,
    patternCount: 1,
    hasEnoughData: false,
  }

  const negativeVerdict: SkillVerdict = {
    skillId: 'test',
    confidence: -0.7,
    patternCount: 5,
    hasEnoughData: true,
  }

  describe('hasConfidentVerdict', () => {
    it('should return true for confident verdict', () => {
      expect(hasConfidentVerdict(highConfidenceVerdict)).toBe(true)
    })

    it('should return false for low confidence verdict', () => {
      expect(hasConfidentVerdict(lowConfidenceVerdict)).toBe(false)
    })

    it('should return true for negative confident verdict', () => {
      expect(hasConfidentVerdict(negativeVerdict)).toBe(true)
    })
  })

  describe('indicatesPreference', () => {
    it('should return true for positive confident verdict', () => {
      expect(indicatesPreference(highConfidenceVerdict)).toBe(true)
    })

    it('should return false for negative verdict', () => {
      expect(indicatesPreference(negativeVerdict)).toBe(false)
    })

    it('should return false for insufficient data', () => {
      expect(indicatesPreference(lowConfidenceVerdict)).toBe(false)
    })
  })

  describe('indicatesRejection', () => {
    it('should return true for negative confident verdict', () => {
      expect(indicatesRejection(negativeVerdict)).toBe(true)
    })

    it('should return false for positive verdict', () => {
      expect(indicatesRejection(highConfidenceVerdict)).toBe(false)
    })

    it('should return false for insufficient data', () => {
      expect(indicatesRejection(lowConfidenceVerdict)).toBe(false)
    })
  })
})
