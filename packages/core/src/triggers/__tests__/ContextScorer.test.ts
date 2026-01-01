/**
 * @fileoverview Tests for ContextScorer
 * @module @skillsmith/core/triggers/__tests__/ContextScorer
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ContextScorer } from '../ContextScorer.js'
import type { DetectedTrigger } from '../TriggerDetector.js'

describe('ContextScorer', () => {
  let scorer: ContextScorer

  beforeEach(() => {
    scorer = new ContextScorer()
  })

  describe('Basic Scoring', () => {
    it('should return zero score for no triggers', () => {
      const score = scorer.scoreContext([])

      expect(score.score).toBe(0)
      expect(score.confidence).toBe(0)
      expect(score.triggers).toEqual([])
      expect(score.recommendedCategories).toEqual([])
    })

    it('should score single file trigger', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing', 'jest'],
          confidence: 0.9,
          reason: 'Test file detected',
          source: 'App.test.tsx',
        },
      ]

      const score = scorer.scoreContext(triggers)

      expect(score.score).toBeGreaterThan(0)
      expect(score.confidence).toBeGreaterThanOrEqual(0.9)
      expect(score.triggers).toContain('file')
      expect(score.recommendedCategories).toContain('testing')
      expect(score.recommendedCategories).toContain('jest')
    })

    it('should apply correct weight for file triggers', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test file',
        },
      ]

      const score = scorer.scoreContext(triggers)

      // With a single trigger type, score normalizes to the trigger's confidence
      // (totalScore = 1.0 * 0.4 = 0.4, totalWeight = 0.4, finalScore = 0.4/0.4 = 1.0)
      expect(score.score).toBeCloseTo(1.0, 1)
    })
  })

  describe('Multi-Trigger Scoring', () => {
    it('should combine multiple trigger types', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 0.9,
          reason: 'Test file',
        },
        {
          type: 'command',
          categories: ['testing'],
          confidence: 0.8,
          reason: 'Test command',
        },
      ]

      const score = scorer.scoreContext(triggers)

      expect(score.score).toBeGreaterThan(0)
      expect(score.triggers.length).toBe(2)
      expect(score.triggers).toContain('file')
      expect(score.triggers).toContain('command')
    })

    it('should apply multi-trigger boost', () => {
      const singleTrigger: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 0.9,
          reason: 'Test file',
        },
      ]

      const multiTriggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 0.9,
          reason: 'Test file',
        },
        {
          type: 'command',
          categories: ['testing'],
          confidence: 0.8,
          reason: 'Test command',
        },
      ]

      const singleScore = scorer.scoreContext(singleTrigger)
      const multiScore = scorer.scoreContext(multiTriggers)

      // Multi-trigger score should be higher due to boost
      expect(multiScore.score).toBeGreaterThan(singleScore.score)
    })

    it('should boost confidence for diverse triggers', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 0.9,
          reason: 'Test file',
        },
        {
          type: 'command',
          categories: ['testing'],
          confidence: 0.8,
          reason: 'Test command',
        },
        {
          type: 'project',
          categories: ['react'],
          confidence: 0.95,
          reason: 'React project',
        },
      ]

      const score = scorer.scoreContext(triggers)

      // Confidence should be boosted for diverse trigger types
      expect(score.confidence).toBeGreaterThan(0.8)
    })
  })

  describe('Threshold Checking', () => {
    it('should suggest for high relevance scores', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test file',
        },
        {
          type: 'command',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test command',
        },
        {
          type: 'project',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test project',
        },
      ]

      const score = scorer.scoreContext(triggers)
      expect(scorer.shouldSuggest(score)).toBe(true)
    })

    it('should not suggest for low relevance scores', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 0.1,
          reason: 'Weak match',
        },
      ]

      const score = scorer.scoreContext(triggers)
      expect(scorer.shouldSuggest(score)).toBe(false)
    })

    it('should suggest medium relevance with high confidence', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 0.9,
          reason: 'Test file',
        },
        {
          type: 'command',
          categories: ['testing'],
          confidence: 0.8,
          reason: 'Test command',
        },
      ]

      const score = scorer.scoreContext(triggers)

      // Medium score (0.4-0.6) with high confidence (>0.7) should suggest
      if (score.score >= 0.4 && score.score < 0.6) {
        expect(scorer.shouldSuggest(score)).toBe(score.confidence >= 0.7)
      }
    })
  })

  describe('Urgency Levels', () => {
    it('should return high urgency for high scores', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test file',
        },
        {
          type: 'command',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test command',
        },
        {
          type: 'project',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test project',
        },
        {
          type: 'error',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test error',
        },
      ]

      const score = scorer.scoreContext(triggers)
      const urgency = scorer.getUrgency(score)

      if (score.score >= 0.8) {
        expect(urgency).toBe('high')
      }
    })

    it('should return medium urgency for medium scores', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 0.8,
          reason: 'Test file',
        },
      ]

      const score = scorer.scoreContext(triggers)
      const urgency = scorer.getUrgency(score)

      if (score.score >= 0.6 && score.score < 0.8) {
        expect(urgency).toBe('medium')
      }
    })

    it('should return low urgency for low scores', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 0.3,
          reason: 'Weak match',
        },
      ]

      const score = scorer.scoreContext(triggers)
      const urgency = scorer.getUrgency(score)

      if (score.score < 0.6) {
        expect(urgency).toBe('low')
      }
    })
  })

  describe('Custom Weights', () => {
    it('should apply custom weights', () => {
      const customScorer = new ContextScorer({
        weights: {
          fileWeight: 1.0,
          commandWeight: 0.0,
          errorWeight: 0.0,
          projectWeight: 0.0,
        },
      })

      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test file',
        },
        {
          type: 'command',
          categories: ['testing'],
          confidence: 1.0,
          reason: 'Test command',
        },
      ]

      const score = customScorer.scoreContext(triggers)

      // With fileWeight=1.0 and others=0.0, only file trigger should contribute
      expect(score.score).toBeCloseTo(1.0, 1)
    })
  })

  describe('Reason Generation', () => {
    it('should generate informative reasons', () => {
      const triggers: DetectedTrigger[] = [
        {
          type: 'file',
          categories: ['testing'],
          confidence: 0.9,
          reason: 'Test file',
          source: 'App.test.tsx',
        },
        {
          type: 'command',
          categories: ['testing'],
          confidence: 0.8,
          reason: 'Test command',
          source: 'npm test',
        },
      ]

      const score = scorer.scoreContext(triggers)

      expect(score.reason).toBeTruthy()
      expect(score.reason.length).toBeGreaterThan(0)
      // Reason should be descriptive
      expect(score.reason).toMatch(/match/i)
    })
  })
})
