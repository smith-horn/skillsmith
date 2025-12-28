/**
 * SMI-629: RankingService Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  RankingService,
  DEFAULT_WEIGHTS,
  TRUST_TIER_MULTIPLIERS,
  type RankableSkill,
  type RankedResult,
} from '../src/ranking/index.js'
import type { SearchResult, Skill, TrustTier } from '../src/types/skill.js'

describe('RankingService', () => {
  let rankingService: RankingService

  beforeEach(() => {
    rankingService = new RankingService()
  })

  // Helper to create test skills
  const createSkill = (overrides: Partial<Skill> = {}): Skill => ({
    id: 'test-skill-1',
    name: 'Test Skill',
    description: 'A test skill for unit testing',
    author: 'test-author',
    repoUrl: 'https://github.com/test/skill',
    qualityScore: 80,
    trustTier: 'community',
    tags: ['testing'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  })

  // Helper to create search results
  const createSearchResult = (skill: Skill, rank: number = 10.0): SearchResult => ({
    skill,
    rank,
    highlights: {},
  })

  describe('constructor', () => {
    it('uses default weights when no options provided', () => {
      const weights = rankingService.getWeights()
      expect(weights).toEqual(DEFAULT_WEIGHTS)
    })

    it('accepts custom weights', () => {
      const customService = new RankingService({
        weights: { relevance: 0.6, popularity: 0.1 },
      })
      const weights = customService.getWeights()
      expect(weights.relevance).toBe(0.6)
      expect(weights.popularity).toBe(0.1)
      expect(weights.recency).toBe(DEFAULT_WEIGHTS.recency)
    })

    it('accepts custom normalization caps', () => {
      const customService = new RankingService({
        maxStars: 5000,
        maxForks: 1000,
        recencyDays: 180,
      })
      expect(customService).toBeDefined()
    })
  })

  describe('rank', () => {
    it('ranks results by combined score', () => {
      const highQualitySkill = createSkill({
        id: 'high',
        qualityScore: 95,
        trustTier: 'verified',
      })
      const lowQualitySkill = createSkill({
        id: 'low',
        qualityScore: 30,
        trustTier: 'unknown',
      })

      const results: SearchResult[] = [
        createSearchResult(lowQualitySkill, 5.0),
        createSearchResult(highQualitySkill, 5.0),
      ]

      const ranked = rankingService.rank(results)

      expect(ranked[0].skill.id).toBe('high')
      expect(ranked[1].skill.id).toBe('low')
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
    })

    it('includes score breakdown in results', () => {
      const skill = createSkill()
      const results = [createSearchResult(skill, 15.0)]

      const ranked = rankingService.rank(results)

      expect(ranked[0].breakdown).toHaveProperty('relevance')
      expect(ranked[0].breakdown).toHaveProperty('popularity')
      expect(ranked[0].breakdown).toHaveProperty('recency')
      expect(ranked[0].breakdown).toHaveProperty('quality')
      expect(ranked[0].breakdown).toHaveProperty('trustTier')
      expect(ranked[0].breakdown).toHaveProperty('final')
    })

    it('uses extended skill data when provided', () => {
      const skill = createSkill({ id: 'popular' })
      const results = [createSearchResult(skill, 10.0)]

      const extendedData = new Map<string, RankableSkill>([
        [
          'popular',
          {
            ...skill,
            stars: 5000,
            forks: 1000,
          },
        ],
      ])

      const withData = rankingService.rank(results, extendedData)
      const withoutData = rankingService.rank(results)

      expect(withData[0].breakdown.popularity).toBeGreaterThan(withoutData[0].breakdown.popularity)
    })

    it('handles empty results', () => {
      const ranked = rankingService.rank([])
      expect(ranked).toEqual([])
    })
  })

  describe('relevance normalization', () => {
    it('normalizes BM25 scores to 0-1 range', () => {
      const skill = createSkill()

      // Low relevance
      const lowRank = rankingService.rank([createSearchResult(skill, 1.0)])
      expect(lowRank[0].breakdown.relevance).toBeGreaterThanOrEqual(0)
      expect(lowRank[0].breakdown.relevance).toBeLessThanOrEqual(1)

      // High relevance
      const highRank = rankingService.rank([createSearchResult(skill, 25.0)])
      expect(highRank[0].breakdown.relevance).toBeGreaterThanOrEqual(0)
      expect(highRank[0].breakdown.relevance).toBeLessThanOrEqual(1)
    })

    it('handles zero and negative ranks', () => {
      const skill = createSkill()

      const zeroRank = rankingService.rank([createSearchResult(skill, 0)])
      expect(zeroRank[0].breakdown.relevance).toBe(0)

      const negativeRank = rankingService.rank([createSearchResult(skill, -5)])
      expect(negativeRank[0].breakdown.relevance).toBe(0)
    })
  })

  describe('recency scoring', () => {
    it('gives full score to recently updated skills', () => {
      const skill = createSkill({
        updatedAt: new Date().toISOString(),
      })
      const result = createSearchResult(skill)
      const ranked = rankingService.rank([result])

      expect(ranked[0].breakdown.recency).toBe(1)
    })

    it('reduces score for stale skills', () => {
      const sixMonthsAgo = new Date()
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

      const skill = createSkill({
        updatedAt: sixMonthsAgo.toISOString(),
      })
      const result = createSearchResult(skill)
      const ranked = rankingService.rank([result])

      expect(ranked[0].breakdown.recency).toBeLessThan(1)
      expect(ranked[0].breakdown.recency).toBeGreaterThan(0.1)
    })

    it('gives minimum score to very old skills', () => {
      const twoYearsAgo = new Date()
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2)

      const skill = createSkill({
        updatedAt: twoYearsAgo.toISOString(),
      })
      const result = createSearchResult(skill)
      const ranked = rankingService.rank([result])

      expect(ranked[0].breakdown.recency).toBe(0.1)
    })

    it('uses default score for missing updatedAt', () => {
      const skill = createSkill({ updatedAt: undefined as unknown as string })
      skill.updatedAt = null as unknown as string
      const result = createSearchResult(skill)
      const ranked = rankingService.rank([result])

      expect(ranked[0].breakdown.recency).toBe(0.3)
    })
  })

  describe('trust tier scoring', () => {
    const testTiers: TrustTier[] = ['verified', 'community', 'experimental', 'unknown']

    testTiers.forEach((tier) => {
      it(`scores ${tier} tier correctly`, () => {
        const skill = createSkill({ trustTier: tier })
        const result = createSearchResult(skill)
        const ranked = rankingService.rank([result])

        expect(ranked[0].breakdown.trustTier).toBe(TRUST_TIER_MULTIPLIERS[tier])
      })
    })

    it('ranks verified higher than community', () => {
      const verified = createSkill({ id: 'verified', trustTier: 'verified' })
      const community = createSkill({ id: 'community', trustTier: 'community' })

      const results = [createSearchResult(community, 10), createSearchResult(verified, 10)]

      const ranked = rankingService.rank(results)
      expect(ranked[0].skill.id).toBe('verified')
    })
  })

  describe('quality score normalization', () => {
    it('normalizes quality scores to 0-1', () => {
      const skill = createSkill({ qualityScore: 75 })
      const result = createSearchResult(skill)
      const ranked = rankingService.rank([result])

      expect(ranked[0].breakdown.quality).toBe(0.75)
    })

    it('handles null quality scores', () => {
      const skill = createSkill({ qualityScore: null })
      const result = createSearchResult(skill)
      const ranked = rankingService.rank([result])

      expect(ranked[0].breakdown.quality).toBe(0.5) // Default
    })

    it('caps quality scores at 0 and 1', () => {
      const lowSkill = createSkill({ qualityScore: -10 })
      const highSkill = createSkill({ id: 'high', qualityScore: 150 })

      const ranked = rankingService.rank([
        createSearchResult(lowSkill),
        createSearchResult(highSkill),
      ])

      const lowRanked = ranked.find((r) => r.skill.id === 'test-skill-1')
      const highRanked = ranked.find((r) => r.skill.id === 'high')

      expect(lowRanked?.breakdown.quality).toBe(0)
      expect(highRanked?.breakdown.quality).toBe(1)
    })
  })

  describe('popularity scoring', () => {
    it('calculates popularity from stars and forks', () => {
      const skill = createSkill()
      const result = createSearchResult(skill)

      const extendedData = new Map<string, RankableSkill>([
        [
          skill.id,
          {
            ...skill,
            stars: 5000,
            forks: 1000,
          },
        ],
      ])

      const ranked = rankingService.rank([result], extendedData)

      // With maxStars=10000, 5000 stars = 0.5 * 0.7 = 0.35
      // With maxForks=2000, 1000 forks = 0.5 * 0.3 = 0.15
      // Total = 0.5
      expect(ranked[0].breakdown.popularity).toBe(0.5)
    })

    it('caps popularity at maximum values', () => {
      const skill = createSkill()
      const result = createSearchResult(skill)

      const extendedData = new Map<string, RankableSkill>([
        [
          skill.id,
          {
            ...skill,
            stars: 100000, // Way over max
            forks: 50000,
          },
        ],
      ])

      const ranked = rankingService.rank([result], extendedData)
      expect(ranked[0].breakdown.popularity).toBe(1) // Capped at max
    })

    it('returns 0 for missing popularity data', () => {
      const skill = createSkill()
      const result = createSearchResult(skill)
      const ranked = rankingService.rank([result])

      expect(ranked[0].breakdown.popularity).toBe(0)
    })
  })

  describe('boost calculation', () => {
    it('boosts exact name matches', () => {
      const skill = createSkill({ name: 'docker' })
      const boost = rankingService.calculateBoost(skill, 'docker')

      expect(boost).toBeGreaterThan(1)
    })

    it('boosts partial name matches', () => {
      const skill = createSkill({ name: 'docker-compose-helper' })
      const boost = rankingService.calculateBoost(skill, 'docker')

      expect(boost).toBeGreaterThan(1)
    })

    it('boosts verified skills', () => {
      const verifiedSkill = createSkill({ trustTier: 'verified' })
      const unverifiedSkill = createSkill({ trustTier: 'unknown' })

      const verifiedBoost = rankingService.calculateBoost(verifiedSkill, 'test')
      const unverifiedBoost = rankingService.calculateBoost(unverifiedSkill, 'test')

      expect(verifiedBoost).toBeGreaterThan(unverifiedBoost)
    })
  })

  describe('applyBoost', () => {
    it('applies boosts and re-sorts results', () => {
      const exactMatch = createSkill({ id: 'exact', name: 'git' })
      const partialMatch = createSkill({ id: 'partial', name: 'git-flow' })

      // Give partial match a higher base score
      const results: SearchResult[] = [
        createSearchResult(exactMatch, 8.0),
        createSearchResult(partialMatch, 12.0),
      ]

      const ranked = rankingService.rank(results)
      const boosted = rankingService.applyBoost(ranked, 'git')

      // Exact match should win after boost
      expect(boosted[0].skill.id).toBe('exact')
    })
  })

  describe('rerank', () => {
    it('re-ranks with updated extended data', () => {
      const skill1 = createSkill({ id: 'skill1' })
      const skill2 = createSkill({ id: 'skill2' })

      const initialResults: SearchResult[] = [
        createSearchResult(skill1, 10),
        createSearchResult(skill2, 10),
      ]

      // First ranking without extended data
      const firstRank = rankingService.rank(initialResults)

      // Re-rank with popularity data
      const updatedData = new Map<string, RankableSkill>([
        [skill2.id, { ...skill2, stars: 9000, forks: 1800 }],
      ])

      const reranked = rankingService.rerank(firstRank, updatedData)

      // skill2 should now rank higher
      expect(reranked[0].skill.id).toBe('skill2')
    })
  })

  describe('edge cases', () => {
    it('handles ties correctly', () => {
      const skill1 = createSkill({ id: '1', qualityScore: 50, trustTier: 'community' })
      const skill2 = createSkill({ id: '2', qualityScore: 50, trustTier: 'community' })

      const results = [createSearchResult(skill1, 10), createSearchResult(skill2, 10)]

      const ranked = rankingService.rank(results)

      // Both should have equal scores
      expect(ranked[0].score).toBe(ranked[1].score)
      expect(ranked).toHaveLength(2)
    })

    it('handles missing description in skill', () => {
      const skill = createSkill({ description: null })
      const result = createSearchResult(skill)
      const ranked = rankingService.rank([result])

      expect(ranked).toHaveLength(1)
    })

    it('handles invalid dates gracefully', () => {
      const skill = createSkill({ updatedAt: 'invalid-date' })
      const result = createSearchResult(skill)

      // Should not throw
      expect(() => rankingService.rank([result])).not.toThrow()
    })

    it('preserves highlights through ranking', () => {
      const skill = createSkill()
      const result: SearchResult = {
        skill,
        rank: 10,
        highlights: {
          name: '<mark>Test</mark> Skill',
          description: 'A <mark>test</mark> skill',
        },
      }

      const ranked = rankingService.rank([result])

      expect(ranked[0].highlights).toEqual(result.highlights)
    })
  })
})
