/**
 * SMI-4702 -- Unit tests for check-baseline-drift.ts
 *
 * Tests import `evaluateDrift` directly to avoid spawning subprocesses or
 * touching the filesystem. Git diff and baseline.json loading are exercised
 * via the exported function, not via the CLI entry point.
 */

import { describe, it, expect } from 'vitest'
import { evaluateDrift } from '../../eval/check-baseline-drift.js'
import type { BaselineFile } from '../../eval/check-baseline-drift.js'

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
})
