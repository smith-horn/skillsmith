/**
 * SMI-5879 Wave 3 item 4: smi5879-gate-check.ts test suite (part 1) —
 * preconditions, artifact/generation binding, and G-2/G-3/G-5. G-7/G-8
 * attestation, G-1 hand review, the full end-to-end PASS path, and §12.1's
 * dirty-worktree hardening live in the sibling
 * smi5879-gate-check.dispositions.test.ts (split — this file plus that one
 * together exceeded ~450 lines, matching item 3's precedent). G-2R's
 * three-phase reconciliation logic has its own sibling file,
 * smi5879-gate-check.g2r.test.ts. SMI-5879 Wave 1's
 * `computeFixtureCorpusCorroborationVerified` (the fixture-corpus
 * corroboration collection-signal function) has its own sibling file too,
 * smi5879-gate-check.closure-corroboration.test.ts — this file's own G-5
 * tests below only exercise `evaluateG5` against FAKE `StructuralClosureResult`
 * shapes, never that function directly.
 * @module scripts/tests/indexer/smi5879-gate-check
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.5, §12
 */

import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateGateCheck } from '../../indexer/smi5879-gate-check.ts'
import { bindSimulatorReportToPopulation } from '../../indexer/smi5879-gate-check.binding.ts'
import { evaluateG5 } from '../../indexer/smi5879-gate-check.gates.ts'
import type {
  GateResult,
  Smi5879SimulateFullReport,
} from '../../indexer/smi5879-gate-check.types.ts'
import type { SimSnapshotRow } from '../../indexer/smi5879-simulate-full.types.ts'
import {
  ALL_PASSING_INVARIANTS,
  DECISION_RUN_ID,
  SAMPLE_COMMIT,
  WINDOW_RUN_ID,
  buildReconciliationArgs,
  buildRequiredArgs,
  makeCensusReportJson,
  makeFakeDb,
  makeFakeTestDeps,
  makeRunSummary,
  makeScratchDir,
  makeSimRow,
  makeSimulatorReportJson,
  makeWindowCensusReportJson,
  populationFromSimRows,
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
        // Full I-1..I-5 set (finding #1's completeness check requires it) —
        // only I-1 fails, so this exercises the SAME "a failed invariant
        // short-circuits" behavior without tripping the completeness gate.
        invariants: [
          { id: 'I-1', name: 'totality', passed: false, detail: 'boom' },
          ...ALL_PASSING_INVARIANTS.slice(1),
        ],
      }),
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.preconditions_passed).toBe(false)
    expect(report.gates).toEqual([])
    expect(report.overall).toBe('INCONCLUSIVE')
    expect(report.precondition_failure_reason).toContain('I-1')
  })

  it('§12.1/finding #10: a thrown runStructuralClosureTests makes G-5 INCONCLUSIVE, not the whole evaluation reject', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const test = makeFakeTestDeps({
      async runStructuralClosureTests() {
        throw new Error('boom — dependency exploded')
      },
    })
    // MUST resolve to a real report, never reject.
    const report = await evaluateGateCheck({ db: makeFakeDb(), test }, args)
    expect(report.artifact_binding_ok).toBe(true)
    const g5 = findGate(report.gates, 'G-5')
    expect(g5.outcome).toBe('INCONCLUSIVE')
    expect(g5.reason).toMatch(/boom — dependency exploded/)
    // Every OTHER gate still evaluates normally — only G-5 is affected.
    expect(findGate(report.gates, 'G-2').outcome).toBe('PASS')
    expect(findGate(report.gates, 'G-3').outcome).toBe('PASS')
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
          fixtureCorpusCorroborationVerified: true,
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

  // -------------------------------------------------------------------------
  // SMI-6444 (plan Item 2): the simulator REPORT is authenticated against the
  // sealed population at gate-check time, not merely trusted because
  // merge-shards once proved it in a separate, earlier invocation.
  // -------------------------------------------------------------------------

  it('SMI-6444: a report with a row DELETED relative to the sealed population is rejected at binding', async () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1' }), makeSimRow({ id: 'r2' })]
    const args = buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) })
    // The sealed population has a third row the report never mentions.
    const population = [
      ...populationFromSimRows(rows),
      ...populationFromSimRows([makeSimRow({ id: 'r3' })]),
    ]
    const db = makeFakeDb({
      async loadCohortRows() {
        return population
      },
    })
    const report = await evaluateGateCheck({ db, test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/reported by NO shard/)
    expect(report.artifact_binding_reason).toMatch(/r3/)
    expect(report.gates).toEqual([])
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('SMI-6444: a report with a row ADDED relative to the sealed population is rejected at binding', async () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1' }), makeSimRow({ id: 'r2' })]
    const args = buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) })
    const db = makeFakeDb({
      async loadCohortRows() {
        return populationFromSimRows([makeSimRow({ id: 'r1' })])
      },
    })
    const report = await evaluateGateCheck({ db, test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/not present in the sealed population/)
    expect(report.artifact_binding_reason).toMatch(/r2/)
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('SMI-6444: a report row SUBSTITUTED for a real one (counts unchanged) is rejected at binding', async () => {
    const dir = makeScratchDir()
    // The exact case row-count arithmetic can never catch: same cohort, same
    // count, one id swapped for another.
    const rows = [makeSimRow({ id: 'r1' }), makeSimRow({ id: 'impostor' })]
    const args = buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) })
    const db = makeFakeDb({
      async loadCohortRows() {
        return populationFromSimRows([makeSimRow({ id: 'r1' }), makeSimRow({ id: 'r2' })])
      },
    })
    const report = await evaluateGateCheck({ db, test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/impostor/)
    expect(report.artifact_binding_reason).toMatch(/r2/)
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('SMI-6444: a row relabeled to a terminal outcome with its score fields left intact fails the reused coherence checks', async () => {
    const dir = makeScratchDir()
    // Structurally the relabeling tamper: `unfetchable` claimed, but the row
    // still carries the score fields only a SCORED outcome ever has.
    const rows = [
      {
        id: 'r1',
        cohort: 'C2',
        author: 'acme',
        name: 'r1',
        outcome: 'unfetchable',
        prePortQuarantine: false,
        postPortQuarantine: true,
        prePortRiskScore: 1,
        postPortRiskScore: 9,
      },
    ]
    const args = buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/NOT a scored outcome/)
    expect(report.artifact_binding_reason).toMatch(/r1/)
    expect(report.gates).toEqual([])
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('SMI-6444: an EMPTY sealed population is refused — it would vacuously "match" any report', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir, {
      simulatorJson: makeSimulatorReportJson({ rows: [] }),
    })
    const db = makeFakeDb({
      async loadCohortRows() {
        return []
      },
    })
    const report = await evaluateGateCheck({ db, test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/is empty \(zero C1-C4 rows\)/)
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('SMI-6444: the ordering guard is structural — an unbound or un-digest-verified generation refuses the check outright', async () => {
    const simReport = makeSimulatorReportJson({
      rows: [makeSimRow({ id: 'r1' })],
    }) as unknown as Smi5879SimulateFullReport
    let loadCalls = 0
    const db = {
      async loadCohortRows(): Promise<SimSnapshotRow[]> {
        loadCalls++
        return populationFromSimRows([makeSimRow({ id: 'r1' })])
      },
    }

    const unbound = await bindSimulatorReportToPopulation(
      db,
      {
        run_id: DECISION_RUN_ID,
        expected_purpose: 'decision',
        summary: null,
        digest_verified: null,
        bound: false,
        reason: 'no smi5879_run row',
      },
      simReport
    )
    expect(unbound.bound).toBe(false)
    expect(unbound.reason).toMatch(/generation binding is not verified/)

    // `bound: true` but digests never verified must ALSO refuse — the guard is
    // on `digest_verified === true`, not on `bound` alone.
    const unverified = await bindSimulatorReportToPopulation(
      db,
      {
        run_id: DECISION_RUN_ID,
        expected_purpose: 'decision',
        summary: makeRunSummary(),
        digest_verified: null,
        bound: true,
        reason: 'digests never checked',
      },
      simReport
    )
    expect(unverified.bound).toBe(false)
    expect(unverified.reason).toMatch(/digest_verified=null/)
    // Neither refusal may reach the population at all.
    expect(loadCalls).toBe(0)

    // The same report/population pair DOES bind once the generation is verified.
    const ok = await bindSimulatorReportToPopulation(
      db,
      {
        run_id: DECISION_RUN_ID,
        expected_purpose: 'decision',
        summary: makeRunSummary(),
        digest_verified: true,
        bound: true,
        reason: 'sealed and digests re-verify',
      },
      simReport
    )
    expect(ok.bound).toBe(true)
    expect(loadCalls).toBe(1)
  })
})

describe('smi5879-gate-check.ts — finding #2: window census report binding (reconciliation mode)', () => {
  it('a window census report whose run_id does not match --window-run-id is INCONCLUSIVE', async () => {
    const dir = makeScratchDir()
    const args = buildReconciliationArgs(dir, {
      windowRunId: WINDOW_RUN_ID,
      windowCensusJson: makeWindowCensusReportJson({ run_id: 'some-other-window-run-id' }),
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/window census report run_id/)
    expect(report.artifact_binding_reason).toMatch(/does not match --window-run-id/)
    expect(report.gates).toEqual([])
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('a window census report whose purpose is not "window" is INCONCLUSIVE', async () => {
    const dir = makeScratchDir()
    const args = buildReconciliationArgs(dir, {
      windowRunId: WINDOW_RUN_ID,
      // Wrong purpose but a valid I-1..I-5 set (avoids tripping finding #1's
      // completeness check instead of finding #2's binding check).
      windowCensusJson: makeWindowCensusReportJson({
        run_id: WINDOW_RUN_ID,
        purpose: 'decision',
        invariants: ALL_PASSING_INVARIANTS,
      }),
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/window census report purpose="decision"/)
  })

  it('a correctly-bound window census report proceeds past binding into gate evaluation', async () => {
    const dir = makeScratchDir()
    const args = buildReconciliationArgs(dir, { windowRunId: WINDOW_RUN_ID })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(true)
    expect(report.gates.length).toBeGreaterThan(0)
    // G-2R is evaluated (not the decision-mode NOT_APPLICABLE) once binding succeeds.
    expect(findGate(report.gates, 'G-2R').outcome).not.toBe('NOT_APPLICABLE')
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
    // 5 C1 rows, 2 unevaluable — matches the claimed coverage below so this
    // test isolates G-2's OWN "status:full but unevaluable>0" check rather
    // than tripping finding #7's coverage/rows cross-validation at load time.
    const rows = [
      makeSimRow({ id: 'r1', cohort: 'C1', outcome: 'unevaluable' }),
      makeSimRow({ id: 'r2', cohort: 'C1', outcome: 'unevaluable' }),
      makeSimRow({ id: 'r3', cohort: 'C1', outcome: 'unchanged_clean' }),
      makeSimRow({ id: 'r4', cohort: 'C1', outcome: 'unchanged_clean' }),
      makeSimRow({ id: 'r5', cohort: 'C1', outcome: 'unchanged_clean' }),
    ]
    const args = buildRequiredArgs(dir, {
      simulatorJson: makeSimulatorReportJson({
        rows,
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

    // But unevaluable > 0 in ANY cohort DOES block, distinctly from the two
    // above. 4 C1 rows recorded, 1 unevaluable — coverage is left to derive
    // from `rows` (SMI-6444: an explicit `total` that exceeds the reported
    // rows now describes a population the report doesn't cover, which
    // `bindSimulatorReportToPopulation` rejects before any gate runs; the
    // derived coverage still says status:'full' with unevaluable:1, which is
    // exactly the condition this half of the test is about).
    const rows2 = [
      makeSimRow({ id: 's1', cohort: 'C1', outcome: 'unevaluable' }),
      makeSimRow({ id: 's2', cohort: 'C1', outcome: 'unchanged_clean' }),
      makeSimRow({ id: 's3', cohort: 'C1', outcome: 'unchanged_clean' }),
      makeSimRow({ id: 's4', cohort: 'C1', outcome: 'unchanged_clean' }),
    ]
    const args2 = buildRequiredArgs(dir, {
      simulatorJson: makeSimulatorReportJson({ rows: rows2 }),
    })
    const report2 = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args2)
    expect(findGate(report2.gates, 'G-2').outcome).toBe('INCONCLUSIVE')
  })

  it('is INCONCLUSIVE when the tier-3 sweep hard-stopped on non-convergence', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir, {
      simulatorJson: makeSimulatorReportJson({
        // SMI-6444: at least one row, so the sealed population this report is
        // authenticated against isn't empty (an empty population is refused
        // outright, before any gate runs).
        rows: [makeSimRow({ id: 'r1' })],
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
    // Force a wrong-BUCKET mismatch (total stays 1, matching rows.length, so
    // this isolates G-3's OWN per-bucket check rather than finding #7's
    // load-time total-sum cross-validation): counts claims the row was
    // newly_cleared, not newly_quarantined, even though `rows` says otherwise.
    simJson['counts'] = {
      ...(simJson['counts'] as Record<string, number>),
      newly_quarantined: 0,
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
          fixtureCorpusCorroborationVerified: false,
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
          fixtureCorpusCorroborationVerified: true,
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

  it('a scored-outcome row missing its score fields is now rejected at binding, BEFORE G-5 (SMI-6444)', async () => {
    const dir = makeScratchDir()
    const rows = [
      { id: 'r1', cohort: 'C2', author: 'acme', name: 'r1', outcome: 'newly_quarantined' },
    ]
    const args = buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    // Before SMI-6444 this reached G-5 and surfaced as `missingScoreIds`.
    // `bindSimulatorReportToPopulation` now runs the outcome-coherence
    // asserts before any gate, so the same malformed row is caught strictly
    // earlier and more loudly — no gate is evaluated at all.
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/scored outcome/)
    expect(report.artifact_binding_reason).toMatch(/r1/)
    expect(report.gates).toEqual([])
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('SMI-6481: an incoherent bundle_absent row (quarantine booleans disagree) is rejected at binding, before any gate runs', async () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({
        id: 'r1',
        outcome: 'bundle_absent',
        prePortQuarantine: true,
        postPortQuarantine: false,
      }),
    ]
    const args = buildRequiredArgs(dir, { simulatorJson: makeSimulatorReportJson({ rows }) })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    expect(report.artifact_binding_ok).toBe(false)
    expect(report.artifact_binding_reason).toMatch(/bundle_absent/)
    expect(report.artifact_binding_reason).toMatch(/r1/)
    // Unique to assertBundleAbsentCoherence's own thrown message — proves
    // THIS check (not assertRowOutcomeFieldPresence, whose message also
    // mentions "bundle_absent" and could name "r1") is what caught it.
    expect(report.artifact_binding_reason).toMatch(/is a real verdict change/)
    expect(report.gates).toEqual([])
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it("G-5's own missing-score-field detection still holds (never silently skipped), evaluated directly", () => {
    // Retained as direct `evaluateG5` coverage: the end-to-end path above can
    // no longer reach G-5 with such a row, but G-5 must still refuse one if it
    // ever sees it — that guarantee is independent of what binds first.
    const simReport = makeSimulatorReportJson({
      rows: [{ id: 'r1', cohort: 'C2', author: 'acme', name: 'r1', outcome: 'newly_quarantined' }],
    }) as unknown as Smi5879SimulateFullReport
    const g5 = evaluateG5(
      false,
      {
        ran: true,
        passed: true,
        baseline_commit: SAMPLE_COMMIT,
        unavailable_reason: null,
        fixtureCorpusCorroborationVerified: true,
      },
      simReport
    )
    expect(g5.outcome).toBe('INCONCLUSIVE')
    expect(g5.detail?.['missingScoreIds']).toContain('r1')
  })

  it("finding #3: is INCONCLUSIVE, not PASS, when fixture-corpus RiskScoreBreakdown corroboration evidence is unavailable — a real failure mode of the SMI-5879 Wave 1 producer, not production's permanent state", async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    // Before SMI-5879 Wave 1, `fixtureCorpusCorroborationVerified` was a
    // permanent `false` literal (no producing artifact existed) and this
    // scenario used to silently PASS. A producer now exists
    // (`packages/core/tests/security/smi5879-corroboration.core.test.ts`,
    // `scripts/tests/indexer/smi5879-corroboration.edge.test.ts`,
    // collected via `computeFixtureCorpusCorroborationVerified` — see the
    // `smi5879-corroboration.closure.test.ts`-equivalent coverage of THAT
    // function directly, below) — this test now exercises one real way the
    // flag can still come back `false` (a sentinel/file shortfall), not the
    // only way it ever can.
    const test = makeFakeTestDeps({
      async runStructuralClosureTests() {
        return {
          ran: true,
          passed: true,
          baseline_commit: SAMPLE_COMMIT,
          unavailable_reason:
            'corroboration sentinel assertion missing or not passed: some/file.test.ts :: some assertion',
          fixtureCorpusCorroborationVerified: false,
        }
      },
    })
    const report = await evaluateGateCheck({ db: makeFakeDb(), test }, args)
    const g5 = findGate(report.gates, 'G-5')
    expect(g5.outcome).toBe('INCONCLUSIVE')
    expect(g5.reason).toMatch(/RiskScoreBreakdown/)
    expect(g5.reason).toMatch(/both halves/i)
    // The specific unavailable_reason must be threaded through, not dropped
    // (§6 point 4: distinguishes "corroboration failed" from "corroboration
    // never ran").
    expect(g5.reason).toMatch(/sentinel assertion missing or not passed/)
    expect(g5.detail?.['unavailable_reason']).toMatch(/sentinel assertion missing or not passed/)
    expect(report.overall).toBe('INCONCLUSIVE')
  })

  it('PASSes only when fixture-corpus corroboration evidence IS available (both halves of §8.5 G-5 satisfied)', async () => {
    const dir = makeScratchDir()
    const args = buildRequiredArgs(dir)
    const report = await evaluateGateCheck({ db: makeFakeDb(), test: makeFakeTestDeps() }, args)
    const g5 = findGate(report.gates, 'G-5')
    expect(g5.outcome).toBe('PASS')
    expect(g5.reason).toMatch(/RiskScoreBreakdown/)
    expect(g5.reason).toMatch(/both halves/i)
  })
})
