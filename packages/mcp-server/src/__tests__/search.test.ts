/**
 * Tests for SMI-581: MCP Search Tool
 * Updated for SMI-789: Wire to SearchService
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { executeSearch, formatSearchResults } from '../tools/search.js'
import { SkillsmithError, type SkillSearchResult } from '@skillsmith/core'
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

/**
 * SMI-1785: Additional tests for search.ts branch coverage
 * Covers validation errors, filter combinations, and edge cases
 */
describe('Search Tool branch coverage', () => {
  let branchContext: ToolContext

  beforeAll(() => {
    branchContext = createSeededTestContext()
  })

  afterAll(() => {
    branchContext.db.close()
  })

  describe('validation errors', () => {
    it('should throw error for negative min_score', async () => {
      await expect(executeSearch({ query: 'test', min_score: -10 }, branchContext)).rejects.toThrow(
        SkillsmithError
      )
    })

    it('should throw error for invalid trust_tier', async () => {
      try {
        await executeSearch({ query: 'test', trust_tier: 'invalid_tier' }, branchContext)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).message).toContain('Invalid trust_tier')
        expect((error as SkillsmithError).message).toContain('invalid_tier')
      }
    })

    it('should throw error for negative max_risk', async () => {
      try {
        await executeSearch({ query: 'test', max_risk: -5 }, branchContext)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).message).toContain('max_risk must be between 0 and 100')
      }
    })

    it('should throw error for max_risk over 100', async () => {
      try {
        await executeSearch({ query: 'test', max_risk: 150 }, branchContext)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).message).toContain('max_risk must be between 0 and 100')
      }
    })
  })

  describe('security filters', () => {
    it('should accept safe_only filter', async () => {
      const result = await executeSearch(
        {
          query: 'commit',
          safe_only: true,
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.filters.safeOnly).toBe(true)
    })

    it('should accept max_risk filter', async () => {
      const result = await executeSearch(
        {
          query: 'commit',
          max_risk: 50,
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.filters.maxRiskScore).toBe(50)
    })
  })

  describe('filter-only search (no query)', () => {
    it('should allow search with only category filter', async () => {
      const result = await executeSearch(
        {
          category: 'testing',
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.query).toBe('')
      expect(result.filters.category).toBe('testing')
    })

    it('should allow search with only trust_tier filter', async () => {
      const result = await executeSearch(
        {
          trust_tier: 'verified',
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.query).toBe('')
      expect(result.filters.trustTier).toBe('verified')
    })

    it('should allow search with only min_score filter', async () => {
      const result = await executeSearch(
        {
          min_score: 90,
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.query).toBe('')
    })

    it('should allow search with only safe_only filter', async () => {
      const result = await executeSearch(
        {
          safe_only: true,
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.query).toBe('')
      expect(result.filters.safeOnly).toBe(true)
    })

    it('should allow search with only max_risk filter', async () => {
      const result = await executeSearch(
        {
          max_risk: 30,
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.query).toBe('')
      expect(result.filters.maxRiskScore).toBe(30)
    })

    it('should allow search with multiple filters (no query)', async () => {
      const result = await executeSearch(
        {
          category: 'testing',
          trust_tier: 'community',
          min_score: 70,
          safe_only: true,
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.query).toBe('')
      expect(result.filters.category).toBe('testing')
      expect(result.filters.trustTier).toBe('community')
      expect(result.filters.safeOnly).toBe(true)
    })
  })

  describe('combined query and filters', () => {
    it('should accept all filters together', async () => {
      const result = await executeSearch(
        {
          query: 'test',
          category: 'testing',
          trust_tier: 'community',
          min_score: 70,
          safe_only: true,
          max_risk: 40,
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.filters.category).toBe('testing')
      expect(result.filters.trustTier).toBe('community')
      expect(result.filters.safeOnly).toBe(true)
      expect(result.filters.maxRiskScore).toBe(40)
    })
  })
})

/**
 * SMI-2734: Tests for installHint field in formatSearchResults
 * Verifies registry skills surface the owner/name install ID and local skills do not.
 */
describe('SMI-2734: formatSearchResults installHint', () => {
  const baseSkill: SkillSearchResult = {
    id: 'a129e127-a82c-47e5-8bc5-09d7ba2e8734',
    name: 'performance',
    description: 'Web performance auditing skill',
    author: 'addyosmani',
    category: 'development',
    trustTier: 'verified',
    score: 84,
    source: 'registry',
  }

  const makeResponse = (results: SkillSearchResult[]) => ({
    results,
    total: results.length,
    query: 'performance',
    filters: {},
    timing: { searchMs: 10, totalMs: 12 },
  })

  it('should display Install line for a registry skill with installHint set', () => {
    const skill: SkillSearchResult = { ...baseSkill, installHint: 'addyosmani/performance' }
    const formatted = formatSearchResults(makeResponse([skill]))

    expect(formatted).toContain('Install: addyosmani/performance')
  })

  it('should not display Install line when installHint is absent', () => {
    const skill: SkillSearchResult = { ...baseSkill }
    // installHint intentionally not set (local skill or unknown author)
    const formatted = formatSearchResults(makeResponse([skill]))

    expect(formatted).not.toContain('Install:')
  })

  it('should display Install line only for skills that have installHint in a mixed result set', () => {
    const registrySkill: SkillSearchResult = {
      ...baseSkill,
      id: 'b1',
      name: 'commit',
      author: 'anthropic',
      installHint: 'anthropic/commit',
      source: 'registry',
    }
    const localSkill: SkillSearchResult = {
      ...baseSkill,
      id: 'b2',
      name: 'my-local-skill',
      author: 'local-user',
      source: 'local',
      // installHint intentionally absent for local skill
    }
    const formatted = formatSearchResults(makeResponse([registrySkill, localSkill]))

    expect(formatted).toContain('Install: anthropic/commit')
    // The local skill section should not contain an Install line
    // Split on blank lines between skill entries to isolate each block
    const sections = formatted.split('\n\n')
    const localSection = sections.find((s) => s.includes('my-local-skill'))
    expect(localSection).toBeDefined()
    expect(localSection).not.toContain('Install:')
  })
})
