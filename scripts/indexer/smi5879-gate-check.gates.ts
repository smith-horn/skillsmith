/**
 * G-1, G-2, G-3, G-5 evaluators (design doc §8.5, corrected by §12). G-7/G-8
 * live in the sibling `smi5879-gate-check.gates.attestation.ts` (split out,
 * CLAUDE.md's <500-line-per-file convention) and are re-exported below so
 * existing `from './smi5879-gate-check.gates.ts'` imports keep working. G-2R
 * lives in `smi5879-gate-check.g2r.ts` (own file — three short-circuiting
 * phases, materially more code than any of these).
 * @module scripts/indexer/smi5879-gate-check.gates
 */

import { checkDeltaBound, computeR, type ResolvedLedger } from './smi5879-gate-check.helpers.ts'
import {
  DRIFT_CLASSES_REQUIRING_EXCLUSION,
  type DriftRow,
  type GateResult,
  type Smi5879GateCheckMode,
  type Smi5879SimulateFullReport,
  type StructuralClosureResult,
} from './smi5879-gate-check.types.ts'
import type { SimulatedCohort } from './smi5879-simulate-full.types.ts'

export { evaluateG7, evaluateG8 } from './smi5879-gate-check.gates.attestation.ts'

const SIMULATED_COHORTS: readonly SimulatedCohort[] = ['C1', 'C2', 'C3', 'C4']

// ---------------------------------------------------------------------------
// G-2 — coverage (decision generation only)
// ---------------------------------------------------------------------------

export function evaluateG2(
  simReport: Smi5879SimulateFullReport,
  decisionRunId: string
): GateResult {
  if (simReport.report_kind !== 'full_simulation') {
    return {
      id: 'G-2',
      outcome: 'INCONCLUSIVE',
      reason: `simulator report_kind="${simReport.report_kind}" is not "full_simulation"`,
    }
  }
  if (simReport.run_id !== decisionRunId) {
    return {
      id: 'G-2',
      outcome: 'INCONCLUSIVE',
      reason:
        `simulator report run_id="${simReport.run_id}" does not match the decision generation ` +
        `run_id="${decisionRunId}"`,
    }
  }
  if (simReport.purpose !== 'decision') {
    return {
      id: 'G-2',
      outcome: 'INCONCLUSIVE',
      reason: `simulator report purpose="${simReport.purpose}" — G-2 is evaluated only against the decision generation`,
    }
  }
  if (simReport.sweep.hard_stopped !== null) {
    return {
      id: 'G-2',
      outcome: 'INCONCLUSIVE',
      reason: `tier-3 sweep hard-stopped (${simReport.sweep.hard_stopped}) — non-convergence`,
    }
  }

  const partial: string[] = []
  const unevaluableNonzero: string[] = []
  for (const cohort of SIMULATED_COHORTS) {
    const c = simReport.coverage[cohort]
    // Independently verify BOTH the label and the underlying count — "coverage: full alone
    // only proves every row was attempted" (design doc §8.5). A malformed/hand-edited report
    // could set status:'full' while unevaluable>0; never trust the label alone.
    if (c.status !== 'full') partial.push(cohort)
    if (c.unevaluable !== 0) unevaluableNonzero.push(cohort)
  }
  if (partial.length > 0 || unevaluableNonzero.length > 0) {
    return {
      id: 'G-2',
      outcome: 'INCONCLUSIVE',
      reason:
        'coverage is not full-and-zero-unevaluable for every cohort — ' +
        `partial: [${partial.join(', ') || 'none'}], unevaluable>0: [${unevaluableNonzero.join(', ') || 'none'}]. ` +
        'unfetchable and bundle_absent rows do NOT block this gate.',
      detail: { partial, unevaluableNonzero },
    }
  }
  return {
    id: 'G-2',
    outcome: 'PASS',
    reason: 'coverage full and zero unevaluable rows across C1-C4 (decision generation)',
  }
}

// ---------------------------------------------------------------------------
// G-3 — two-sided reporting
// ---------------------------------------------------------------------------

export function evaluateG3(simReport: Smi5879SimulateFullReport): GateResult {
  if (!Array.isArray(simReport.rows)) {
    return {
      id: 'G-3',
      outcome: 'INCONCLUSIVE',
      reason: 'simulator report.rows is not an array — cannot represent either direction',
    }
  }
  const counts = simReport.counts
  if (
    !counts ||
    typeof counts.newly_quarantined !== 'number' ||
    typeof counts.newly_cleared !== 'number'
  ) {
    return {
      id: 'G-3',
      outcome: 'INCONCLUSIVE',
      reason:
        'simulator report.counts is missing newly_quarantined/newly_cleared — report format ' +
        'cannot represent both directions',
    }
  }
  const actualQuarantined = simReport.rows.filter((r) => r.outcome === 'newly_quarantined').length
  const actualCleared = simReport.rows.filter((r) => r.outcome === 'newly_cleared').length
  if (actualQuarantined !== counts.newly_quarantined || actualCleared !== counts.newly_cleared) {
    return {
      id: 'G-3',
      outcome: 'INCONCLUSIVE',
      reason:
        `report.counts disagrees with report.rows — counts said newly_quarantined=` +
        `${counts.newly_quarantined}/newly_cleared=${counts.newly_cleared} but rows contained ` +
        `${actualQuarantined}/${actualCleared}; one direction may have been silently dropped`,
      detail: { counts, actualQuarantined, actualCleared },
    }
  }
  return {
    id: 'G-3',
    outcome: 'PASS',
    reason: `both directions represented and internally consistent (newly_quarantined=${actualQuarantined}, newly_cleared=${actualCleared})`,
  }
}

