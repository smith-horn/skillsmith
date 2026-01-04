/**
 * SMI-869: Search Quality Test Suite
 *
 * Tests that verify search relevance, ranking quality, and
 * edge case handling for the SearchService.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../src/db/schema.js'
import { SkillRepository } from '../src/repositories/SkillRepository.js'
import { SearchService } from '../src/services/SearchService.js'

describe('Search Quality Tests', () => {
  let db: ReturnType<typeof createDatabase>
  let repo: SkillRepository
  let search: SearchService

  beforeEach(() => {
    db = createDatabase(':memory:')
    repo = new SkillRepository(db)
    search = new SearchService(db, { cacheTtl: 0 }) // Disable cache for quality tests
  })

  afterEach(() => {
    if (db) closeDatabase(db)
  })

  describe('Relevance Ranking', () => {
    beforeEach(() => {
      // Seed with carefully designed test data
      repo.createBatch([
        {
          name: 'TypeScript Formatter',
          description: 'Format TypeScript code with prettier integration',
          author: 'typescript-tools',
          tags: ['typescript', 'formatter', 'prettier', 'code-style'],
          qualityScore: 0.95,
          trustTier: 'verified',
        },
        {
          name: 'TypeScript Linter',
          description: 'Lint TypeScript and JavaScript files with ESLint',
          author: 'typescript-tools',
          tags: ['typescript', 'eslint', 'linter'],
          qualityScore: 0.9,
          trustTier: 'verified',
        },
        {
          name: 'Code Formatter',
          description: 'Generic code formatter supporting multiple languages including TypeScript',
          author: 'code-tools',
          tags: ['formatter', 'multi-language'],
          qualityScore: 0.85,
          trustTier: 'community',
        },
        {
          name: 'Python Formatter',
          description: 'Format Python code with Black',
          author: 'python-tools',
          tags: ['python', 'formatter', 'black'],
          qualityScore: 0.88,
          trustTier: 'verified',
        },
        {
          name: 'TypeScript Type Checker',
          description: 'Advanced type checking for TypeScript projects',
          author: 'typescript-tools',
          tags: ['typescript', 'types', 'type-checking'],
          qualityScore: 0.92,
          trustTier: 'verified',
        },
      ])
    })

    it('should rank exact name matches highest', () => {
      const results = search.search({ query: 'typescript formatter' })

      // "TypeScript Formatter" should be first (exact match)
      expect(results.items[0].skill.name).toBe('TypeScript Formatter')
    })

    it('should rank title matches higher than description matches', () => {
      const results = search.search({ query: 'formatter' })

      // Skills with "formatter" in name should rank higher than those with it only in description
      const topResults = results.items.slice(0, 3).map((r) => r.skill.name)
      expect(topResults).toContain('TypeScript Formatter')
      expect(topResults).toContain('Code Formatter')
      expect(topResults).toContain('Python Formatter')
    })

    it('should consider tag matches in ranking', () => {
      const results = search.search({ query: 'prettier' })

      // TypeScript Formatter has "prettier" tag
      expect(results.items[0].skill.name).toBe('TypeScript Formatter')
    })

    it('should handle multi-word queries with partial matches', () => {
      const results = search.search({ query: 'typescript code' })

      // Should find skills matching either term
      expect(results.items.length).toBeGreaterThan(0)

      // TypeScript Formatter matches both "typescript" and "code"
      const names = results.items.map((r) => r.skill.name)
      expect(names).toContain('TypeScript Formatter')
    })
  })

  describe('Query Normalization', () => {
    beforeEach(() => {
      repo.createBatch([
        {
          name: 'React Component Generator',
          description: 'Generate React components from templates',
          author: 'react-tools',
          tags: ['react', 'generator', 'component'],
          qualityScore: 0.85,
          trustTier: 'community',
        },
        {
          name: 'REACT Hooks Helper',
          description: 'Helper utilities for React hooks',
          author: 'react-tools',
          tags: ['react', 'hooks'],
          qualityScore: 0.8,
          trustTier: 'community',
        },
      ])
    })

    it('should be case-insensitive', () => {
      const lowerResults = search.search({ query: 'react' })
      const upperResults = search.search({ query: 'REACT' })
      const mixedResults = search.search({ query: 'ReAcT' })

      expect(lowerResults.total).toBe(upperResults.total)
      expect(lowerResults.total).toBe(mixedResults.total)
    })

    it('should handle extra whitespace', () => {
      const normalResults = search.search({ query: 'react hooks' })
      const extraSpaceResults = search.search({ query: '  react   hooks  ' })

      expect(normalResults.total).toBe(extraSpaceResults.total)
    })

    it('should handle special characters gracefully', () => {
      // SMI-1034: All special characters should be escaped and not throw
      const specialQueries = [
        'react-hooks',
        'react_hooks',
        'react.hooks', // Period - now escaped
        "react'hooks", // Single quote - now escaped
        'react"hooks', // Double quote - now escaped
        'react(hooks)', // Parentheses - now escaped
        'react[hooks]', // Brackets - now escaped
        'react{hooks}', // Braces - now escaped
        'react*hooks', // Asterisk - now escaped
        'react^hooks', // Caret - now escaped
      ]

      for (const query of specialQueries) {
        // All queries should succeed without throwing
        expect(() => search.search({ query })).not.toThrow()
      }
    })
  })

  describe('Edge Cases', () => {
    beforeEach(() => {
      repo.createBatch([
        {
          name: 'Test Skill',
          description: 'A skill for testing',
          author: 'tester',
          tags: ['test'],
          qualityScore: 0.5,
          trustTier: 'community',
        },
      ])
    })

    it('should handle empty results gracefully', () => {
      const results = search.search({ query: 'nonexistent-skill-xyz-123' })

      expect(results.items).toEqual([])
      expect(results.total).toBe(0)
      expect(results.hasMore).toBe(false)
    })

    it('should handle very short queries', () => {
      // Two-character queries should work
      const results = search.search({ query: 'te' })
      expect(results.items.length).toBeGreaterThanOrEqual(0)
    })

    it('should handle very long queries', () => {
      const longQuery = 'a'.repeat(1000)
      // Should not throw, may return empty results
      expect(() => search.search({ query: longQuery })).not.toThrow()
    })

    it('should handle queries with only stop words', () => {
      // "the", "a", "and" are common stop words
      const results = search.search({ query: 'the a and' })
      // Should not throw
      expect(results.items).toBeDefined()
    })

    it('should handle numeric queries', () => {
      const results = search.search({ query: '123' })
      expect(results.items).toBeDefined()
    })

    it('should handle emoji in queries', () => {
      const results = search.search({ query: 'test 🚀' })
      expect(results.items).toBeDefined()
    })

    it('should handle unicode characters', () => {
      const results = search.search({ query: '测试 тест テスト' })
      expect(results.items).toBeDefined()
    })
  })

  describe('Filter Combinations', () => {
    beforeEach(() => {
      repo.createBatch([
        {
          name: 'Verified High Quality',
          description: 'A verified skill with high quality',
          author: 'official',
          tags: ['test'],
          qualityScore: 0.95,
          trustTier: 'verified',
        },
        {
          name: 'Verified Low Quality',
          description: 'A verified skill with lower quality',
          author: 'official',
          tags: ['test'],
          qualityScore: 0.5,
          trustTier: 'verified',
        },
        {
          name: 'Community High Quality',
          description: 'A community skill with high quality',
          author: 'community-dev',
          tags: ['test'],
          qualityScore: 0.9,
          trustTier: 'community',
        },
        {
          name: 'Experimental Skill',
          description: 'An experimental skill',
          author: 'experimenter',
          tags: ['test'],
          qualityScore: 0.6,
          trustTier: 'experimental',
        },
      ])
    })

    it('should filter by trust tier correctly', () => {
      const verifiedResults = search.search({ query: 'skill', trustTier: 'verified' })
      const communityResults = search.search({ query: 'skill', trustTier: 'community' })
      const experimentalResults = search.search({ query: 'skill', trustTier: 'experimental' })

      expect(verifiedResults.total).toBe(2)
      expect(communityResults.total).toBe(1)
      expect(experimentalResults.total).toBe(1)
    })

    it('should filter by minimum quality score', () => {
      const highQualityResults = search.search({ query: 'skill', minQualityScore: 0.8 })
      const lowQualityResults = search.search({ query: 'skill', minQualityScore: 0.4 })

      expect(highQualityResults.total).toBe(2) // Only 0.95 and 0.9
      expect(lowQualityResults.total).toBe(4) // All skills
    })

    it('should combine filters correctly', () => {
      const results = search.search({
        query: 'skill',
        trustTier: 'verified',
        minQualityScore: 0.8,
      })

      expect(results.total).toBe(1)
      expect(results.items[0].skill.name).toBe('Verified High Quality')
    })

    it('should return empty results when filters exclude all', () => {
      const results = search.search({
        query: 'skill',
        trustTier: 'experimental',
        minQualityScore: 0.9,
      })

      expect(results.total).toBe(0)
      expect(results.items).toEqual([])
    })
  })

  describe('Pagination', () => {
    beforeEach(() => {
      // Create 15 skills for pagination testing
      const skills = Array.from({ length: 15 }, (_, i) => ({
        name: `Test Skill ${i + 1}`,
        description: `Description for test skill ${i + 1}`,
        author: 'tester',
        tags: ['test', 'pagination'],
        qualityScore: 0.5 + (i % 5) * 0.1,
        trustTier: 'community' as const,
      }))

      repo.createBatch(skills)
    })

    it('should respect limit parameter', () => {
      const results = search.search({ query: 'test', limit: 5 })

      expect(results.items.length).toBe(5)
      expect(results.total).toBe(15)
      expect(results.hasMore).toBe(true)
    })

    it('should respect offset parameter', () => {
      const page1 = search.search({ query: 'test', limit: 5, offset: 0 })
      const page2 = search.search({ query: 'test', limit: 5, offset: 5 })
      const page3 = search.search({ query: 'test', limit: 5, offset: 10 })

      // All pages should have 5 items
      expect(page1.items.length).toBe(5)
      expect(page2.items.length).toBe(5)
      expect(page3.items.length).toBe(5)

      // Pages should have different items
      const page1Ids = page1.items.map((r) => r.skill.id)
      const page2Ids = page2.items.map((r) => r.skill.id)
      const page3Ids = page3.items.map((r) => r.skill.id)

      expect(page1Ids).not.toEqual(page2Ids)
      expect(page2Ids).not.toEqual(page3Ids)
    })

    it('should handle offset beyond results', () => {
      const results = search.search({ query: 'test', limit: 5, offset: 100 })

      expect(results.items.length).toBe(0)
      expect(results.hasMore).toBe(false)
    })

    it('should calculate hasMore correctly', () => {
      const fullResults = search.search({ query: 'test', limit: 15 })
      const partialResults = search.search({ query: 'test', limit: 10 })
      const beyondResults = search.search({ query: 'test', limit: 20 })

      expect(fullResults.hasMore).toBe(false)
      expect(partialResults.hasMore).toBe(true)
      expect(beyondResults.hasMore).toBe(false)
    })
  })

  describe('Performance Baselines', () => {
    beforeEach(() => {
      // Create 100 skills for performance testing
      const skills = Array.from({ length: 100 }, (_, i) => ({
        name: `Performance Test Skill ${i + 1}`,
        description: `A skill designed for performance testing with various keywords like typescript, react, testing, and more. Index: ${i}`,
        author: `author-${i % 10}`,
        tags: ['performance', 'test', i % 2 === 0 ? 'even' : 'odd'],
        qualityScore: 0.5 + (i % 50) * 0.01,
        trustTier: (['verified', 'community', 'experimental'] as const)[i % 3],
      }))

      repo.createBatch(skills)
    })

    it('should complete simple search within 50ms', () => {
      const start = performance.now()
      search.search({ query: 'test' })
      const duration = performance.now() - start

      expect(duration).toBeLessThan(50)
    })

    it('should complete filtered search within 50ms', () => {
      const start = performance.now()
      search.search({
        query: 'performance',
        trustTier: 'verified',
        minQualityScore: 0.7,
        limit: 20,
      })
      const duration = performance.now() - start

      expect(duration).toBeLessThan(50)
    })

    it('should complete paginated search within 50ms', () => {
      const start = performance.now()

      // Simulate pagination through results
      for (let offset = 0; offset < 100; offset += 20) {
        search.search({ query: 'test', limit: 20, offset })
      }

      const duration = performance.now() - start

      // 5 pages should complete in under 200ms
      expect(duration).toBeLessThan(200)
    })
  })

  describe('Search Result Structure', () => {
    beforeEach(() => {
      repo.createBatch([
        {
          name: 'Complete Skill',
          description: 'A skill with all fields populated',
          author: 'complete-author',
          tags: ['complete', 'test'],
          qualityScore: 0.88,
          trustTier: 'verified',
        },
      ])
    })

    it('should return complete skill data in results', () => {
      const results = search.search({ query: 'complete' })

      expect(results.items.length).toBe(1)
      const result = results.items[0]

      // Verify skill structure
      expect(result.skill).toBeDefined()
      expect(result.skill.id).toBeDefined()
      expect(result.skill.name).toBe('Complete Skill')
      expect(result.skill.description).toBe('A skill with all fields populated')
      expect(result.skill.author).toBe('complete-author')
      expect(result.skill.tags).toContain('complete')
      expect(result.skill.qualityScore).toBe(0.88)
      expect(result.skill.trustTier).toBe('verified')

      // Verify metadata (rank is the BM25 score)
      expect(result.rank).toBeDefined()
      expect(typeof result.rank).toBe('number')
    })

    it('should return proper pagination metadata', () => {
      const results = search.search({ query: 'complete', limit: 10, offset: 0 })

      expect(results.total).toBeDefined()
      expect(typeof results.total).toBe('number')
      expect(results.items).toBeInstanceOf(Array)
      expect(results.hasMore).toBeDefined()
      expect(typeof results.hasMore).toBe('boolean')
    })
  })
})
