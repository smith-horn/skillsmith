/**
 * SMI-4702 — Ablation runner unit tests (GAP 4).
 *
 * Tests are grouped into four cases per the plan review:
 *   (a) Sweep matrix matches spec — values array length and baseline presence
 *   (b) Env-var injection sets correct names per dimension
 *   (c) Baseline row uses production defaults from exported constants
 *   (d) deltaRecallAt5 is a signed float; baseline row has Δ = 0
 *
 * Plus: process.env is restored after runAblation returns.
 *
 * The live eval-runner is never invoked — all tests use the runEvalFn hook.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runAblation, type AblationDimension } from '../../eval/ablation-runner.js'
import { DEFAULT_BOOST_MEMORY, DEFAULT_DAMPEN_PROCESS } from '../../src/rerank.js'
import { DEFAULT_MIN_SIMILARITY } from '../../src/config.js'
import type { MetricSet } from '../../eval/metrics.js'

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/** A MetricSet stub with controllable recallAt5 */
function makeMetrics(recallAt5: number): MetricSet {
  return { recallAt5, recallAt10: recallAt5 + 0.05, mrr: 0.7, ndcgAt10: 0.75, count: 55 }
}

/** Build a runEvalFn that records every call and returns a fixed MetricSet per call index. */
function buildMockFn(recallValues: number[]): {
  fn: (env: Record<string, string>, minScore: number) => Promise<MetricSet>
  calls: Array<{ env: Record<string, string>; minScore: number }>
} {
  const calls: Array<{ env: Record<string, string>; minScore: number }> = []
  let idx = 0
  const fn = async (env: Record<string, string>, minScore: number): Promise<MetricSet> => {
    calls.push({ env: { ...env }, minScore })
    const recall = recallValues[idx] ?? 0.5
    idx++
    return makeMetrics(recall)
  }
  return { fn, calls }
}

/** Simple uniform mock: returns the same recall for every call */
function uniformMock(
  recall: number
): (env: Record<string, string>, minScore: number) => Promise<MetricSet> {
  return async () => makeMetrics(recall)
}

// ---------------------------------------------------------------------------
// (a) Sweep matrix matches spec
// ---------------------------------------------------------------------------