// ---------------------------------------------------------------------------
// G-5 — structural closure test + +32 delta-bound corroboration
// ---------------------------------------------------------------------------

/**
 * FIX (finding #3, adversarial review — supersedes the prior "judgment
 * call" note below the fold): design doc §8.5's G-5 row is explicit —
 * "**Both halves block merge uniformly**" — the structural closure test AND
 * the fixture-corpus corroboration check (§8.3.1.2.4's THIRD bullet, "no
 * non-AI RiskScoreBreakdown key changes over the fixture corpus"). The three
 * ORIGINAL closure test files (item 2, first three entries of
 * `CLOSURE_TEST_FILES` in `smi5879-gate-check.closure.ts`) are each a pure
 * AST/structural routing census, "fixture-free by design" per their own
 * module docs — none of them runs a fixture corpus through the scanner and
 * diffs `RiskScoreBreakdown` keys, which is why this corroboration evidence
 * was genuinely unavailable when this comment was first written.
 *
 * SMI-5879 Wave 1 built the producer: two more `CLOSURE_TEST_FILES` entries
 * (`packages/core/tests/security/smi5879-corroboration.core.test.ts`,
 * `scripts/tests/indexer/smi5879-corroboration.edge.test.ts`) DO run the
 * shared fixture corpus through both scanners and diff every non-AI
 * `RiskScoreBreakdown`/category key against a pinned pre-port golden — see
 * `docs/internal/implementation/smi-5879-g5-corroboration-spec.md`. G-5
 * remains INCONCLUSIVE whenever `!closure.fixtureCorpusCorroborationVerified`
 * — that boolean is now a real, computed result
 * (`computeFixtureCorpusCorroborationVerified`,
 * `smi5879-gate-check.closure.ts`), not a permanent stub; see that field's
 * doc comment in `smi5879-gate-check.types.ts` for exactly what it verifies.
 */
export function evaluateG5(
  skipClosureTests: boolean,
  closure: StructuralClosureResult | null,
  simReport: Smi5879SimulateFullReport
): GateResult {
  if (skipClosureTests) {
    return {
      id: 'G-5',
      outcome: 'INCONCLUSIVE',
      reason:
        'closure tests skipped via --skip-closure-tests — this flag can NEVER produce an overall PASS',
    }
  }
  if (!closure) {
    return {
      id: 'G-5',
      outcome: 'INCONCLUSIVE',
      reason:
        'structural closure test result unavailable (internal error — closure was never evaluated)',
    }
  }
  if (!closure.ran) {
    return {
      id: 'G-5',
      outcome: 'INCONCLUSIVE',
      reason: `structural closure test did not run: ${closure.unavailable_reason ?? '(no reason recorded)'}`,
    }
  }
  if (closure.baseline_commit !== simReport.baseline_commit) {
    return {
      id: 'G-5',
      outcome: 'INCONCLUSIVE',
      reason:
        `structural closure test baseline_commit="${closure.baseline_commit}" does not match ` +
        `simulator report baseline_commit="${simReport.baseline_commit}" (§12.1 binding)`,
    }
  }
  if (!closure.passed) {
    return {
      id: 'G-5',
      outcome: 'INCONCLUSIVE',
      reason:
        'structural closure test FAILED — cohort E cannot be excluded, the census is incomplete',
    }
  }
  const bound = checkDeltaBound(simReport.rows)
  if (!bound.ok) {
    return {
      id: 'G-5',
      outcome: 'INCONCLUSIVE',
      reason:
        `+32 delta-bound corroboration failed — ${bound.violations.length} row(s) exceeded +32, ` +
        `${bound.missingScoreIds.length} scored-outcome row(s) missing score fields`,
      detail: { violations: bound.violations, missingScoreIds: bound.missingScoreIds },
    }
  }
  if (!closure.fixtureCorpusCorroborationVerified) {
    return {
      id: 'G-5',
      outcome: 'INCONCLUSIVE',
      reason:
        'fixture-corpus RiskScoreBreakdown-key corroboration (design doc §8.3.1.2.4, third ' +
        'bullet) did not verify' +
        (closure.unavailable_reason ? `: ${closure.unavailable_reason}` : '') +
        '. §8.5 G-5 requires "both halves" (structural closure test AND this corroboration) to ' +
        'block merge uniformly; the structural closure test and the +32 bound alone are NOT ' +
        'sufficient for a PASS',
      ...(closure.unavailable_reason
        ? { detail: { unavailable_reason: closure.unavailable_reason } }
        : {}),
    }
  }
  return {
    id: 'G-5',
    outcome: 'PASS',
    reason:
      `structural closure test passed (baseline_commit=${closure.baseline_commit}), every ` +
      "simulated row's delta <= +32, and fixture-corpus RiskScoreBreakdown-key corroboration " +
      '(design doc §8.3.1.2.4) verified — both halves of G-5 satisfied',
  }
}

