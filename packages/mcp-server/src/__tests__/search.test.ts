/**
 * Tests for SMI-581: MCP Search Tool
 * Updated for SMI-789: Wire to SearchService
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import { executeSearch, formatSearchResults } from '../tools/search.js'
import { SkillsmithError } from '@skillsmith/core'
import * as CoreModule from '@skillsmith/core'
import {
  createSeededTestContext,
  createTestContext,
  disposeTestContext,
  type ToolContext,
} from './test-utils.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'

let context: ToolContext

beforeAll(async () => {
  context = await createSeededTestContext()
})

afterAll(async () => {
  await disposeTestContext(context)
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

      // Seeded DB has testing-category skills; filter must return results
      expect(result.results.length).toBeGreaterThan(0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(result.results.every((r: any) => r.category === 'testing')).toBe(true)
    })

    it('should filter by trust tier', async () => {
      const result = await executeSearch(
        {
          query: 'anthropic',
          trust_tier: 'verified',
        },
        context
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.results.forEach((skill: any) => {
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.results.forEach((skill: any) => {
        expect(skill.score).toBeGreaterThanOrEqual(90)
      })
    })

    it('should sort results by relevance', async () => {
      const result = await executeSearch({ query: 'commit' }, context)

      // Results are sorted by BM25 rank, not score
      expect(result.results.length).toBeGreaterThan(0)
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

    // SMI-5556: empty-result guidance so a calling agent doesn't misread a
    // multi-concept-query miss as a registry/backend fault.
    it('should include a suggestion when zero results are returned', async () => {
      const result = await executeSearch({ query: 'xyznonexistent123' }, context)

      expect(result.results.length).toBe(0)
      expect(result.suggestion).toBeDefined()
      expect(result.suggestion).toContain('single-topic query')
    })

    it('should NOT include a suggestion when results are non-empty', async () => {
      const result = await executeSearch({ query: 'commit' }, context)

      expect(result.results.length).toBeGreaterThan(0)
      expect(result.suggestion).toBeUndefined()
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
      // SMI-5556: formatter now surfaces response.suggestion instead of the
      // old static "Suggestions:" bullet list.
      expect(formatted).toContain('single-topic query')
    })

    // SMI-5556: formatter prefers response.suggestion over re-deriving guidance.
    it('should surface response.suggestion when present instead of the hardcoded list', () => {
      const emptyResult = {
        results: [],
        total: 0,
        query: 'test',
        filters: {},
        suggestion: 'Custom empty-result guidance from the tool.',
        timing: { searchMs: 1, totalMs: 2 },
      }
      const formatted = formatSearchResults(emptyResult)

      expect(formatted).toContain('Custom empty-result guidance from the tool.')
      expect(formatted).not.toContain('Suggestions:')
    })
  })

  describe('offline/fallback path tracking', () => {
    let offlineContext: ToolContext

    beforeAll(async () => {
      offlineContext = await createTestContext()
    })

    afterAll(async () => {
      await disposeTestContext(offlineContext)
    })

    beforeEach(() => {
      vi.spyOn(LocalSkillSearchModule, 'searchLocalSkills').mockResolvedValue([])
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('calls trackSkillSearch when context.distinctId is set in offline/fallback path', async () => {
      const trackSpy = vi.spyOn(CoreModule, 'trackSkillSearch').mockImplementation(() => {})

      // Offline path: isOffline() returns true (default for createTestContext), goes to local DB
      const contextWithId: ToolContext = { ...offlineContext, distinctId: 'offline-track-user' }

      await executeSearch({ query: 'commit' }, contextWithId)

      expect(trackSpy).toHaveBeenCalledWith(
        'offline-track-user',
        'commit',
        expect.any(Number),
        expect.any(Number),
        expect.any(Object)
      )
    })

    // SMI-5193: emitSearchEvent must use snake_case keys — sanitizeMetadata silently drops camelCase.
    // Uses contextWithId because the emit is guarded by context.distinctId (matches trackSkillSearch).
    it('calls emitSearchEvent with snake_case keys (results_count, duration_ms, has_query)', async () => {
      const emitSpy = vi.spyOn(CoreModule, 'emitSearchEvent').mockImplementation(() => {})
      const contextWithId: ToolContext = { ...offlineContext, distinctId: 'smi-5193-test-user' }
      await executeSearch({ query: 'commit' }, contextWithId)
      expect(emitSpy).toHaveBeenCalledTimes(1)
      const payload = emitSpy.mock.calls[0]![0] as unknown as Record<string, unknown>
      expect(payload).toMatchObject({ query: 'commit', has_query: true })
      expect(payload.results_count).toEqual(expect.any(Number))
      expect(payload.duration_ms).toEqual(expect.any(Number))
      expect(payload).not.toHaveProperty('resultCount')
      expect(payload).not.toHaveProperty('durationMs')
      expect(payload).not.toHaveProperty('hasQuery')
    })
  })
})

/**
 * SMI-1785: Additional tests for search.ts branch coverage
 * Covers validation errors, filter combinations, and edge cases
 */
describe('Search Tool branch coverage', () => {
  let branchContext: ToolContext

  beforeAll(async () => {
    branchContext = await createSeededTestContext()
  })

  afterAll(async () => {
    await disposeTestContext(branchContext)
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

    it('should allow search with curated trust_tier filter (SMI-4520)', async () => {
      // Pre-fix this threw VALIDATION_INVALID_TYPE; post-fix curated must pass through.
      const result = await executeSearch(
        {
          trust_tier: 'curated',
        },
        branchContext
      )

      expect(result.results).toBeDefined()
      expect(result.filters.trustTier).toBe('curated')
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

// SMI-2734/SMI-2759: formatSearchResults installHint + repository field tests
// moved to search.formatter.test.ts (SMI-5556) to keep this file under the
// 500-line gate after adding empty-result suggestion coverage.
//
// SMI-2760: compatible_with filter tests extracted to
// search-compatible-with.test.ts during SMI-4694 to keep this file under
// the 500-line gate after disposeTestContext wiring.
