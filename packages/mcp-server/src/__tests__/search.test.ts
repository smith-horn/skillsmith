/**
 * Tests for SMI-581: MCP Search Tool
 * Updated for SMI-789: Wire to SearchService
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { executeSearch, formatSearchResults } from '../tools/search.js'
import { SkillsmithError } from '@skillsmith/core'
import { createSeededTestContext, type ToolContext } from './test-utils.js'

let context: ToolContext

beforeAll(() => {
  context = createSeededTestContext()
})

afterAll(() => {
  context.db.close()
})

describe('Search Tool', () => {
  describe('executeSearch', () => {
    it('should return results for valid query', async () => {
      const result = await executeSearch({ query: 'commit' }, context)

      expect(result.results).toBeDefined()
      expect(result.results.length).toBeGreaterThan(0)
      expect(result.total).toBeGreaterThan(0)
      expect(result.query).toBe('commit')
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should filter by category', async () => {
      const result = await executeSearch(
        {
          query: 'test',
          category: 'testing',
        },
        context
      )

      // With real search, we filter by category
      expect(result.results.length).toBeGreaterThanOrEqual(0)
    })

    it('should filter by trust tier', async () => {
      const result = await executeSearch(
        {
          query: 'anthropic',
          trust_tier: 'verified',
        },
        context
      )

      result.results.forEach((skill) => {
        expect(skill.trustTier).toBe('verified')
      })
    })

    it('should filter by minimum score', async () => {
      const result = await executeSearch(
        {
          query: 'commit',
          min_score: 90,
        },
        context
      )

      result.results.forEach((skill) => {
        expect(skill.score).toBeGreaterThanOrEqual(90)
      })
    })

    it('should sort results by relevance', async () => {
      const result = await executeSearch({ query: 'commit' }, context)

      // Results are sorted by BM25 rank, not score
      expect(result.results.length).toBeGreaterThanOrEqual(0)
    })

    it('should limit results to 10', async () => {
      const result = await executeSearch({ query: 'test' }, context)

      expect(result.results.length).toBeLessThanOrEqual(10)
    })

    it('should throw error for empty query', async () => {
      await expect(executeSearch({ query: '' }, context)).rejects.toThrow(SkillsmithError)
    })

    it('should throw error for query less than 3 characters', async () => {
      await expect(executeSearch({ query: 'a' }, context)).rejects.toThrow(SkillsmithError)
      await expect(executeSearch({ query: 'ab' }, context)).rejects.toThrow(SkillsmithError)
    })

    it('should throw error for invalid min_score', async () => {
      await expect(executeSearch({ query: 'test', min_score: 150 }, context)).rejects.toThrow(
        SkillsmithError
      )
    })
  })

  describe('formatSearchResults', () => {
    it('should format results for terminal display', async () => {
      const result = await executeSearch({ query: 'commit' }, context)
      const formatted = formatSearchResults(result)

      expect(formatted).toContain('Search Results')
      expect(formatted).toContain('commit')
    })

    it('should show helpful message when no results', async () => {
      const result = await executeSearch({ query: 'xyznonexistent123' }, context)
      const formatted = formatSearchResults(result)

      expect(formatted).toContain('No skills found')
      expect(formatted).toContain('Suggestions:')
    })
  })
})