// ---------------------------------------------------------------------------
// G-1 — hand review (evaluated LAST — depends on G-2 and G-2R)
// ---------------------------------------------------------------------------

export function evaluateG1(
  mode: Smi5879GateCheckMode,
  simReport: Smi5879SimulateFullReport,
  ledger: ResolvedLedger,
  g2Result: GateResult,
  g2rResult: GateResult,
  g2rDriftRows: readonly DriftRow[]
): GateResult {
  if (ledger.loadFailureReason !== null) {
    return {
      id: 'G-1',
      outcome: 'INCONCLUSIVE',
      reason: `disposition ledger unavailable: ${ledger.loadFailureReason}`,
    }
  }
  if (!ledger.validation.valid) {
    return {
      id: 'G-1',
      outcome: 'INCONCLUSIVE',
      reason:
        `disposition ledger has conflicting verdicts for id(s): ` +
        `${ledger.validation.conflictingIds.join(', ')} — never resolved by last-write-wins`,
      detail: { conflictingIds: ledger.validation.conflictingIds },
    }
  }

  if (g2Result.outcome !== 'PASS') {
    return {
      id: 'G-1',
      outcome: 'INCONCLUSIVE',
      reason: `R cannot yet be computed because G-2 has not passed (G-2: ${g2Result.outcome} — ${g2Result.reason})`,
    }
  }
  if (mode === 'reconciliation' && g2rResult.outcome !== 'PASS') {
    return {
      id: 'G-1',
      outcome: 'INCONCLUSIVE',
      reason:
        `drift-exclusion completeness cannot yet be verified because G-2R has not passed ` +
        `(G-2R: ${g2rResult.outcome} — ${g2rResult.reason})`,
    }
  }

  const R = computeR(simReport.rows)
  const missingRDispositions = R.filter((r) => !ledger.validation.byId.has(r.id)).map((r) => r.id)

  const unfetchableRows = simReport.rows.filter((r) => r.outcome === 'unfetchable')
  const missingUnfetchableExcludes = unfetchableRows
    .filter((r) => ledger.validation.byId.get(r.id) !== 'exclude')
    .map((r) => r.id)

  const driftRequiringExclusion =
    mode === 'reconciliation'
      ? g2rDriftRows.filter((r) =>
          (DRIFT_CLASSES_REQUIRING_EXCLUSION as readonly string[]).includes(r.drift_class)
        )
      : []
  const missingDriftExcludes = driftRequiringExclusion
    .filter((r) => ledger.validation.byId.get(r.id) !== 'exclude')
    .map((r) => r.id)

  if (
    missingRDispositions.length > 0 ||
    missingUnfetchableExcludes.length > 0 ||
    missingDriftExcludes.length > 0
  ) {
    const parts: string[] = []
    if (missingRDispositions.length > 0) {
      parts.push(
        `${missingRDispositions.length} row(s) in R lack any disposition: ` +
          `${missingRDispositions.slice(0, 10).join(', ')}${missingRDispositions.length > 10 ? ', ...' : ''}`
      )
    }
    if (missingUnfetchableExcludes.length > 0) {
      parts.push(
        `${missingUnfetchableExcludes.length} unfetchable row(s) lack a recorded exclude: ` +
          `${missingUnfetchableExcludes.slice(0, 10).join(', ')}${missingUnfetchableExcludes.length > 10 ? ', ...' : ''}`
      )
    }
    if (missingDriftExcludes.length > 0) {
      parts.push(
        `${missingDriftExcludes.length} G-2R drift row(s) (DR-1..DR-4) lack a recorded exclude: ` +
          `${missingDriftExcludes.slice(0, 10).join(', ')}${missingDriftExcludes.length > 10 ? ', ...' : ''}`
      )
    }
    return {
      id: 'G-1',
      outcome: 'INCONCLUSIVE',
      reason: parts.join('; '),
      detail: { missingRDispositions, missingUnfetchableExcludes, missingDriftExcludes },
    }
  }

  return {
    id: 'G-1',
    outcome: 'PASS',
    reason:
      `every row in R (${R.length}), every unfetchable row (${unfetchableRows.length}), and every ` +
      `G-2R drift row requiring exclusion (${driftRequiringExclusion.length}) has a recorded disposition`,
  }
}
