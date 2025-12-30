/**
 * SMI-756: Integration tests for compare MCP tool
 * Tests skill comparison with real database
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, type TestDatabaseContext } from './setup.js'
import { executeCompare, formatComparisonResults } from '../../src/tools/compare.js'

describe('Compare Tool Integration', () => {
  let ctx: TestDatabaseContext

  beforeEach(async () => {
    ctx = await createTestDatabase()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  describe('executeCompare', () => {
    it('should compare two existing skills', async () => {
      // Note: These skills are seeded in createTestDatabase
      const result = await executeCompare(
        {
          skill_a: 'anthropic/commit',
          skill_b: 'anthropic/review-pr',
        },
        ctx
      )

      expect(result.comparison.a).toBeDefined()
      expect(result.comparison.b).toBeDefined()
      expect(result.comparison.a.id).toBe('anthropic/commit')
      expect(result.comparison.b.id).toBe('anthropic/review-pr')
    })

    it('should include quality scores in comparison', async () => {
      const result = await executeCompare(
        {
          skill_a: 'anthropic/commit',
          skill_b: 'community/jest-helper',
        },
        ctx
      )

      expect(result.comparison.a.quality_score).toBeDefined()
      expect(result.comparison.b.quality_score).toBeDefined()
      expect(result.comparison.a.quality_score).toBeGreaterThanOrEqual(0)
      expect(result.comparison.b.quality_score).toBeGreaterThanOrEqual(0)
    })

    it('should include trust tiers in comparison', async () => {
      const result = await executeCompare(
        {
          skill_a: 'anthropic/commit',
          skill_b: 'community/docker-compose',
        },
        ctx
      )

      expect(result.comparison.a.trust_tier).toBe('verified')
      expect(result.comparison.b.trust_tier).toBe('community')
    })

    it('should list differences between skills', async () => {
      const result = await executeCompare(
        {
          skill_a: 'anthropic/commit',
          skill_b: 'community/jest-helper',
        },
        ctx
      )

      expect(result.differences).toBeDefined()
      expect(Array.isArray(result.differences)).toBe(true)

      // Should have at least some differences
      for (const diff of result.differences) {
        expect(diff.field).toBeDefined()
        expect(diff.a_value).toBeDefined()
        expect(diff.b_value).toBeDefined()
      }
    })

    it('should provide a recommendation', async () => {
      const result = await executeCompare(
        {
          skill_a: 'anthropic/commit',
          skill_b: 'community/vitest-helper',
        },
        ctx
      )

      expect(result.recommendation).toBeDefined()
      expect(typeof result.recommendation).toBe('string')
      expect(result.recommendation.length).toBeGreaterThan(0)
    })

    it('should include tags in summaries', async () => {
      const result = await executeCompare(
        {
          skill_a: 'anthropic/commit',
          skill_b: 'anthropic/review-pr',
        },
        ctx
      )

      expect(result.comparison.a.tags).toBeDefined()
      expect(result.comparison.b.tags).toBeDefined()
      expect(Array.isArray(result.comparison.a.tags)).toBe(true)
      expect(Array.isArray(result.comparison.b.tags)).toBe(true)
    })

    it('should track timing information', async () => {
      const result = await executeCompare(
        {
          skill_a: 'anthropic/commit',
          skill_b: 'anthropic/review-pr',
        },
        ctx
      )

      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should throw for non-existent skill', async () => {
      await expect(
        executeCompare(
          {
            skill_a: 'non-existent/skill',
            skill_b: 'anthropic/commit',
          },
          ctx
        )
      ).rejects.toThrow()
    })

    it('should throw when both skills are the same', async () => {
      await expect(
        executeCompare(
          {
            skill_a: 'anthropic/commit',
            skill_b: 'anthropic/commit',
          },
          ctx
        )
      ).rejects.toThrow()
    })
  })

  describe('formatComparisonResults', () => {
    it('should format comparison for terminal display', async () => {
      const result = await executeCompare(
        {
          skill_a: 'anthropic/commit',
          skill_b: 'anthropic/review-pr',
        },
        ctx
      )

      const formatted = formatComparisonResults(result)

      expect(formatted).toContain('Skill Comparison')
      expect(formatted).toContain('commit')
      expect(formatted).toContain('review-pr')
    })

    it('should display recommendation', async () => {
      const result = await executeCompare(
        {
          skill_a: 'anthropic/commit',
          skill_b: 'community/docker-compose',
        },
        ctx
      )

      const formatted = formatComparisonResults(result)

      expect(formatted).toContain('Recommendation')
    })
  })
})
