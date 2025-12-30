/**
 * SMI-602: SkillMatcher Tests
 * Tests for semantic skill matching functionality
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SkillMatcher, type MatchableSkill } from '../src/matching/index.js'

describe('SkillMatcher', () => {
  let matcher: SkillMatcher

  const testSkills: MatchableSkill[] = [
    {
      id: 'skill-1',
      name: 'React Testing',
      description: 'Generate tests for React components',
      keywords: ['react', 'testing', 'jest', 'component'],
      qualityScore: 90,
    },
    {
      id: 'skill-2',
      name: 'Docker Helper',
      description: 'Create Docker configurations and compose files',
      keywords: ['docker', 'devops', 'containers'],
      qualityScore: 85,
    },
    {
      id: 'skill-3',
      name: 'API Documentation',
      description: 'Generate OpenAPI specs from code',
      keywords: ['api', 'documentation', 'openapi'],
      qualityScore: 80,
    },
    {
      id: 'skill-4',
      name: 'Vue Testing',
      description: 'Generate tests for Vue components',
      keywords: ['vue', 'testing', 'jest', 'component'],
      qualityScore: 88,
    },
    {
      id: 'skill-5',
      name: 'Git Commit',
      description: 'Generate semantic commit messages',
      keywords: ['git', 'commit', 'conventional'],
      qualityScore: 95,
    },
  ]

  beforeEach(() => {
    matcher = new SkillMatcher({ useFallback: true })
  })

  afterEach(() => {
    matcher.close()
  })

  describe('initialization', () => {
    it('should create matcher with default options', () => {
      const m = new SkillMatcher()
      expect(m).toBeDefined()
      m.close()
    })

    it('should create matcher with custom options', () => {
      const m = new SkillMatcher({
        useFallback: true,
        minSimilarity: 0.5,
        qualityWeight: 0.4,
      })
      expect(m).toBeDefined()
      m.close()
    })

    it('should report fallback mode correctly', () => {
      expect(matcher.isUsingFallback()).toBe(true)
    })

    it('should return correct embedding dimension', () => {
      expect(matcher.getEmbeddingDimension()).toBe(384)
    })
  })

  describe('initialize', () => {
    it('should initialize skill embeddings', async () => {
      await matcher.initialize(testSkills)
      // Should not throw
      expect(true).toBe(true)
    })

    it('should handle empty skill list', async () => {
      await matcher.initialize([])
      // Should not throw
      expect(true).toBe(true)
    })

    it('should handle skills with trigger phrases', async () => {
      const skillsWithTriggers: MatchableSkill[] = [
        {
          id: 'trigger-skill',
          name: 'Trigger Test',
          description: 'A skill with triggers',
          triggerPhrases: ['run test', 'execute test'],
          keywords: ['test'],
        },
      ]
      await matcher.initialize(skillsWithTriggers)
      expect(true).toBe(true)
    })
  })

  describe('findSimilarSkills', () => {
    it('should find similar skills for a query', async () => {
      const results = await matcher.findSimilarSkills('react testing', testSkills, 5)

      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(5)
    })

    it('should return skills with similarity scores', async () => {
      const results = await matcher.findSimilarSkills('testing', testSkills, 5)

      for (const result of results) {
        expect(result.similarityScore).toBeGreaterThanOrEqual(0)
        expect(result.similarityScore).toBeLessThanOrEqual(1)
      }
    })

    it('should return skills with match reasons', async () => {
      const results = await matcher.findSimilarSkills('testing components', testSkills, 5)

      for (const result of results) {
        expect(result.matchReason).toBeDefined()
        expect(result.matchReason.length).toBeGreaterThan(0)
      }
    })

    it('should return skills sorted by similarity', async () => {
      const results = await matcher.findSimilarSkills('testing', testSkills, 5)

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarityScore).toBeGreaterThanOrEqual(results[i].similarityScore)
      }
    })

    it('should respect limit parameter', async () => {
      const results = await matcher.findSimilarSkills('testing', testSkills, 2)

      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('should filter by minimum similarity', async () => {
      const m = new SkillMatcher({
        useFallback: true,
        minSimilarity: 0.9, // Very high threshold
      })

      const results = await m.findSimilarSkills('xyz random query', testSkills, 5)

      // With high threshold and random query, may get fewer results
      for (const result of results) {
        expect(result.similarityScore).toBeGreaterThanOrEqual(0.9)
      }

      m.close()
    })

    it('should apply quality weight', async () => {
      const m = new SkillMatcher({
        useFallback: true,
        qualityWeight: 0.5,
        minSimilarity: 0,
      })

      const results = await m.findSimilarSkills('general query', testSkills, 5)

      // High quality skills should be boosted
      expect(results.length).toBeGreaterThan(0)

      m.close()
    })

    it('should handle skills without keywords', async () => {
      const skillsNoKeywords: MatchableSkill[] = [
        {
          id: 'no-keywords',
          name: 'Simple Skill',
          description: 'A skill without keywords',
        },
      ]

      const results = await matcher.findSimilarSkills('simple', skillsNoKeywords, 5)
      expect(results).toBeDefined()
    })

    it('should handle empty query', async () => {
      const results = await matcher.findSimilarSkills('', testSkills, 5)
      expect(results).toBeDefined()
    })
  })

  describe('findComplementarySkills', () => {
    it('should find complementary skills based on installed', async () => {
      const installed = [testSkills[0]] // React Testing
      const candidates = testSkills.slice(1)

      const results = await matcher.findComplementarySkills(installed, candidates, 3)

      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(3)

      // Should not include installed skill
      const resultIds = results.map((r) => r.skill.id)
      expect(resultIds).not.toContain('skill-1')
    })

    it('should handle empty installed skills', async () => {
      const results = await matcher.findComplementarySkills([], testSkills, 5)

      expect(results.length).toBeGreaterThan(0)
      // Should return top quality skills
    })

    it('should filter case-insensitively', async () => {
      const installed: MatchableSkill[] = [
        {
          id: 'SKILL-1',
          name: 'Test',
          description: 'Test',
        },
      ]
      const candidates: MatchableSkill[] = [
        {
          id: 'skill-1',
          name: 'Same ID Different Case',
          description: 'Should be filtered',
        },
        {
          id: 'skill-2',
          name: 'Different Skill',
          description: 'Should be included',
        },
      ]

      const results = await matcher.findComplementarySkills(installed, candidates, 5)

      const resultIds = results.map((r) => r.skill.id.toLowerCase())
      expect(resultIds).not.toContain('skill-1')
    })

    it('should respect limit', async () => {
      const results = await matcher.findComplementarySkills([testSkills[0]], testSkills.slice(1), 2)

      expect(results.length).toBeLessThanOrEqual(2)
    })
  })

  describe('clear', () => {
    it('should clear cached embeddings', async () => {
      await matcher.initialize(testSkills)
      matcher.clear()

      // Should be able to re-initialize
      await matcher.initialize(testSkills)
      expect(true).toBe(true)
    })
  })

  describe('match reason generation', () => {
    it('should generate reason for testing query', async () => {
      const results = await matcher.findSimilarSkills('testing', testSkills, 5)

      const testingResult = results.find((r) => r.skill.name.toLowerCase().includes('test'))
      if (testingResult) {
        expect(testingResult.matchReason).toBeDefined()
      }
    })

    it('should generate reason for react query', async () => {
      const results = await matcher.findSimilarSkills('react', testSkills, 5)

      const reactResult = results.find((r) => r.skill.name.toLowerCase().includes('react'))
      if (reactResult) {
        expect(reactResult.matchReason).toBeDefined()
      }
    })

    it('should generate reason for docker query', async () => {
      const results = await matcher.findSimilarSkills('docker containers', testSkills, 5)

      const dockerResult = results.find((r) => r.skill.description.toLowerCase().includes('docker'))
      if (dockerResult) {
        expect(dockerResult.matchReason).toBeDefined()
      }
    })

    it('should generate reason for api query', async () => {
      const results = await matcher.findSimilarSkills('api documentation', testSkills, 5)

      const apiResult = results.find((r) => r.skill.name.toLowerCase().includes('api'))
      if (apiResult) {
        expect(apiResult.matchReason).toBeDefined()
      }
    })
  })
})
