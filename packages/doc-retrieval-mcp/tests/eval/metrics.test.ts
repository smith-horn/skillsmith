/**
 * SMI-4702 — Unit tests for eval/metrics.ts.
 *
 * Covers all metric functions with:
 *   - all-present case (perfect retrieval)
 *   - all-absent case (zero retrieval)
 *   - partial-recall case (M2 fix: mixed hit/miss across queries)
 *   - empty hits edge case
 *   - per-category breakdown
 */

import { describe, it, expect } from 'vitest'
import { isHitRelevant, recallAtK, mrr, ndcgAtK, computeMetrics } from '../../eval/metrics.js'
import type { RunResult, ExpectedChunk, HitResult } from '../../eval/metrics.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHit(filePath: string): HitResult {
  return { filePath }
}

function makeExpected(
  filePath: string,
  matchType: 'substring' | 'exact' = 'substring'
): ExpectedChunk {
  return { filePath, matchType }
}

function makeResult(
  id: string,
  hits: HitResult[],
  expectedChunks: ExpectedChunk[],
  category = 'memory-recall',
  difficulty: 'easy' | 'medium' | 'hard' = 'medium'
): RunResult {
  return { id, query: `query-${id}`, category, difficulty, hits, expectedChunks }
}

// ---------------------------------------------------------------------------
// isHitRelevant
// ---------------------------------------------------------------------------

