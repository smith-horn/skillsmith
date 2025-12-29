/**
 * Quality Scoring Algorithm Tests (SMI-592)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  QualityScorer,
  quickScore,
  scoreFromRepository,
  type QualityScoringInput,
} from '../src/scoring/index.js'

describe('QualityScorer (SMI-592)', () => {
  let scorer: QualityScorer

  beforeEach(() => {
    scorer = new QualityScorer()
  })

  describe('calculate', () => {
    it('should return a score between 0 and 100', () => {
      const result = scorer.calculate({
        stars: 100,
        forks: 20,
        updatedAt: new Date().toISOString(),
        createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      })

      expect(result.total).toBeGreaterThanOrEqual(0)
      expect(result.total).toBeLessThanOrEqual(100)
    })

    it('should give higher scores to popular repositories', () => {
      const popular = scorer.calculate({
        stars: 1000,
        forks: 200,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })

      const unpopular = scorer.calculate({
        stars: 1,
        forks: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })

      expect(popular.total).toBeGreaterThan(unpopular.total)
      expect(popular.popularity).toBeGreaterThan(unpopular.popularity)
    })

    it('should give higher scores to recently updated repositories', () => {
      const recent = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })

      const old = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString(),
      })

      expect(recent.total).toBeGreaterThan(old.total)
      expect(recent.activity).toBeGreaterThan(old.activity)
    })

    it('should reward good documentation', () => {
      const documented = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        hasReadme: true,
        hasSkillFile: true,
        skillFileLength: 2000,
        descriptionLength: 100,
      })

      const undocumented = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        hasReadme: false,
        hasSkillFile: false,
        descriptionLength: 0,
      })

      expect(documented.total).toBeGreaterThan(undocumented.total)
      expect(documented.documentation).toBeGreaterThan(undocumented.documentation)
    })

    it('should reward verified owners', () => {
      const verified = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        owner: 'anthropics',
      })

      const unverified = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        owner: 'random-user',
      })

      expect(verified.total).toBeGreaterThan(unverified.total)
      expect(verified.trust).toBeGreaterThan(unverified.trust)
      expect(verified.factors.verifiedOwner).toBeGreaterThan(0)
      expect(unverified.factors.verifiedOwner).toBe(0)
    })

    it('should reward approved licenses', () => {
      const licensed = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        license: 'MIT',
      })

      const unlicensed = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        license: null,
      })

      expect(licensed.total).toBeGreaterThan(unlicensed.total)
      expect(licensed.factors.license).toBeGreaterThan(unlicensed.factors.license)
    })

    it('should reward relevant topics', () => {
      const relevant = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        topics: ['claude-skill', 'mcp', 'anthropic'],
      })

      const irrelevant = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        topics: ['random', 'unrelated'],
      })

      expect(relevant.factors.topics).toBeGreaterThan(irrelevant.factors.topics)
    })

    it('should provide score breakdown', () => {
      const result = scorer.calculate({
        stars: 100,
        forks: 20,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        hasReadme: true,
        hasSkillFile: true,
        license: 'MIT',
        topics: ['claude-skill'],
      })

      expect(result).toHaveProperty('total')
      expect(result).toHaveProperty('popularity')
      expect(result).toHaveProperty('activity')
      expect(result).toHaveProperty('documentation')
      expect(result).toHaveProperty('trust')
      expect(result).toHaveProperty('factors')

      expect(result.factors).toHaveProperty('stars')
      expect(result.factors).toHaveProperty('forks')
      expect(result.factors).toHaveProperty('recency')
      expect(result.factors).toHaveProperty('license')
    })

    it('should handle zero inputs gracefully', () => {
      const result = scorer.calculate({
        stars: 0,
        forks: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })

      expect(result.total).toBeGreaterThanOrEqual(0)
      expect(result.factors.stars).toBe(0)
      expect(result.factors.forks).toBe(0)
    })
  })

  describe('calculateTrustTier', () => {
    it('should return verified for anthropics owner', () => {
      const input: QualityScoringInput = {
        stars: 10,
        forks: 2,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        owner: 'anthropics',
      }

      const tier = scorer.calculateTrustTier(input, 50)
      expect(tier).toBe('verified')
    })

    it('should return verified for isVerifiedOwner flag', () => {
      const input: QualityScoringInput = {
        stars: 10,
        forks: 2,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        isVerifiedOwner: true,
      }

      const tier = scorer.calculateTrustTier(input, 50)
      expect(tier).toBe('verified')
    })

    it('should return verified for official topic', () => {
      const input: QualityScoringInput = {
        stars: 10,
        forks: 2,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        topics: ['claude-code-official'],
      }

      const tier = scorer.calculateTrustTier(input, 50)
      expect(tier).toBe('verified')
    })

    it('should return community for high score with stars and license', () => {
      const input: QualityScoringInput = {
        stars: 100,
        forks: 20,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        hasLicense: true,
      }

      const tier = scorer.calculateTrustTier(input, 75)
      expect(tier).toBe('community')
    })

    it('should return experimental for moderate score with some stars', () => {
      const input: QualityScoringInput = {
        stars: 10,
        forks: 2,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }

      const tier = scorer.calculateTrustTier(input, 50)
      expect(tier).toBe('experimental')
    })

    it('should return unknown for low score or no stars', () => {
      const input: QualityScoringInput = {
        stars: 0,
        forks: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }

      const tier = scorer.calculateTrustTier(input, 20)
      expect(tier).toBe('unknown')
    })
  })

  describe('Custom weights', () => {
    it('should apply custom weights', () => {
      const customScorer = new QualityScorer({
        stars: 30, // Double the weight
      })

      const result = customScorer.calculate({
        stars: 100,
        forks: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })

      // With higher star weight, popularity should be higher
      expect(result.popularity).toBeGreaterThan(0)
    })
  })

  describe('quickScore', () => {
    it('should return a quick score', () => {
      const score = quickScore(100, 20, new Date().toISOString())

      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    })

    it('should give higher scores to better repositories', () => {
      const good = quickScore(1000, 100, new Date().toISOString())
      const bad = quickScore(1, 0, new Date().toISOString())

      expect(good).toBeGreaterThan(bad)
    })
  })

  describe('scoreFromRepository', () => {
    it('should score from repository data', () => {
      const result = scoreFromRepository({
        stars: 100,
        forks: 20,
        watchers: 50,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        topics: ['claude-skill'],
        owner: 'test-user',
        license: 'MIT',
        description: 'A test skill for Claude Code',
        openIssues: 5,
      })

      expect(result.total).toBeGreaterThanOrEqual(0)
      expect(result.total).toBeLessThanOrEqual(100)
      expect(result.factors.stars).toBeGreaterThan(0)
      expect(result.factors.license).toBeGreaterThan(0)
    })

    it('should handle minimal repository data', () => {
      const result = scoreFromRepository({
        stars: 10,
        forks: 2,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })

      expect(result.total).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Edge cases', () => {
    it('should handle very large star counts', () => {
      const result = scorer.calculate({
        stars: 100000,
        forks: 50000,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })

      expect(result.total).toBeLessThanOrEqual(100)
      expect(result.factors.stars).toBeLessThanOrEqual(15) // Max weight
    })

    it('should handle very old repositories', () => {
      const result = scorer.calculate({
        stars: 100,
        forks: 20,
        updatedAt: new Date('2010-01-01').toISOString(),
        createdAt: new Date('2009-01-01').toISOString(),
      })

      expect(result.total).toBeGreaterThanOrEqual(0)
      expect(result.factors.recency).toBeLessThan(2) // Very old = low recency score
    })

    it('should handle future dates gracefully', () => {
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      const result = scorer.calculate({
        stars: 100,
        forks: 20,
        updatedAt: future.toISOString(),
        createdAt: new Date().toISOString(),
      })

      expect(result.total).toBeGreaterThanOrEqual(0)
    })

    it('should handle content quality signals', () => {
      const result = scorer.calculate({
        stars: 50,
        forks: 10,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        hasExamples: true,
        hasTroubleshooting: true,
        hasPrerequisites: true,
      })

      expect(result.factors.contentQuality).toBeGreaterThan(0)
    })
  })
})
