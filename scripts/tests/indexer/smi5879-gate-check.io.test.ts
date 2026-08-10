/**
 * SMI-5879 Wave 3 item 4: smi5879-gate-check.io.ts test suite — direct unit
 * tests of the two report loaders' internal-consistency validation added by
 * the adversarial review: finding #1 (census report invariant-set
 * completeness) and finding #7 (simulator report coverage/rows/counts
 * cross-validation). Exercises `loadCensusReport`/`loadSimulatorReport`
 * directly rather than through the full `evaluateGateCheck` orchestrator —
 * faster, and pinpoints the exact validation this file owns.
 * @module scripts/tests/indexer/smi5879-gate-check.io
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.5, §12
 */

import { describe, it, expect } from 'vitest'
import { loadCensusReport, loadSimulatorReport } from '../../indexer/smi5879-gate-check.io.ts'
import {
  ALL_PASSING_INVARIANTS,
  makeCensusReportJson,
  makeCoverage,
  makeInvariant,
  makeScratchDir,
  makeSimRow,
  makeSimulatorReportJson,
  makeWindowCensusReportJson,
  writeFixtureFile,
} from './smi5879-gate-check.fixtures.ts'

describe('smi5879-gate-check.io.ts — finding #1: census report invariant-set completeness', () => {
  it('a well-formed decision census report (all 5 invariants) loads ok', () => {
    const dir = makeScratchDir()
    const path = writeFixtureFile(dir, 'census.json', makeCensusReportJson())
    const result = loadCensusReport(path, 'census-report')
    expect(result.status).toBe('ok')
  })

  it('a well-formed window census report (4 invariants, no I-5) loads ok', () => {
    const dir = makeScratchDir()
    const path = writeFixtureFile(dir, 'window-census.json', makeWindowCensusReportJson())
    const result = loadCensusReport(path, 'window-census-report')
    expect(result.status).toBe('ok')
  })

  it('an EMPTY invariants array is malformed, never a vacuous pass', () => {
    const dir = makeScratchDir()
    const path = writeFixtureFile(dir, 'census.json', makeCensusReportJson({ invariants: [] }))
    const result = loadCensusReport(path, 'census-report')
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.reason).toMatch(/missing: I-1, I-2, I-3, I-4, I-5/)
    }
  })

  it('a decision census report missing I-5 is malformed (I-5 is required for a fetching generation)', () => {
    const dir = makeScratchDir()
    const path = writeFixtureFile(
      dir,
      'census.json',
      makeCensusReportJson({ invariants: ALL_PASSING_INVARIANTS.slice(0, 4) })
    )
    const result = loadCensusReport(path, 'census-report')
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.reason).toMatch(/missing: I-5/)
    }
  })

  it('a duplicate invariant id is malformed, even when every id is otherwise present', () => {
    const dir = makeScratchDir()
    const path = writeFixtureFile(
      dir,
      'census.json',
      makeCensusReportJson({
        invariants: [...ALL_PASSING_INVARIANTS, makeInvariant({ id: 'I-1', name: 'totality' })],
      })
    )
    const result = loadCensusReport(path, 'census-report')
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.reason).toMatch(/duplicated: I-1/)
    }
  })

  it('a window census report carrying I-5 is malformed (unexpected — I-5 never applies to a window generation)', () => {
    const dir = makeScratchDir()
    const path = writeFixtureFile(
      dir,
      'window-census.json',
      makeWindowCensusReportJson({ invariants: ALL_PASSING_INVARIANTS })
    )
    const result = loadCensusReport(path, 'window-census-report')
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.reason).toMatch(/unexpected \(not valid for purpose="window"\): I-5/)
    }
  })
})