describe('(a) sweep matrix length and baseline presence', () => {
  it('boost: 5 values, baseline = DEFAULT_BOOST_MEMORY', async () => {
    const { fn } = buildMockFn(Array(5).fill(0.8))
    const result = await runAblation('boost', { runEvalFn: fn, json: false })
    expect(result.rows).toHaveLength(5)
    const values = result.rows.map((r) => r.value)
    expect(values).toContain(DEFAULT_BOOST_MEMORY)
    expect(result.rows.filter((r) => r.isBaseline)).toHaveLength(1)
  })

  it('dampen: 3 values, baseline = DEFAULT_DAMPEN_PROCESS', async () => {
    const { fn } = buildMockFn(Array(3).fill(0.75))
    const result = await runAblation('dampen', { runEvalFn: fn })
    expect(result.rows).toHaveLength(3)
    const values = result.rows.map((r) => r.value)
    expect(values).toContain(DEFAULT_DAMPEN_PROCESS)
    expect(result.rows.filter((r) => r.isBaseline)).toHaveLength(1)
  })

  it('floor: 3 values, baseline = DEFAULT_MIN_SIMILARITY', async () => {
    const { fn } = buildMockFn(Array(3).fill(0.72))
    const result = await runAblation('floor', { runEvalFn: fn })
    expect(result.rows).toHaveLength(3)
    const values = result.rows.map((r) => r.value)
    expect(values).toContain(DEFAULT_MIN_SIMILARITY)
    expect(result.rows.filter((r) => r.isBaseline)).toHaveLength(1)
  })

  it('bm25: 2 values, baseline = false', async () => {
    const { fn } = buildMockFn(Array(2).fill(0.68))
    const result = await runAblation('bm25', { runEvalFn: fn })
    expect(result.rows).toHaveLength(2)
    const values = result.rows.map((r) => r.value)
    expect(values).toContain(false)
    expect(values).toContain(true)
    expect(result.rows.filter((r) => r.isBaseline)).toHaveLength(1)
    expect(result.rows.find((r) => r.isBaseline)?.value).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (b) Env-var injection sets correct names
// ---------------------------------------------------------------------------

describe('(b) env-var injection sets correct variable names', () => {
  it('boost: sets SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY for each call', async () => {
    const { fn, calls } = buildMockFn(Array(5).fill(0.8))
    await runAblation('boost', { runEvalFn: fn })
    expect(calls).toHaveLength(5)
    for (const call of calls) {
      expect(call.env).toHaveProperty('SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY')
      // value should be a parseable number string
      const v = Number(call.env['SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY'])
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('dampen: sets SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS for each call', async () => {
    const { fn, calls } = buildMockFn(Array(3).fill(0.75))
    await runAblation('dampen', { runEvalFn: fn })
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.env).toHaveProperty('SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS')
    }
  })

  it('bm25: sets SKILLSMITH_DOC_RETRIEVAL_RERANK to "bm25" for on, "" for off', async () => {
    const { fn, calls } = buildMockFn(Array(2).fill(0.68))
    const result = await runAblation('bm25', { runEvalFn: fn })
    expect(calls).toHaveLength(2)

    const offRow = result.rows.find((r) => r.value === false)
    const onRow = result.rows.find((r) => r.value === true)
    expect(offRow).toBeDefined()
    expect(onRow).toBeDefined()

    // off call: RERANK env = ''
    const offCall = calls[result.rows.indexOf(offRow!)]
    expect(offCall?.env['SKILLSMITH_DOC_RETRIEVAL_RERANK']).toBe('')

    // on call: RERANK env = 'bm25'
    const onCall = calls[result.rows.indexOf(onRow!)]
    expect(onCall?.env['SKILLSMITH_DOC_RETRIEVAL_RERANK']).toBe('bm25')
  })

  it('floor: does NOT set any env var; passes minScore as second arg', async () => {
    const { fn, calls } = buildMockFn(Array(3).fill(0.72))
    await runAblation('floor', { runEvalFn: fn })
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      // no retrieval-related env var should be set by the floor dimension
      expect(call.env).not.toHaveProperty('SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY')
      expect(call.env).not.toHaveProperty('SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS')
      expect(call.env).not.toHaveProperty('SKILLSMITH_DOC_RETRIEVAL_RERANK')
    }
    // minScore values should be the floor sweep values [0.25, DEFAULT_MIN_SIMILARITY, 0.45]
    const minScores = calls.map((c) => c.minScore)
    expect(minScores).toContain(0.25)
    expect(minScores).toContain(DEFAULT_MIN_SIMILARITY)
    expect(minScores).toContain(0.45)
  })
})

// ---------------------------------------------------------------------------
// (c) Baseline row uses production defaults from exported constants
// ---------------------------------------------------------------------------

describe('(c) baseline row uses production default values from imported constants', () => {
  it('boost: baseline row value === DEFAULT_BOOST_MEMORY (not hardcoded 1.5)', async () => {
    const result = await runAblation('boost', { runEvalFn: uniformMock(0.8) })
    const baselineRow = result.rows.find((r) => r.isBaseline)
    expect(baselineRow).toBeDefined()
    expect(baselineRow!.value).toBe(DEFAULT_BOOST_MEMORY)
  })

  it('dampen: baseline row value === DEFAULT_DAMPEN_PROCESS (not hardcoded 0.85)', async () => {
    const result = await runAblation('dampen', { runEvalFn: uniformMock(0.75) })
    const baselineRow = result.rows.find((r) => r.isBaseline)
    expect(baselineRow).toBeDefined()
    expect(baselineRow!.value).toBe(DEFAULT_DAMPEN_PROCESS)
  })

  it('floor: baseline row value === DEFAULT_MIN_SIMILARITY (not hardcoded 0.35)', async () => {
    const result = await runAblation('floor', { runEvalFn: uniformMock(0.72) })
    const baselineRow = result.rows.find((r) => r.isBaseline)
    expect(baselineRow).toBeDefined()
    expect(baselineRow!.value).toBe(DEFAULT_MIN_SIMILARITY)
  })

  it('bm25: baseline row value === false', async () => {
    const result = await runAblation('bm25', { runEvalFn: uniformMock(0.68) })
    const baselineRow = result.rows.find((r) => r.isBaseline)
    expect(baselineRow).toBeDefined()
    expect(baselineRow!.value).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (d) deltaRecallAt5 is a signed float; baseline row has Δ = 0
// ---------------------------------------------------------------------------

describe('(d) deltaRecallAt5 is a signed number; baseline row has delta = 0', () => {
  it('baseline row has deltaRecallAt5 === 0 (exact)', async () => {
    // boost sweep: 5 calls, baseline is DEFAULT_BOOST_MEMORY (3rd value)
    const recall = [0.6, 0.7, 0.8, 0.75, 0.65]
    const { fn } = buildMockFn(recall)
    const result = await runAblation('boost', { runEvalFn: fn })
    const baselineRow = result.rows.find((r) => r.isBaseline)
    expect(baselineRow).toBeDefined()
    expect(baselineRow!.deltaRecallAt5).toBe(0)
  })

  it('non-baseline rows have deltaRecallAt5 = recallAt5 - baseline.recallAt5 (signed number)', async () => {
    // boost values: [1.0, 1.3, DEFAULT_BOOST_MEMORY, 1.7, 2.0]
    // recall values: baseline (index 2) = 0.8; others vary
    const recall = [0.6, 0.75, 0.8, 0.85, 0.9]
    const { fn } = buildMockFn(recall)
    const result = await runAblation('boost', { runEvalFn: fn })

    const baselineRecall = 0.8
    for (const row of result.rows) {
      expect(typeof row.deltaRecallAt5).toBe('number')
      if (row.isBaseline) {
        expect(row.deltaRecallAt5).toBe(0)
      } else {
        const expected = row.recallAt5 - baselineRecall
        expect(row.deltaRecallAt5).toBeCloseTo(expected, 10)
      }
    }
  })

  it('negative delta is a negative number, not an annotated string', async () => {
    // First value (1.0) has recall 0.5, baseline (DEFAULT_BOOST_MEMORY) has recall 0.8
    const recall = [0.5, 0.7, 0.8, 0.85, 0.9]
    const { fn } = buildMockFn(recall)
    const result = await runAblation('boost', { runEvalFn: fn })

    const lowestRow = result.rows[0]
    expect(lowestRow).toBeDefined()
    expect(typeof lowestRow!.deltaRecallAt5).toBe('number')
    expect(lowestRow!.deltaRecallAt5).toBeLessThan(0)
    // Specifically: 0.5 - 0.8 = -0.3
    expect(lowestRow!.deltaRecallAt5).toBeCloseTo(-0.3, 10)
  })

  it('dampen: deltaRecallAt5 correct for 3-row sweep', async () => {
    // dampen values: [0.7, DEFAULT_DAMPEN_PROCESS, 1.0]
    const recall = [0.65, 0.78, 0.7]
    const { fn } = buildMockFn(recall)
    const result = await runAblation('dampen', { runEvalFn: fn })

    const baselineRecall = 0.78
    expect(result.rows[0]!.deltaRecallAt5).toBeCloseTo(0.65 - baselineRecall, 10)
    expect(result.rows[1]!.deltaRecallAt5).toBe(0)
    expect(result.rows[2]!.deltaRecallAt5).toBeCloseTo(0.7 - baselineRecall, 10)
  })
})

// ---------------------------------------------------------------------------
// process.env restoration guarantee
// ---------------------------------------------------------------------------

describe('process.env restoration', () => {
  let priorBoost: string | undefined
  let priorDampen: string | undefined
  let priorRerank: string | undefined

  beforeEach(() => {
    priorBoost = process.env['SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY']
    priorDampen = process.env['SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS']
    priorRerank = process.env['SKILLSMITH_DOC_RETRIEVAL_RERANK']
    // Set sentinel values to verify they are restored
    process.env['SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY'] = 'sentinel-boost'
    process.env['SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS'] = 'sentinel-dampen'
    process.env['SKILLSMITH_DOC_RETRIEVAL_RERANK'] = 'sentinel-rerank'
  })

  afterEach(() => {
    // Clean up sentinels regardless of test outcome
    if (priorBoost === undefined) delete process.env['SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY']
    else process.env['SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY'] = priorBoost
    if (priorDampen === undefined) delete process.env['SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS']
    else process.env['SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS'] = priorDampen
    if (priorRerank === undefined) delete process.env['SKILLSMITH_DOC_RETRIEVAL_RERANK']
    else process.env['SKILLSMITH_DOC_RETRIEVAL_RERANK'] = priorRerank
  })

  it('boost sweep restores SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY to pre-call value', async () => {
    await runAblation('boost', { runEvalFn: uniformMock(0.8) })
    expect(process.env['SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY']).toBe('sentinel-boost')
  })

  it('dampen sweep restores SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS to pre-call value', async () => {
    await runAblation('dampen', { runEvalFn: uniformMock(0.75) })
    expect(process.env['SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS']).toBe('sentinel-dampen')
  })

  it('bm25 sweep restores SKILLSMITH_DOC_RETRIEVAL_RERANK to pre-call value', async () => {
    await runAblation('bm25', { runEvalFn: uniformMock(0.68) })
    expect(process.env['SKILLSMITH_DOC_RETRIEVAL_RERANK']).toBe('sentinel-rerank')
  })

  it('floor sweep does not mutate retrieval env vars', async () => {
    await runAblation('floor', { runEvalFn: uniformMock(0.72) })
    // Floor only passes minScore; it should not touch any retrieval env vars
    expect(process.env['SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY']).toBe('sentinel-boost')
    expect(process.env['SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS']).toBe('sentinel-dampen')
    expect(process.env['SKILLSMITH_DOC_RETRIEVAL_RERANK']).toBe('sentinel-rerank')
  })
})

// ---------------------------------------------------------------------------
// AblationResult shape
// ---------------------------------------------------------------------------

describe('AblationResult structural shape', () => {
  it('dimension field matches requested dimension', async () => {
    const dims: AblationDimension[] = ['boost', 'dampen', 'floor', 'bm25']
    for (const dim of dims) {
      const counts = { boost: 5, dampen: 3, floor: 3, bm25: 2 }
      const { fn } = buildMockFn(Array(counts[dim]).fill(0.7))
      const result = await runAblation(dim, { runEvalFn: fn })
      expect(result.dimension).toBe(dim)
    }
  })

  it('each row carries all required fields with correct types', async () => {
    const result = await runAblation('boost', { runEvalFn: uniformMock(0.8) })
    for (const row of result.rows) {
      expect(
        typeof row.value === 'number' ||
          typeof row.value === 'boolean' ||
          typeof row.value === 'string'
      ).toBe(true)
      expect(typeof row.recallAt5).toBe('number')
      expect(typeof row.recallAt10).toBe('number')
      expect(typeof row.mrr).toBe('number')
      expect(typeof row.ndcgAt10).toBe('number')
      expect(typeof row.deltaRecallAt5).toBe('number')
      expect(typeof row.isBaseline).toBe('boolean')
    }
  })
})
