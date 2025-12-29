/**
 * Tests for SMI-743: MCP Skill Compare Tool
 */

import { describe, it, expect } from 'vitest'
import {
  executeCompare,
  formatComparisonResults,
  compareInputSchema,
} from '../src/tools/compare.js'
import { SkillsmithError, ErrorCodes } from '@skillsmith/core'

describe('Skill Compare Tool', () => {
  describe('compareInputSchema', () => {
    it('should require both skill_a and skill_b', () => {
      expect(() => compareInputSchema.parse({})).toThrow()
      expect(() => compareInputSchema.parse({ skill_a: 'a/b' })).toThrow()
      expect(() => compareInputSchema.parse({ skill_b: 'a/b' })).toThrow()
    })

    it('should accept valid skill IDs', () => {
      const result = compareInputSchema.parse({
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      })
      expect(result.skill_a).toBe('community/jest-helper')
      expect(result.skill_b).toBe('community/vitest-helper')
    })

    it('should reject empty skill IDs', () => {
      expect(() =>
        compareInputSchema.parse({
          skill_a: '',
          skill_b: 'community/vitest-helper',
        })
      ).toThrow()
    })
  })

  describe('executeCompare', () => {
    it('should compare two valid skills', async () => {
      const result = await executeCompare({
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      })

      expect(result.comparison).toBeDefined()
      expect(result.comparison.a).toBeDefined()
      expect(result.comparison.b).toBeDefined()
      expect(result.comparison.a.id).toBe('community/jest-helper')
      expect(result.comparison.b.id).toBe('community/vitest-helper')
      expect(result.differences).toBeDefined()
      expect(result.differences.length).toBeGreaterThan(0)
      expect(result.recommendation).toBeDefined()
      expect(result.recommendation.length).toBeGreaterThan(0)
      expect(['a', 'b', 'tie']).toContain(result.winner)
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should return skill summaries with all fields', async () => {
      const result = await executeCompare({
        skill_a: 'anthropic/commit',
        skill_b: 'anthropic/review-pr',
      })

      // Check skill A summary
      expect(result.comparison.a.id).toBe('anthropic/commit')
      expect(result.comparison.a.name).toBe('commit')
      expect(result.comparison.a.description).toBeDefined()
      expect(result.comparison.a.author).toBe('anthropic')
      expect(result.comparison.a.quality_score).toBeGreaterThanOrEqual(0)
      expect(result.comparison.a.trust_tier).toBeDefined()
      expect(result.comparison.a.category).toBeDefined()
      expect(result.comparison.a.tags).toBeInstanceOf(Array)

      // Check skill B summary
      expect(result.comparison.b.id).toBe('anthropic/review-pr')
      expect(result.comparison.b.name).toBe('review-pr')
    })

    it('should include quality score comparison in differences', async () => {
      const result = await executeCompare({
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      })

      const qualityDiff = result.differences.find((d) => d.field === 'quality_score')
      expect(qualityDiff).toBeDefined()
      expect(qualityDiff?.a_value).toBeDefined()
      expect(qualityDiff?.b_value).toBeDefined()
      expect(['a', 'b', 'tie']).toContain(qualityDiff?.winner)
    })

    it('should include trust tier comparison', async () => {
      const result = await executeCompare({
        skill_a: 'anthropic/commit',
        skill_b: 'community/jest-helper',
      })

      const trustDiff = result.differences.find((d) => d.field === 'trust_tier')
      expect(trustDiff).toBeDefined()
      expect(trustDiff?.a_value).toBe('verified')
      expect(trustDiff?.b_value).toBe('community')
      expect(trustDiff?.winner).toBe('a') // verified > community
    })

    it('should include dependencies count comparison', async () => {
      const result = await executeCompare({
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      })

      const depsDiff = result.differences.find((d) => d.field === 'dependencies_count')
      expect(depsDiff).toBeDefined()
      expect(typeof depsDiff?.a_value).toBe('number')
      expect(typeof depsDiff?.b_value).toBe('number')
    })

    it('should include score breakdown comparisons when available', async () => {
      const result = await executeCompare({
        skill_a: 'anthropic/commit',
        skill_b: 'anthropic/review-pr',
      })

      const scoreFields = [
        'score_quality',
        'score_popularity',
        'score_maintenance',
        'score_security',
        'score_documentation',
      ]
      for (const field of scoreFields) {
        const diff = result.differences.find((d) => d.field === field)
        expect(diff).toBeDefined()
      }
    })

    it('should throw SKILL_INVALID_ID for malformed skill_a', async () => {
      try {
        await executeCompare({
          skill_a: 'invalid-format',
          skill_b: 'community/jest-helper',
        })
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_INVALID_ID)
      }
    })

    it('should throw SKILL_INVALID_ID for malformed skill_b', async () => {
      try {
        await executeCompare({
          skill_a: 'community/jest-helper',
          skill_b: 'invalid-format',
        })
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_INVALID_ID)
      }
    })

    it('should throw SKILL_NOT_FOUND for non-existent skill_a', async () => {
      try {
        await executeCompare({
          skill_a: 'nonexistent/skill',
          skill_b: 'community/jest-helper',
        })
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_NOT_FOUND)
      }
    })

    it('should throw SKILL_NOT_FOUND for non-existent skill_b', async () => {
      try {
        await executeCompare({
          skill_a: 'community/jest-helper',
          skill_b: 'nonexistent/skill',
        })
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_NOT_FOUND)
      }
    })

    it('should throw error when comparing skill with itself', async () => {
      try {
        await executeCompare({
          skill_a: 'community/jest-helper',
          skill_b: 'community/jest-helper',
        })
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.VALIDATION_INVALID_TYPE)
      }
    })

    it('should handle case-insensitive skill IDs', async () => {
      const result = await executeCompare({
        skill_a: 'COMMUNITY/JEST-HELPER',
        skill_b: 'community/vitest-helper',
      })

      expect(result.comparison.a.id).toBe('community/jest-helper')
    })

    it('should generate meaningful recommendation', async () => {
      const result = await executeCompare({
        skill_a: 'anthropic/commit',
        skill_b: 'community/jest-helper',
      })

      expect(result.recommendation.length).toBeGreaterThan(20)
      // Recommendation should mention at least one skill name
      expect(
        result.recommendation.includes('commit') || result.recommendation.includes('jest-helper')
      ).toBe(true)
    })

    it('should determine winner based on comparison metrics', async () => {
      // Comparing verified vs community skill - verified should have advantage
      const result = await executeCompare({
        skill_a: 'anthropic/commit',
        skill_b: 'community/docker-compose',
      })

      expect(['a', 'b', 'tie']).toContain(result.winner)
    })
  })

  describe('formatComparisonResults', () => {
    it('should format comparison as side-by-side table', async () => {
      const result = await executeCompare({
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      })
      const formatted = formatComparisonResults(result)

      expect(formatted).toContain('Skill Comparison')
      expect(formatted).toContain('jest-helper')
      expect(formatted).toContain('vitest-helper')
      expect(formatted).toContain('Quality Score')
      expect(formatted).toContain('Trust Tier')
      expect(formatted).toContain('Category')
    })

    it('should show winner in formatted output', async () => {
      const result = await executeCompare({
        skill_a: 'anthropic/commit',
        skill_b: 'community/jest-helper',
      })
      const formatted = formatComparisonResults(result)

      expect(formatted).toContain('Winner:')
    })

    it('should show score breakdown bars when available', async () => {
      const result = await executeCompare({
        skill_a: 'anthropic/commit',
        skill_b: 'anthropic/review-pr',
      })
      const formatted = formatComparisonResults(result)

      expect(formatted).toContain('Score Breakdown')
      expect(formatted).toContain('Quality')
      expect(formatted).toContain('Popularity')
      expect(formatted).toContain('Maintenance')
      expect(formatted).toContain('Security')
      expect(formatted).toContain('Documentation')
      expect(formatted).toContain('[')
      expect(formatted).toContain(']')
    })

    it('should include recommendation text', async () => {
      const result = await executeCompare({
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      })
      const formatted = formatComparisonResults(result)

      expect(formatted).toContain('Recommendation:')
    })

    it('should include timing information', async () => {
      const result = await executeCompare({
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      })
      const formatted = formatComparisonResults(result)

      expect(formatted).toContain('Completed in')
      expect(formatted).toContain('ms')
    })
  })
})