describe('smi5879-gate-check.io.ts — finding #7: simulator report internal consistency', () => {
  it('a well-formed, internally-consistent simulator report loads ok', () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({ id: 'r1', cohort: 'C1', outcome: 'unchanged_clean' }),
      makeSimRow({ id: 'r2', cohort: 'C2', outcome: 'unevaluable' }),
    ]
    const coverage = {
      C1: makeCoverage({ scanned: 1, total: 1 }),
      C2: makeCoverage({ scanned: 1, total: 1, unevaluable: 1 }),
      C3: makeCoverage(),
      C4: makeCoverage(),
    }
    const path = writeFixtureFile(
      dir,
      'simulator.json',
      makeSimulatorReportJson({ rows, coverage })
    )
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('ok')
  })

  it('rows.length disagreeing with the sum of counts is malformed (truncated/tampered report)', () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', outcome: 'newly_quarantined' })]
    const simJson = makeSimulatorReportJson({ rows })
    // Tamper: counts claims TWO newly_quarantined rows, but only one row exists.
    simJson['counts'] = {
      ...(simJson['counts'] as Record<string, number>),
      newly_quarantined: 2,
    }
    const path = writeFixtureFile(dir, 'simulator.json', simJson)
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.reason).toMatch(/counts sums to 2.*rows\.length is 1/)
    }
  })

  it('coverage.<cohort>.scanned disagreeing with the actual row count for that cohort is malformed', () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', cohort: 'C1', outcome: 'unchanged_clean' })]
    const coverage = {
      // Claims 5 scanned in C1 even though only 1 C1 row exists in `rows`.
      C1: makeCoverage({ scanned: 5, total: 5 }),
      C2: makeCoverage(),
      C3: makeCoverage(),
      C4: makeCoverage(),
    }
    const path = writeFixtureFile(
      dir,
      'simulator.json',
      makeSimulatorReportJson({ rows, coverage })
    )
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.reason).toMatch(/coverage\.C1\.scanned=5 does not equal/)
    }
  })

  it('coverage.<cohort>.unevaluable disagreeing with the actual unevaluable row count is malformed', () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', cohort: 'C2', outcome: 'unevaluable' })]
    const coverage = {
      C1: makeCoverage(),
      // Claims 0 unevaluable even though the one C2 row IS unevaluable.
      C2: makeCoverage({ scanned: 1, total: 1, unevaluable: 0 }),
      C3: makeCoverage(),
      C4: makeCoverage(),
    }
    const path = writeFixtureFile(
      dir,
      'simulator.json',
      makeSimulatorReportJson({ rows, coverage })
    )
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.reason).toMatch(/coverage\.C2\.unevaluable=0 does not equal/)
    }
  })

  it('coverage.<cohort>.unfetchable disagreeing with the actual unfetchable row count is malformed', () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', cohort: 'C3', outcome: 'unfetchable' })]
    const coverage = {
      C1: makeCoverage(),
      C2: makeCoverage(),
      // Claims 0 unfetchable even though the one C3 row IS unfetchable.
      C3: makeCoverage({ scanned: 1, total: 1, unfetchable: 0 }),
      C4: makeCoverage(),
    }
    const path = writeFixtureFile(
      dir,
      'simulator.json',
      makeSimulatorReportJson({ rows, coverage })
    )
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.reason).toMatch(/coverage\.C3\.unfetchable=0 does not equal/)
    }
  })

  it('a truncated rows array with unmodified coverage/counts (the exact tamper shape G-2/G-3 alone would miss) is malformed', () => {
    const dir = makeScratchDir()
    // Report CLAIMS full coverage over 100 C1 rows via `coverage`, and
    // `counts` was left at the (larger) original totals, but `rows` itself
    // was truncated to a single row — G-2 only reads `coverage` and G-3 only
    // reads two of the eight `counts` buckets, so this passes both of THOSE
    // checks in isolation; only the cross-validation here catches it.
    const rows = [makeSimRow({ id: 'r1', cohort: 'C1', outcome: 'unchanged_clean' })]
    const simJson = makeSimulatorReportJson({
      rows,
      coverage: {
        C1: makeCoverage({ scanned: 100, total: 100 }),
        C2: makeCoverage(),
        C3: makeCoverage(),
        C4: makeCoverage(),
      },
    })
    simJson['counts'] = {
      ...(simJson['counts'] as Record<string, number>),
      unchanged_clean: 100,
    }
    const path = writeFixtureFile(dir, 'simulator.json', simJson)
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('malformed')
  })
})
