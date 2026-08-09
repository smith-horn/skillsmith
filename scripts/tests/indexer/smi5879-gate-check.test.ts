/**
 * SMI-5879 Wave 3 item 4: smi5879-gate-check.ts test suite (part 1) —
 * preconditions, artifact/generation binding, and G-2/G-3/G-5. G-7/G-8
 * attestation, G-1 hand review, the full end-to-end PASS path, and §12.1's
 * dirty-worktree hardening live in the sibling
 * smi5879-gate-check.dispositions.test.ts (split — this file plus that one
 * together exceeded ~450 lines, matching item 3's precedent). G-2R's
 * three-phase reconciliation logic has its own sibling file,
 * smi5879-gate-check.g2r.test.ts.
 * @module scripts/tests/indexer/smi5879-gate-check
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.5, §12
 */

import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateGateCheck } from '../../indexer/smi5879-gate-check.ts'
import type { GateResult } from '../../indexer/smi5879-gate-check.types.ts'
import {
  DECISION_RUN_ID,
  SAMPLE_COMMIT,
  buildRequiredArgs,
  makeCensusReportJson,
  makeFakeDb,
  makeFakeTestDeps,
  makeScratchDir,
  makeSimRow,
  makeSimulatorReportJson,
} from './smi5879-gate-check.fixtures.ts'

function findGate(gates: readonly GateResult[], id: string): GateResult {
  const gate = gates.find((g) => g.id === id)
  if (!gate) throw new Error(`gate ${id} not found in report.gates`)
  return gate
}

describe('smi5879-gate-check.ts — preconditions and artifact/generation binding', () => {
  it('a failed I-invariant short-circuits the WHOLE run — no gate is evaluated', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir, {
      censusJson: makeCensusReportJson({
        invariants: [{ id: 'I-1', name: 'totality', passed: false, detail: 'boom' }],
      }),
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.preconditions_passed).toBe(false)
    expect(report.gates).toEqual([])
    expect(report.overall).toBe('INCONCLUSIVE')
    expect(report.precondition_failure_reason).toContain('I-1')
  })

  it('a missing census report file is INCONCLUSIVE, not a thrown error', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const report = await evaluateGateCheck(
      { db: makeFakeDb(), test: makeFakeTestDeps() },
      { ...args, censusReportPath: join(dir, 'does-not-exist.json') }
    )
    expect(report.overall).toBe('INCONCLUSIVE')
    expect(report.precondition_failure_reason).toMatch(/unavailable/)
  })

  it('a malformed simulator report (bad JSON) is INCONCLUSIVE', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    writeFileSync(args.simulatorReportPath, '{ this is not valid json')
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.overall).toBe('INCONCLUSIVE')
    expect(report.artifact_binding_reason).toMatch(/simulator report unavailable/)
  })

  it('artifact binding: mismatched run_id across census/simulator reports short-circuits', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir, {
      simulatorJson: makeSimulatorReportJson({ run_id: 'some-other-run-id' }),
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/run_id mismatch/)
    expect(report.gates).toEqual([])
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('artifact binding: closure test baseline_commit mismatch short-circuits (§12.1)', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const test = makeFakeTestDeps({
      async runStructuralClosureTests() {
        return {
          ran: true,
          passed: true,
          baseline_commit: 'a-totally-different-sha',
          unavailable_reason: null,
        }
      },
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/baseline_commit/)
    expect(report.gates).toEqual([])
  })

  it('--skip-closure-tests skips the baseline_commit binding check but still evaluates other gates', async () => {
    const dir = makeScratchDir()
    const args = { ...buildRequiredArgs(dir), skipClosureTests: true }
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(true)
    expect(report.gates.length).toBeGreaterThan(0)
    // G-5 itself is forced INCONCLUSIVE and can NEVER be PASS under this flag.
    expect(findGate(report.gates, 'G-5').outcome).toBe('INCONCLUSIVE')
    expect(findGate(report.gates, 'G-5').reason).toMatch(/--skip-closure-tests/)
    // The overriding rule: this flag can NEVER produce an overall PASS.
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('per-generation binding: unsealed decision generation is rejected', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const db = makeFakeDb({
      async getRunSummary(runId) {
        if (runId !== DECISION_RUN_ID) return null
        return {
          run_id: DECISION_RUN_ID,
          purpose: 'decision',
          status: 'open',
          ruleset_epoch: '2026-07-29T23:41:09.000000Z',
          snapshot_started_at: '2026-07-29T20:15:00.000000Z',
          snapshot_sealed_at: null,
          row_count: null,
          population_digest: null,
          branch_digest: null,
        }
      },
    })
    const report = await evaluateGateCheck({ db, test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/not "sealed"/)
  })

  it('per-generation binding: a rehearsal generation offered as decision is rejected', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const db = makeFakeDb({
      async getRunSummary(runId) {
        if (runId !== DECISION_RUN_ID) return null
        return {
          run_id: DECISION_RUN_ID,
          purpose: 'rehearsal',
          status: 'sealed',
          ruleset_epoch: '2026-07-29T23:41:09.000000Z',
          snapshot_started_at: '2026-07-29T20:15:00.000000Z',
          snapshot_sealed_at: '2026-07-29T20:20:00.000000Z',
          row_count: 100,
          population_digest: 'd',
          branch_digest: 'd',
        }
      },
    })
    const report = await evaluateGateCheck({ db, test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/rehearsal generation can never satisfy a gate/)
  })

  it('per-generation binding: failed digest re-verification is rejected', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const db = makeFakeDb({
      async verifyDigest() {
        return { populationMatches: false, branchMatches: true }
      },
    })
    const report = await evaluateGateCheck({ db, test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/digest re-verification/)
  })
})

describe('smi5879-gate-check.ts — G-2 coverage', () => {
  it('PASSes when every cohort is full with zero unevaluable', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-2').outcome).toBe('PASS')
  })

  it('is INCONCLUSIVE when coverage.status is "full" but unevaluable > 0 (never trust the label alone)', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir, {
      simulatorJson: makeSimulatorReportJson({
        coverage: {
          C1: { status: 'full', scanned: 5, total: 5, unevaluable: 2, unfetchable: 0 },
          C2: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
          C3: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
          C4: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
        },
      }),
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-2').outcome).toBe('INCONCLUSIVE')
  })

  it('unevaluable/unfetchable/bundle_absent three-way blocking asymmetry', async () => {
    const dir = makeScratchDir()
    // unfetchable rows present, full coverage, zero unevaluable -> G-2 still PASSes
    // (unfetchable does NOT block; bundle_absent does not block either).
    const rows = [
      makeSimRow({ id: 'r1', cohort: 'C2', outcome: 'unfetchable' }),
      makeSimRow({ id: 'r2', cohort: 'C2', outcome: 'bundle_absent' }),
    ]
    const args = buildRequiredArgs(dir, {
      simulatorJson: makeSimulatorReportJson({
        rows,
        coverage: {
          C1: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
          C2: { status: 'full', scanned: 2, total: 2, unevaluable: 0, unfetchable: 1 },
          C3: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
          C4: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
        },
      }),
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-2').outcome).toBe('PASS')

    // But unevaluable > 0 in ANY cohort DOES block, distinctly from the two above.
    const args2 = buildRequiredArgs(dir, {
      simulatorJson: makeSimulatorReportJson({
        coverage: {
          C1: { status: 'partial', scanned: 4, total: 5, unevaluable: 1, unfetchable: 0 },
          C2: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
          C3: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
          C4: { status: 'full', scanned: 0, total: 0, unevaluable: 0, unfetchable: 0 },
        },
      }),
    })
    const report2 = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args2)
    expect(findGate(report2.gates, 'G-2').outcome).toBe('INCONCLUSIVE')
  })

  it('is INCONCLUSIVE when the tier-3 sweep hard-stopped on non-convergence', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir, {
      simulatorJson: makeSimulatorReportJson({
        sweep: { passes_run: 8, hard_stopped: 'non_convergence' },
      }),
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-2').outcome).toBe('INCONCLUSIVE')
  })
})

describe('smi5879-gate-check.ts — G-3 two-sided reporting', () => {
  it('PASSes when both directions are represented and internally consistent', async () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({ id: 'r1', outcome: 'newly_quarantined' }),
      makeSimRow({ id: 'r2', outcome: 'newly_cleared' }),
    ]
    const args = buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-3').outcome).toBe('PASS')
  })

  it('is INCONCLUSIVE when report.counts disagrees with report.rows (a direction silently dropped)', async () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', outcome: 'newly_quarantined' })]
    const simJson = makeSimulatorReportJson({ rows })
    // Force a mismatch: counts CLAIMS a newly_cleared row that isn't in `rows`.
    simJson['counts'] = {
      ...(simJson['counts'] as Record<string, number>),
      newly_cleared: 1,
    }
    const args = buildRequiredArgs(dir, { simulatorJson: simJson })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-3').outcome).toBe('INCONCLUSIVE')
  })
})

