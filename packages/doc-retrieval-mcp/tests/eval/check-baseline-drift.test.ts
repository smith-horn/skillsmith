/**
 * SMI-4702 -- Unit tests for check-baseline-drift.ts
 *
 * Tests import `evaluateDrift` directly to avoid spawning subprocesses or
 * touching the filesystem. Git diff and baseline.json loading are exercised
 * via the exported function, not via the CLI entry point.
 */

import { describe, it, expect } from 'vitest'
import { evaluateDrift, checkHybridDrift } from '../../eval/check-baseline-drift.js'
import type { BaselineFile, BaselineByCategory } from '../../eval/check-baseline-drift.js'

// Convenience factories
const nullBaseline = (): BaselineFile => ({
  prior: null,
  current: null,
  generated: '2026-05-05',
  corpus: { filesScanned: 0, chunksUpserted: 0 },
  knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: false },
  metrics: { recallAt5: null },
})

const populatedBaseline = (prior: number | null, current: number | null): BaselineFile => ({
  prior,
  current,
  generated: '2026-05-05',
  corpus: { filesScanned: 1080, chunksUpserted: 26089 },
  knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: false },
  metrics: { recallAt5: current },
})

// ---------------------------------------------------------------------------
// (a) No ranking files changed, no eval files changed -> pass
// ---------------------------------------------------------------------------

