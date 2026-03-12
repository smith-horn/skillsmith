import { describe, it, expect } from 'vitest'
import { VariantSelector } from '../../src/evaluation/VariantSelector.js'
import type { ScoredVariant, SkillVariant } from '../../src/evaluation/types.js'

function makeScoredVariant(
  overrides: Partial<ScoredVariant> & { accuracy: number; cost: number }
): ScoredVariant {
  const variant: SkillVariant = {
    id: `v-${Math.random().toString(36).slice(2, 8)}`,
    contentHash: `hash-${Math.random().toString(36).slice(2, 8)}`,
    content: '# Test Skill',
    parentId: null,
    skillId: 'test-skill',
    iteration: 1,
    generationMethod: 'augment',
    ...overrides.variant,
  }
  return {
    variant,
    accuracy: overrides.accuracy,
    cost: overrides.cost,
    skillSize: overrides.skillSize ?? 50,
  }
}

describe('VariantSelector', () => {
  const selector = new VariantSelector()

  describe('Pareto dominance', () => {
    it('keeps non-dominated variants', () => {
      const candidates = [
        makeScoredVariant({ accuracy: 0.9, cost: 100 }), // A: high acc, high cost
        makeScoredVariant({ accuracy: 0.7, cost: 50 }), // B: med acc, low cost
        makeScoredVariant({ accuracy: 0.6, cost: 200 }), // C: dominated by both A and B
      ]

      const result = selector.select(candidates, 10)
      expect(result).toHaveLength(2)

      const methods = result.map((r) => r.accuracy)
      expect(methods).toContain(0.9)
      expect(methods).toContain(0.7)
    })

    it('removes strictly dominated variants', () => {
      const candidates = [
        makeScoredVariant({ accuracy: 0.8, cost: 100 }),
        makeScoredVariant({ accuracy: 0.7, cost: 150 }), // dominated: worse acc AND worse cost
      ]

      const result = selector.select(candidates, 10)
      expect(result).toHaveLength(1)
      expect(result[0].accuracy).toBe(0.8)
    })

    it('keeps both when neither dominates', () => {
      const candidates = [
        makeScoredVariant({ accuracy: 0.9, cost: 200 }),
        makeScoredVariant({ accuracy: 0.7, cost: 50 }),
      ]

      const result = selector.select(candidates, 10)
      expect(result).toHaveLength(2)
    })

    it('keeps equal variants (neither dominates the other)', () => {
      const candidates = [
        makeScoredVariant({ accuracy: 0.8, cost: 100 }),
        makeScoredVariant({ accuracy: 0.8, cost: 100 }),
      ]

      const result = selector.select(candidates, 10)
      expect(result).toHaveLength(2)
    })
  })

  describe('frontier size enforcement', () => {
    it('limits result to frontierSize', () => {
      const candidates = [
        makeScoredVariant({ accuracy: 0.9, cost: 300 }),
        makeScoredVariant({ accuracy: 0.8, cost: 200 }),
        makeScoredVariant({ accuracy: 0.7, cost: 100 }),
        makeScoredVariant({ accuracy: 0.6, cost: 50 }),
      ]

      const result = selector.select(candidates, 2)
      expect(result.length).toBeLessThanOrEqual(2)
    })

    it('returns all when candidates <= frontierSize', () => {
      const candidates = [
        makeScoredVariant({ accuracy: 0.9, cost: 100 }),
        makeScoredVariant({ accuracy: 0.7, cost: 50 }),
      ]

      const result = selector.select(candidates, 5)
      expect(result).toHaveLength(2)
    })
  })

  describe('tiebreaker on skillSize', () => {
    it('prefers smaller skillSize when accuracy is equal', () => {
      // Each trades accuracy for cost → all non-dominated
      // B and C tie on accuracy and cost → neither dominates the other
      const candidates = [
        makeScoredVariant({ accuracy: 0.9, cost: 300, skillSize: 200 }), // A
        makeScoredVariant({ accuracy: 0.8, cost: 100, skillSize: 50 }), // B
        makeScoredVariant({ accuracy: 0.8, cost: 100, skillSize: 150 }), // C
        makeScoredVariant({ accuracy: 0.7, cost: 50, skillSize: 100 }), // D
      ]

      // All 4 non-dominated. Limit to 2 → sort by accuracy desc, tiebreak skillSize asc.
      // A (0.9) first. B vs C (both 0.8): B has skillSize 50 < C's 150 → B wins.
      const result = selector.select(candidates, 2)
      expect(result).toHaveLength(2)
      expect(result[0].accuracy).toBe(0.9)
      expect(result[1].accuracy).toBe(0.8)
      expect(result[1].skillSize).toBe(50)
    })
  })

  describe('edge cases', () => {
    it('returns empty for empty input', () => {
      const result = selector.select([], 5)
      expect(result).toHaveLength(0)
    })

    it('handles single candidate', () => {
      const candidates = [makeScoredVariant({ accuracy: 0.5, cost: 100 })]
      const result = selector.select(candidates, 3)
      expect(result).toHaveLength(1)
    })

    it('handles all identical candidates', () => {
      const candidates = Array.from({ length: 5 }, () =>
        makeScoredVariant({ accuracy: 0.8, cost: 100, skillSize: 50 })
      )
      const result = selector.select(candidates, 3)
      // None dominate each other since all are equal
      expect(result.length).toBeLessThanOrEqual(3)
    })
  })
})
