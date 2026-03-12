import { describe, it, expect } from 'vitest'
import { ndcg, mrr, mapAtK, precisionAtK, recallAtK } from '../../src/benchmarks/evoskill/ir-metrics.js'

describe('IR Metrics', () => {
  describe('nDCG', () => {
    it('returns 1.0 for perfect ranking', () => {
      const ranked = ['a', 'b', 'c']
      const relevance = new Map([
        ['a', 3],
        ['b', 2],
        ['c', 1],
      ])
      expect(ndcg(ranked, relevance, 3)).toBeCloseTo(1.0, 5)
    })

    it('returns less than 1.0 for imperfect ranking', () => {
      const ranked = ['c', 'a', 'b']
      const relevance = new Map([
        ['a', 3],
        ['b', 2],
        ['c', 1],
      ])
      const score = ndcg(ranked, relevance, 3)
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThan(1.0)
    })

    it('handles k smaller than ranked list', () => {
      const ranked = ['a', 'b', 'c', 'd']
      const relevance = new Map([
        ['a', 3],
        ['b', 2],
        ['c', 1],
        ['d', 0],
      ])
      const score = ndcg(ranked, relevance, 2)
      expect(score).toBeCloseTo(1.0, 5) // top-2 are already in ideal order
    })

    it('returns 0 for empty results', () => {
      expect(ndcg([], new Map([['a', 1]]), 5)).toBe(0)
    })

    it('returns 0 for empty relevance map', () => {
      expect(ndcg(['a', 'b'], new Map(), 5)).toBe(0)
    })

    it('returns 0 when no ranked items have relevance', () => {
      const ranked = ['x', 'y']
      const relevance = new Map([['a', 3]])
      expect(ndcg(ranked, relevance, 2)).toBe(0)
    })

    // Known-answer from IR textbook (Manning et al., Introduction to IR)
    it('computes correct nDCG@5 for textbook example', () => {
      // Example: ranked results with graded relevance 3, 2, 3, 0, 1
      const ranked = ['d1', 'd2', 'd3', 'd4', 'd5']
      const relevance = new Map([
        ['d1', 3],
        ['d2', 2],
        ['d3', 3],
        ['d4', 0],
        ['d5', 1],
      ])
      // DCG@5 = 3/log2(2) + 2/log2(3) + 3/log2(4) + 0/log2(5) + 1/log2(6)
      //       = 3/1 + 2/1.585 + 3/2 + 0 + 1/2.585
      //       = 3 + 1.262 + 1.5 + 0 + 0.387 = 6.149
      // Ideal: 3, 3, 2, 1, 0
      // IDCG@5 = 3/1 + 3/1.585 + 2/2 + 1/2.322 + 0 = 3 + 1.893 + 1 + 0.431 = 6.324
      // nDCG@5 = 6.149 / 6.324 ≈ 0.972
      const score = ndcg(ranked, relevance, 5)
      expect(score).toBeCloseTo(0.972, 2)
    })
  })

  describe('MRR', () => {
    it('returns 1.0 when first result is relevant', () => {
      expect(mrr(['a', 'b', 'c'], new Set(['a']))).toBe(1.0)
    })

    it('returns 0.5 when second result is first relevant', () => {
      expect(mrr(['b', 'a', 'c'], new Set(['a']))).toBe(0.5)
    })

    it('returns 1/3 when third result is first relevant', () => {
      expect(mrr(['x', 'y', 'a'], new Set(['a']))).toBeCloseTo(1 / 3, 5)
    })

    it('returns 0 when no results are relevant', () => {
      expect(mrr(['x', 'y', 'z'], new Set(['a']))).toBe(0)
    })

    it('returns 0 for empty results', () => {
      expect(mrr([], new Set(['a']))).toBe(0)
    })

    it('returns 0 for empty relevant set', () => {
      expect(mrr(['a', 'b'], new Set())).toBe(0)
    })

    it('returns 1.0 when all results are relevant', () => {
      expect(mrr(['a', 'b', 'c'], new Set(['a', 'b', 'c']))).toBe(1.0)
    })
  })

  describe('MAP@k', () => {
    it('returns 1.0 for perfect ranking with all relevant', () => {
      const ranked = ['a', 'b']
      const relevant = new Set(['a', 'b'])
      // P@1 = 1/1 (hit), P@2 = 2/2 (hit) → AP = (1 + 1) / 2 = 1.0
      expect(mapAtK(ranked, relevant, 2)).toBeCloseTo(1.0, 5)
    })

    it('penalizes late relevant results', () => {
      const ranked = ['x', 'a', 'y', 'b']
      const relevant = new Set(['a', 'b'])
      // P@2 = 1/2 (hit at pos 2), P@4 = 2/4 (hit at pos 4)
      // AP = (0.5 + 0.5) / 2 = 0.5
      expect(mapAtK(ranked, relevant, 4)).toBeCloseTo(0.5, 5)
    })

    it('returns 0 when no results are relevant', () => {
      expect(mapAtK(['x', 'y'], new Set(['a']), 2)).toBe(0)
    })

    it('returns 0 for empty inputs', () => {
      expect(mapAtK([], new Set(['a']), 5)).toBe(0)
      expect(mapAtK(['a'], new Set(), 5)).toBe(0)
    })

    it('handles k larger than result list', () => {
      const ranked = ['a']
      const relevant = new Set(['a', 'b'])
      // Only 1 result, it's relevant: P@1 = 1/1 → AP = 1/2 (normalize by relevant.size=2)
      expect(mapAtK(ranked, relevant, 10)).toBeCloseTo(0.5, 5)
    })
  })

  describe('Precision@k', () => {
    it('returns 1.0 when all top-k are relevant', () => {
      expect(precisionAtK(['a', 'b'], new Set(['a', 'b', 'c']), 2)).toBe(1.0)
    })

    it('returns 0.5 when half of top-k are relevant', () => {
      expect(precisionAtK(['a', 'x'], new Set(['a']), 2)).toBe(0.5)
    })

    it('returns 0 when none are relevant', () => {
      expect(precisionAtK(['x', 'y'], new Set(['a']), 2)).toBe(0)
    })

    it('handles k larger than result list', () => {
      // k=5 but only 2 results, 1 relevant → 1/2
      expect(precisionAtK(['a', 'x'], new Set(['a']), 5)).toBe(0.5)
    })

    it('returns 0 for empty inputs', () => {
      expect(precisionAtK([], new Set(['a']), 5)).toBe(0)
      expect(precisionAtK(['a'], new Set(), 5)).toBe(0)
    })
  })

  describe('Recall@k', () => {
    it('returns 1.0 when all relevant items are in top-k', () => {
      expect(recallAtK(['a', 'b', 'x'], new Set(['a', 'b']), 3)).toBe(1.0)
    })

    it('returns 0.5 when half of relevant items are in top-k', () => {
      expect(recallAtK(['a', 'x'], new Set(['a', 'b']), 2)).toBe(0.5)
    })

    it('returns 0 when no relevant items are in top-k', () => {
      expect(recallAtK(['x', 'y'], new Set(['a', 'b']), 2)).toBe(0)
    })

    it('returns 0 for empty inputs', () => {
      expect(recallAtK([], new Set(['a']), 5)).toBe(0)
      expect(recallAtK(['a'], new Set(), 5)).toBe(0)
    })

    it('returns correct ratio for single relevant item', () => {
      expect(recallAtK(['x', 'a', 'y'], new Set(['a']), 3)).toBe(1.0)
      expect(recallAtK(['x', 'y', 'z'], new Set(['a']), 3)).toBe(0)
    })
  })
})