describe('evaluateDrift', () => {
  it('(a) passes when no ranking or eval files are changed', () => {
    const changedFiles = [
      'packages/doc-retrieval-mcp/src/adapters/memory-topic-files.ts',
      'docs/internal/architecture/index.md',
    ]
    const result = evaluateDrift(changedFiles, nullBaseline())
    expect(result.pass).toBe(true)
    expect(result.message).toContain('nothing to check')
  })

  // -------------------------------------------------------------------------
  // (b) Ranking files changed, baseline.json changed, regression OK -> pass
  // -------------------------------------------------------------------------

  it('(b) passes when ranking files changed and baseline.json updated with no regression', () => {
    const changedFiles = [
      'packages/doc-retrieval-mcp/src/rerank.ts',
      'packages/doc-retrieval-mcp/eval/baseline.json',
    ]
    // prior 0.78, current 0.80 -- improvement, no regression
    const result = evaluateDrift(changedFiles, populatedBaseline(0.78, 0.8))
    expect(result.pass).toBe(true)
    expect(result.message).toContain('within 5% threshold')
  })

  // -------------------------------------------------------------------------
  // (c) Ranking files changed, baseline.json NOT changed -> fail
  // -------------------------------------------------------------------------

  it('(c) fails when ranking files changed but baseline.json was not updated', () => {
    const changedFiles = [
      'packages/doc-retrieval-mcp/src/rerank.ts',
      'packages/doc-retrieval-mcp/src/search.ts',
    ]
    const result = evaluateDrift(changedFiles, nullBaseline())
    expect(result.pass).toBe(false)
    expect(result.message).toContain('baseline.json was not updated')
    expect(result.message).toContain('::error::')
  })

  it('(c2) fails when corpus.config.json changed but baseline.json was not updated', () => {
    const changedFiles = ['packages/doc-retrieval-mcp/src/corpus.config.json']
    const result = evaluateDrift(changedFiles, nullBaseline())
    expect(result.pass).toBe(false)
    expect(result.message).toContain('baseline.json was not updated')
  })

  // -------------------------------------------------------------------------
  // (d) Gold-set changed, baseline.json NOT changed -> fail (GAP 3)
  // -------------------------------------------------------------------------

  it('(d) fails when gold-set.json changed but baseline.json was not updated', () => {
    const changedFiles = ['packages/doc-retrieval-mcp/eval/gold-set.json']
    const result = evaluateDrift(changedFiles, nullBaseline())
    expect(result.pass).toBe(false)
    expect(result.message).toContain('gold-set.json changed but baseline.json was not updated')
    expect(result.message).toContain('::error::')
  })

  // -------------------------------------------------------------------------
  // (e) baseline.json changed, current 10% below prior -> fail
  // -------------------------------------------------------------------------

  it('(e) fails when recall@5 regressed more than 5% vs prior', () => {
    const changedFiles = ['packages/doc-retrieval-mcp/eval/baseline.json']
    // prior 0.80, current 0.72 -- delta = -0.10, i.e. -10%
    const result = evaluateDrift(changedFiles, populatedBaseline(0.8, 0.72))
    expect(result.pass).toBe(false)
    expect(result.message).toContain('>5%')
    expect(result.message).toContain('::error::')
  })

  it('(e2) fails at exactly the 5% threshold (delta = -0.0501)', () => {
    const changedFiles = ['packages/doc-retrieval-mcp/eval/baseline.json']
    // prior 1.0, current 0.949 -- delta = -0.051
    const result = evaluateDrift(changedFiles, populatedBaseline(1.0, 0.949))
    expect(result.pass).toBe(false)
    expect(result.message).toContain('>5%')
  })

  it('(e3) passes when recall@5 dropped just under 5% (boundary: not exceeded)', () => {
    const changedFiles = ['packages/doc-retrieval-mcp/eval/baseline.json']
    // prior 1.0, current 0.952 -- delta = -0.048, strictly greater than -0.05
    const result = evaluateDrift(changedFiles, populatedBaseline(1.0, 0.952))
    expect(result.pass).toBe(true)
  })

  // -------------------------------------------------------------------------
  // (f) baseline.json changed, prior is null -> skip regression (M1)
  // -------------------------------------------------------------------------

  it('(f) skips regression check when prior is null (first real-mode run)', () => {
    const changedFiles = ['packages/doc-retrieval-mcp/eval/baseline.json']
    // current is very low but prior is null -- should pass
    const result = evaluateDrift(changedFiles, populatedBaseline(null, 0.1))
    expect(result.pass).toBe(true)
    expect(result.message).toContain('prior is null')
    expect(result.message).not.toContain('::error::')
  })

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------

  it('passes when both ranking files and baseline.json changed with acceptable improvement', () => {
    const changedFiles = [
      'packages/doc-retrieval-mcp/src/search.ts',
      'packages/doc-retrieval-mcp/eval/baseline.json',
    ]
    // prior 0.75, current 0.78 -- improvement
    const result = evaluateDrift(changedFiles, populatedBaseline(0.75, 0.78))
    expect(result.pass).toBe(true)
  })

  it('passes when gold-set and baseline both changed (correct protocol)', () => {
    const changedFiles = [
      'packages/doc-retrieval-mcp/eval/gold-set.json',
      'packages/doc-retrieval-mcp/eval/baseline.json',
    ]
    const result = evaluateDrift(changedFiles, populatedBaseline(0.8, 0.81))
    expect(result.pass).toBe(true)
  })

  // -------------------------------------------------------------------------
  // SMI-4764 Wave 1 — hybrid threshold (per-category + global tripwire)
  // -------------------------------------------------------------------------
  //
  // Uses today's real per-category numbers (post-#980 baseline) as the
  // anchor for prior values:
  //   memory-recall          recall@5=0.286 count=14 (high-N)
  //   implementation-lookup  recall@5=0.250 count=12 (high-N)
  //   adr-lookup             recall@5=0.500 count=6  (low-N)
  //   skill-discovery        recall@5=0.600 count=5  (low-N)
  //   retro-lookup           recall@5=0.500 count=10 (high-N boundary)
  //   script-header          recall@5=0.625 count=8  (low-N)

  const TODAY_PRIOR: Record<string, number> = {
    'memory-recall': 0.286,
    'implementation-lookup': 0.25,
    'adr-lookup': 0.5,
    'skill-discovery': 0.6,
    'retro-lookup': 0.5,
    'script-header': 0.625,
  }
  const TODAY_COUNTS: Record<string, number> = {
    'memory-recall': 14,
    'implementation-lookup': 12,
    'adr-lookup': 6,
    'skill-discovery': 5,
    'retro-lookup': 10,
    'script-header': 8,
  }

  const hybridBaseline = (
    overallPrior: number,
    overallCurrent: number,
    currentByCat: Record<string, number>,
    priorByCat: Record<string, number> | null = TODAY_PRIOR
  ): BaselineFile => {
    const byCategory: BaselineByCategory = {
      recallAt5: currentByCat,
      recallAt5Prior: priorByCat,
      count: TODAY_COUNTS,
    }
    return {
      prior: overallPrior,
      current: overallCurrent,
      generated: '2026-05-06',
      corpus: { filesScanned: 1325, chunksUpserted: 28432 },
      knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: false },
      metrics: { recallAt5: overallCurrent },
      byCategory,
    }
  }

  describe('hybrid threshold (SMI-4764 Wave 1)', () => {
    it('per-category trip: memory-recall drops 1 hit (high-N) → fails', () => {
      // memory-recall N=14, 1-hit floor = 1/14 ≈ 0.0714, 5% rel = 0.0143
      // threshold = max → 0.0714. Drop 1 hit: 0.286 → 0.214 (drop = 0.072 ≥ 0.0714).
      const current = { ...TODAY_PRIOR, 'memory-recall': 0.214 }
      const result = checkHybridDrift(hybridBaseline(0.42, 0.41, current), 0.42, 0.41)
      expect(result.pass).toBe(false)
      expect(result.message).toContain('memory-recall')
      expect(result.message).toContain('Per-category')
      expect(result.message).toContain('::error::')
    })

    it('low-N noise floor: skill-discovery single-hit drop (N=5) does NOT trip', () => {
      // skill-discovery N=5, low-N floor = 2 hits = 2/5 = 0.4
      // 5% rel = 0.6 × 0.05 = 0.03. threshold = max(0.03, 0.4) = 0.4.
      // Single-hit drop: 0.6 → 0.4 (drop = 0.2 < 0.4). PASS.
      const current = { ...TODAY_PRIOR, 'skill-discovery': 0.4 }
      const result = checkHybridDrift(hybridBaseline(0.4, 0.39, current), 0.4, 0.39)
      expect(result.pass).toBe(true)
      expect(result.message).toContain('hybrid threshold passed')
    })

    it('low-N: skill-discovery 2-hit drop (N=5) DOES trip', () => {
      // skill-discovery N=5, 2-hit drop: 0.6 → 0.2 (drop = 0.4 ≥ 0.4 floor). FAIL.
      const current = { ...TODAY_PRIOR, 'skill-discovery': 0.2 }
      const result = checkHybridDrift(hybridBaseline(0.4, 0.35, current), 0.4, 0.35)
      expect(result.pass).toBe(false)
      expect(result.message).toContain('skill-discovery')
      expect(result.message).toContain('2/5')
    })

    it('global tripwire: overall recall@5 drops >10% triggers global fail', () => {
      // All per-cat thresholds OK (small uniform drops), but overall
      // 0.42 → 0.30 (delta = -28.6%). Global tripwire fires.
      const current: Record<string, number> = {
        'memory-recall': 0.27, // 0.286 → 0.27 (drop 0.016 < 0.0714 floor) — no per-cat
        'implementation-lookup': 0.24, // 0.25 → 0.24 (drop 0.01 < 1/12=0.083) — no per-cat
        'adr-lookup': 0.48, // 0.5 → 0.48 (drop 0.02 < 2/6=0.333 low-N) — no per-cat
        'skill-discovery': 0.58, // 0.6 → 0.58 (drop 0.02 < 0.4 low-N) — no per-cat
        'retro-lookup': 0.48, // 0.5 → 0.48 (drop 0.02 < 1/10=0.1) — no per-cat
        'script-header': 0.6, // 0.625 → 0.6 (drop 0.025 < 2/8=0.25 low-N) — no per-cat
      }
      const result = checkHybridDrift(hybridBaseline(0.42, 0.3, current), 0.42, 0.3)
      expect(result.pass).toBe(false)
      expect(result.message).toContain('Global tripwire')
      expect(result.message).toContain('>10%')
    })

    it('byCategory absent: falls back to legacy global 5% gate (10% drop fails)', () => {
      // No byCategory at all — drift checker uses old 5% global gate.
      // 0.5 → 0.4 (delta = -20%). Should fail under legacy gate.
      const baseline: BaselineFile = {
        prior: 0.5,
        current: 0.4,
        generated: '2026-05-06',
        corpus: { filesScanned: 1325, chunksUpserted: 28432 },
        knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: false },
        metrics: { recallAt5: 0.4 },
      }
      const result = checkHybridDrift(baseline, 0.5, 0.4)
      expect(result.pass).toBe(false)
      expect(result.message).toContain('>5%')
      expect(result.message).toContain('::error::')
    })

    it('byCategory present but recallAt5Prior null: falls back to legacy 5% gate', () => {
      // First run after Wave 1 — byCategory written but no per-category prior yet.
      // 0.5 → 0.45 (delta = -10%). Legacy 5% gate fails.
      const result = checkHybridDrift(hybridBaseline(0.5, 0.45, TODAY_PRIOR, null), 0.5, 0.45)
      expect(result.pass).toBe(false)
      expect(result.message).toContain('>5%')
    })

    it('all categories stable: hybrid passes', () => {
      // Identical per-category numbers; no drift anywhere.
      const result = checkHybridDrift(hybridBaseline(0.42, 0.42, TODAY_PRIOR), 0.42, 0.42)
      expect(result.pass).toBe(true)
      expect(result.message).toContain('hybrid threshold passed')
      expect(result.message).toContain('6 categories')
    })

    it('per-category improvement does not trip', () => {
      // All categories improve. No regression.
      const current: Record<string, number> = {}
      for (const [cat, v] of Object.entries(TODAY_PRIOR)) current[cat] = v + 0.05
      const result = checkHybridDrift(hybridBaseline(0.42, 0.47, current), 0.42, 0.47)
      expect(result.pass).toBe(true)
    })

    it('new category in current (not in prior) does not trip', () => {
      const current: Record<string, number> = { ...TODAY_PRIOR, 'new-category': 0.1 }
      const result = checkHybridDrift(hybridBaseline(0.42, 0.42, current), 0.42, 0.42)
      expect(result.pass).toBe(true)
    })

    it('high-N: implementation-lookup drops 1 hit (N=12) → fails', () => {
      // 1-hit floor for N=12 = 1/12 ≈ 0.08333. 5% rel = 0.0125. threshold = 0.08333.
      // Drop exactly 1 hit: 0.25 - 1/12 = 0.16666... (drop = 0.08333). Just trips.
      const current = { ...TODAY_PRIOR, 'implementation-lookup': 0.25 - 1 / 12 }
      const result = checkHybridDrift(hybridBaseline(0.42, 0.4, current), 0.42, 0.4)
      expect(result.pass).toBe(false)
      expect(result.message).toContain('implementation-lookup')
      expect(result.message).toContain('1/12')
    })

    it('integration via evaluateDrift: hybrid path triggers when ranking files + baseline both changed', () => {
      const changedFiles = [
        'packages/doc-retrieval-mcp/src/rerank.ts',
        'packages/doc-retrieval-mcp/eval/baseline.json',
      ]
      const current = { ...TODAY_PRIOR, 'memory-recall': 0.214 }
      const result = evaluateDrift(changedFiles, hybridBaseline(0.42, 0.41, current))
      expect(result.pass).toBe(false)
      expect(result.message).toContain('memory-recall')
    })

    it('integration via evaluateDrift: M1 first-real-run skip still works with byCategory present', () => {
      const changedFiles = ['packages/doc-retrieval-mcp/eval/baseline.json']
      const baseline = hybridBaseline(0.4, 0.4, TODAY_PRIOR)
      baseline.prior = null // first real-mode run
      const result = evaluateDrift(changedFiles, baseline)
      expect(result.pass).toBe(true)
      expect(result.message).toContain('prior is null')
    })
  })
})