describe('smi5879-gate-check.ts — G-5 structural closure + delta bound', () => {
  it('is INCONCLUSIVE when the closure test did not run', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const test = makeFakeTestDeps({
      async runStructuralClosureTests() {
        return {
          ran: false,
          passed: false,
          baseline_commit: SAMPLE_COMMIT,
          unavailable_reason: 'spawn error',
        }
      },
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test }, args)
    expect(findGate(report.gates, 'G-5').outcome).toBe('INCONCLUSIVE')
    expect(findGate(report.gates, 'G-5').reason).toMatch(/spawn error/)
  })

  it('is INCONCLUSIVE when the closure test ran but FAILED', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const test = makeFakeTestDeps({
      async runStructuralClosureTests() {
        return {
          ran: true,
          passed: false,
          baseline_commit: SAMPLE_COMMIT,
          unavailable_reason: null,
        }
      },
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test }, args)
    expect(findGate(report.gates, 'G-5').outcome).toBe('INCONCLUSIVE')
  })

  it('is INCONCLUSIVE when a row breaches the +32 delta bound', async () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({
        id: 'r1',
        outcome: 'newly_quarantined',
        prePortRiskScore: 5,
        postPortRiskScore: 40,
      }),
    ]
    const args = buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-5').outcome).toBe('INCONCLUSIVE')
    expect(findGate(report.gates, 'G-5').detail?.['violations']).toHaveLength(1)
  })

  it('is INCONCLUSIVE when a scored-outcome row is missing its score fields (never silently skipped)', async () => {
    const dir = makeScratchDir()
    const rows = [
      { id: 'r1', cohort: 'C2', author: 'acme', name: 'r1', outcome: 'newly_quarantined' },
    ]
    const args = buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(findGate(report.gates, 'G-5').outcome).toBe('INCONCLUSIVE')
    expect(findGate(report.gates, 'G-5').detail?.['missingScoreIds']).toContain('r1')
  })

  it('PASSes and its reason discloses the fixture-corpus corroboration is not independently re-run (documented judgment call)', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    const g5 = findGate(report.gates, 'G-5')
    expect(g5.outcome).toBe('PASS')
    expect(g5.reason).toMatch(/RiskScoreBreakdown/)
    expect(g5.reason).toMatch(/preflight\/CI/)
  })
})