describe('isHitRelevant', () => {
  it('returns true for substring match', () => {
    const hit = makeHit('memory://user/feedback_foo.md')
    const expected = [makeExpected('feedback_foo.md', 'substring')]
    expect(isHitRelevant(hit, expected)).toBe(true)
  })

  it('returns true for exact match', () => {
    const hit = makeHit('feedback_foo.md')
    const expected = [makeExpected('feedback_foo.md', 'exact')]
    expect(isHitRelevant(hit, expected)).toBe(true)
  })

  it('returns false when exact match does not match full path', () => {
    const hit = makeHit('memory://user/feedback_foo.md')
    const expected = [makeExpected('feedback_foo.md', 'exact')]
    expect(isHitRelevant(hit, expected)).toBe(false)
  })

  it('returns false when no expected chunk matches', () => {
    const hit = makeHit('unrelated.md')
    const expected = [makeExpected('feedback_foo.md', 'substring')]
    expect(isHitRelevant(hit, expected)).toBe(false)
  })

  it('returns true when any expected chunk matches', () => {
    const hit = makeHit('docs/internal/retros/2026-04-25-smi-4451.md')
    const expected = [
      makeExpected('feedback_foo.md', 'substring'),
      makeExpected('2026-04-25-smi-4451', 'substring'),
    ]
    expect(isHitRelevant(hit, expected)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// All-present case: every query has a relevant hit at position 1
// ---------------------------------------------------------------------------

describe('recallAtK / mrr / ndcgAtK — all-present', () => {
  const results: RunResult[] = [
    makeResult('r1', [makeHit('feedback_a.md')], [makeExpected('feedback_a.md')]),
    makeResult('r2', [makeHit('feedback_b.md')], [makeExpected('feedback_b.md')]),
    makeResult('r3', [makeHit('feedback_c.md')], [makeExpected('feedback_c.md')]),
  ]

  it('recallAt5 = 1', () => {
    expect(recallAtK(results, 5)).toBe(1)
  })

  it('recallAt10 = 1', () => {
    expect(recallAtK(results, 10)).toBe(1)
  })

  it('mrr = 1', () => {
    expect(mrr(results)).toBe(1)
  })

  it('ndcgAt10 = 1', () => {
    // First position: gain = 1/log2(2) = 1, IDCG = 1 → nDCG = 1
    expect(ndcgAtK(results, 10)).toBeCloseTo(1, 10)
  })
})

// ---------------------------------------------------------------------------
// All-absent case: no relevant hits
// ---------------------------------------------------------------------------

describe('recallAtK / mrr / ndcgAtK — all-absent', () => {
  const results: RunResult[] = [
    makeResult('r1', [makeHit('unrelated1.md')], [makeExpected('feedback_a.md')]),
    makeResult('r2', [makeHit('unrelated2.md')], [makeExpected('feedback_b.md')]),
    makeResult('r3', [makeHit('unrelated3.md')], [makeExpected('feedback_c.md')]),
  ]

  it('recallAt5 = 0', () => {
    expect(recallAtK(results, 5)).toBe(0)
  })

  it('recallAt10 = 0', () => {
    expect(recallAtK(results, 10)).toBe(0)
  })

  it('mrr = 0', () => {
    expect(mrr(results)).toBe(0)
  })

  it('ndcgAt10 = 0', () => {
    expect(ndcgAtK(results, 10)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Partial-recall case (M2 fix): 5 queries, hits at positions [1, 3, 5], 2 miss
// ---------------------------------------------------------------------------

describe('partial-recall (M2 fix)', () => {
  // Query 1: relevant hit at position 1 (index 0)
  // Query 2: relevant hit at position 3 (index 2)
  // Query 3: relevant hit at position 5 (index 4)
  // Query 4: no relevant hit
  // Query 5: no relevant hit

  const results: RunResult[] = [
    makeResult(
      'r1',
      [makeHit('target.md'), makeHit('x.md'), makeHit('y.md')],
      [makeExpected('target.md')]
    ),
    makeResult(
      'r2',
      [makeHit('x.md'), makeHit('y.md'), makeHit('target2.md')],
      [makeExpected('target2.md')]
    ),
    makeResult(
      'r3',
      [makeHit('a.md'), makeHit('b.md'), makeHit('c.md'), makeHit('d.md'), makeHit('target3.md')],
      [makeExpected('target3.md')]
    ),
    makeResult('r4', [makeHit('x.md'), makeHit('y.md')], [makeExpected('target4.md')]),
    makeResult('r5', [makeHit('x.md'), makeHit('y.md')], [makeExpected('target5.md')]),
  ]

  it('recallAt5 = 3/5 = 0.6', () => {
    expect(recallAtK(results, 5)).toBeCloseTo(3 / 5, 10)
  })

  it('mrr ≈ (1 + 1/3 + 1/5 + 0 + 0) / 5', () => {
    const expected = (1 + 1 / 3 + 1 / 5) / 5
    expect(mrr(results)).toBeCloseTo(expected, 10)
  })

  it('ndcgAt10 ≈ ((1/log2(2)) + (1/log2(4)) + (1/log2(6))) / 5', () => {
    // rank 1 → gain = 1/log2(2); rank 3 → gain = 1/log2(4); rank 5 → gain = 1/log2(6)
    // IDCG = 1 for each (since it normalises by 1/log2(2))
    const g1 = 1 / Math.log2(2) / (1 / Math.log2(2)) // = 1
    const g2 = 1 / Math.log2(4) / (1 / Math.log2(2)) // = log2(2)/log2(4) = 0.5
    const g3 = 1 / Math.log2(6) / (1 / Math.log2(2)) // = log2(2)/log2(6)
    const expected = (g1 + g2 + g3 + 0 + 0) / 5
    expect(ndcgAtK(results, 10)).toBeCloseTo(expected, 8)
  })
})

// ---------------------------------------------------------------------------
// Edge case: empty hits list
// ---------------------------------------------------------------------------

describe('edge case — empty hits', () => {
  const results: RunResult[] = [
    makeResult('r1', [], [makeExpected('feedback_a.md')]),
    makeResult('r2', [], [makeExpected('feedback_b.md')]),
  ]

  it('recallAt5 = 0', () => {
    expect(recallAtK(results, 5)).toBe(0)
  })

  it('mrr = 0', () => {
    expect(mrr(results)).toBe(0)
  })

  it('ndcgAt10 = 0', () => {
    expect(ndcgAtK(results, 10)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Edge case: empty results array
// ---------------------------------------------------------------------------

describe('edge case — empty results array', () => {
  it('recallAtK returns 0', () => {
    expect(recallAtK([], 5)).toBe(0)
  })

  it('mrr returns 0', () => {
    expect(mrr([])).toBe(0)
  })

  it('ndcgAtK returns 0', () => {
    expect(ndcgAtK([], 10)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Per-category breakdown
// ---------------------------------------------------------------------------

describe('computeMetrics — per-category breakdown', () => {
  // 4 queries: 2 in 'memory-recall', 2 in 'adr-lookup'
  // memory-recall: both have relevant hit at position 1 → 100% recall
  // adr-lookup: neither has a relevant hit → 0% recall

  const results: RunResult[] = [
    makeResult('r1', [makeHit('feedback_a.md')], [makeExpected('feedback_a.md')], 'memory-recall'),
    makeResult('r2', [makeHit('feedback_b.md')], [makeExpected('feedback_b.md')], 'memory-recall'),
    makeResult('r3', [makeHit('unrelated.md')], [makeExpected('adr-foo.md')], 'adr-lookup'),
    makeResult('r4', [makeHit('unrelated.md')], [makeExpected('adr-bar.md')], 'adr-lookup'),
  ]

  it('overall count = 4', () => {
    const report = computeMetrics(results)
    expect(report.overall.count).toBe(4)
  })

  it('memory-recall recall@5 = 1', () => {
    const report = computeMetrics(results)
    expect(report.byCategory['memory-recall']?.recallAt5).toBe(1)
  })

  it('adr-lookup recall@5 = 0', () => {
    const report = computeMetrics(results)
    expect(report.byCategory['adr-lookup']?.recallAt5).toBe(0)
  })

  it('byCategory contains exactly 2 categories', () => {
    const report = computeMetrics(results)
    expect(Object.keys(report.byCategory)).toHaveLength(2)
  })

  it('byDifficulty is populated from difficulty field', () => {
    const report = computeMetrics(results)
    expect(report.byDifficulty['medium']?.count).toBe(4)
  })
})
