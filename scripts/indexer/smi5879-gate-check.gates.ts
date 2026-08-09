/**
 * G-1, G-2, G-3, G-5, G-7, G-8 evaluators (design doc §8.5, corrected by §12).
 * G-2R lives in the sibling `smi5879-gate-check.g2r.ts` (own file — three
 * short-circuiting phases, materially more code than any of these six).
 * @module scripts/indexer/smi5879-gate-check.gates
 */

import {
  checkAttestationCompleteness,
  checkDeltaBound,
  computeR,
  G7_REQUIRED_ATTESTATION_IDS,
  G8_REQUIRED_ATTESTATION_IDS,
  type LoadResult,
  type ResolvedLedger,
} from './smi5879-gate-check.helpers.ts'
import {
  DRIFT_CLASSES_REQUIRING_EXCLUSION,
  type DriftRow,
  type GateResult,
  type Smi5879FreezeAttestation,
  type Smi5879GateCheckMode,
  type Smi5879SimulateFullReport,
  type StructuralClosureResult,
} from './smi5879-gate-check.types.ts'
import type { SimulatedCohort } from './smi5879-simulate-full.types.ts'

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
 * JUDGMENT CALL (flagged per task instructions — §8.5 doesn't mandate a
 * mechanism for the fixture-corpus corroboration check, and the plan
 * explicitly says to "pick one and document the choice"): design doc
 * §8.3.1.2.4's THIRD corroboration bullet — "no non-AI RiskScoreBreakdown
 * key changes over the fixture corpus" — has no producing artifact anywhere
 * in the repo (item 2 shipped only the structural closure tests, which are
 * fixture-free by design — see their own module docs). Building a NEW
 * fixture-corpus RiskScoreBreakdown-parity test is an item-2-shaped
 * deliverable, out of scope for this gate-checker. Per the plan's explicit
 * option (b) ("`npm run preflight`/CI is the actual enforcement point and
 * `gate-check.ts`'s own output says so explicitly"), this gate does NOT
 * independently re-run that corroboration — it says so in its PASS reason
 * text below, so the gap is visible in every report rather than silently
 * assumed. The other TWO corroboration bullets ARE independently
 * re-verified here: the structural closure test itself (self-invoked,
 * §12.1) and the per-row +32 bound over "the entire simulated population" —
 * which is exactly the simulator report's own rows, not a fixture corpus.
 */
const G5_FIXTURE_CORPUS_NOTE =
  'NOTE: the fixture-corpus RiskScoreBreakdown-key corroboration (design doc §8.3.1.2.4) is NOT ' +
  'independently re-run by gate-check.ts — no producing artifact exists for it; enforcement is ' +
  'via npm run preflight/CI (documented judgment call, plan option (b)).'

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
  return {
    id: 'G-5',
    outcome: 'PASS',
    reason:
      `structural closure test passed (baseline_commit=${closure.baseline_commit}) and every ` +
      `simulated row's delta <= +32. ${G5_FIXTURE_CORPUS_NOTE}`,
  }
}

// ---------------------------------------------------------------------------
// G-7 — freeze
// ---------------------------------------------------------------------------

export function evaluateG7(attestation: LoadResult<Smi5879FreezeAttestation>): GateResult {
  if (attestation.status === 'missing') {
    return {
      id: 'G-7',
      outcome: 'INCONCLUSIVE',
      reason: `freeze attestation unavailable: ${attestation.reason}`,
    }
  }
  if (attestation.status === 'malformed') {
    return {
      id: 'G-7',
      outcome: 'INCONCLUSIVE',
      reason: `freeze attestation malformed: ${attestation.reason}`,
    }
  }
  const att = attestation.value
  const completeness = checkAttestationCompleteness(att.checks, G7_REQUIRED_ATTESTATION_IDS)
  if (!completeness.ok) {
    const parts: string[] = []
    if (completeness.missingIds.length > 0) {
      parts.push(`missing (never recorded): ${completeness.missingIds.join(', ')}`)
    }
    if (completeness.redIds.length > 0)
      parts.push(`present but red: ${completeness.redIds.join(', ')}`)
    return {
      id: 'G-7',
      outcome: 'INCONCLUSIVE',
      reason: `F-1..F-9/F-1S..F-6S incomplete — ${parts.join('; ')}`,
      detail: { missingIds: completeness.missingIds, redIds: completeness.redIds },
    }
  }
  if (!att.backfill_kill_switch_clean) {
    return {
      id: 'G-7',
      outcome: 'INCONCLUSIVE',
      reason:
        'BACKFILL_KILL_SWITCH was not clean for the full Δ span — a successful indexer-backfill.yml ' +
        'run was recorded during the freeze',
    }
  }
  return {
    id: 'G-7',
    outcome: 'PASS',
    reason: 'F-1..F-9 and F-1S..F-6S all recorded green; selective freeze held unbroken for Δ',
  }
}

// ---------------------------------------------------------------------------
// G-8 — gate pre-condition
// ---------------------------------------------------------------------------

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

export function evaluateG8(
  attestation: LoadResult<Smi5879FreezeAttestation>,
  /** DB-sourced (`smi5879_run.snapshot_started_at` for the DECISION generation) — never
   *  file-provided, per the task spec's "independently re-derive from the DB" instruction. */
  decisionSnapshotStartedAt: string | null
): GateResult {
  if (attestation.status === 'missing') {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: `freeze attestation unavailable: ${attestation.reason}`,
    }
  }
  if (attestation.status === 'malformed') {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: `freeze attestation malformed: ${attestation.reason}`,
    }
  }
  const att = attestation.value
  const completeness = checkAttestationCompleteness(att.checks, G8_REQUIRED_ATTESTATION_IDS)
  if (!completeness.ok) {
    const parts: string[] = []
    if (completeness.missingIds.length > 0) {
      parts.push(`missing (never recorded): ${completeness.missingIds.join(', ')}`)
    }
    if (completeness.redIds.length > 0)
      parts.push(`present but red: ${completeness.redIds.join(', ')}`)
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: `P-0.1..P-0.6 incomplete — ${parts.join('; ')}`,
      detail: { missingIds: completeness.missingIds, redIds: completeness.redIds },
    }
  }
  if (!att.pr2192a_merged) {
    return { id: 'G-8', outcome: 'INCONCLUSIVE', reason: 'PR-2192a not recorded as merged' }
  }
  if (!att.pr2192a_deploy_green) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: 'PR-2192a scoped deploy (mode=changed functions=indexer) not recorded green',
    }
  }
  if (!att.pr2192a_merged_at) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: 'pr2192a_merged_at missing — cannot verify the 24h settle window',
    }
  }
  if (!decisionSnapshotStartedAt) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason:
        'decision generation snapshot_started_at unavailable from the DB — cannot independently ' +
        'verify the 24h settle window',
    }
  }
  const mergedAtMs = Date.parse(att.pr2192a_merged_at)
  const snapshotMs = Date.parse(decisionSnapshotStartedAt)
  if (Number.isNaN(mergedAtMs) || Number.isNaN(snapshotMs)) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason: 'pr2192a_merged_at or the DB-sourced snapshot_started_at is not a parseable date',
    }
  }
  const elapsedMs = snapshotMs - mergedAtMs
  if (elapsedMs < TWENTY_FOUR_HOURS_MS) {
    return {
      id: 'G-8',
      outcome: 'INCONCLUSIVE',
      reason:
        `only ${(elapsedMs / 3_600_000).toFixed(2)}h elapsed between PR-2192a's merge and the ` +
        `decision snapshot (DB-sourced snapshot_started_at=${decisionSnapshotStartedAt}) — 24h required`,
      detail: { elapsedMs },
    }
  }
  return {
    id: 'G-8',
    outcome: 'PASS',
    reason:
      'P-0.1..P-0.6 recorded green; PR-2192a merged, deploy green, and >=24h elapsed before the ' +
      'decision snapshot (independently verified against the DB)',
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
