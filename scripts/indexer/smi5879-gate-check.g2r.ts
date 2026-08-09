/**
 * G-2R — the reconciliation gate (design doc §8.3.2.5.7, §8.5, §12.2, §12.3).
 * @module scripts/indexer/smi5879-gate-check.g2r
 *
 * Three phases, EACH short-circuiting, evaluated in order:
 *   (i)   binding    — both generations sealed/correct-purpose/digest-verified,
 *                       matching ruleset_epoch, delta_elapsed in [0, 3d6h] (§12.3's lower bound)
 *   (ii)  freeze-leak — freeze_leak_rows MUST be 0; a non-zero count is a HARD
 *                        FAIL never curable by exclusion dispositions. Cross-checked
 *                        against G-2R.1's own DR-0 count (§12.2's neighbouring fix).
 *   (iii) drift disposition — every DR-1..DR-4 row needs a recorded `exclude`;
 *                              DR-5 rows are reported, never required/accepted.
 *
 * Only applies in `--mode=reconciliation` — `NOT_APPLICABLE` in `--mode=decision`.
 */

import { bindGeneration } from './smi5879-gate-check.binding.ts'
import {
  DRIFT_CLASSES_REQUIRING_EXCLUSION,
  MISSING_COHORT_DRIFT_CLASS,
  type G2rPairBinding,
  type GateResult,
  type Smi5879G2rReport,
  type Smi5879GateCheckDbDeps,
  type Smi5879GateCheckMode,
} from './smi5879-gate-check.types.ts'
import type { ResolvedLedger } from './smi5879-gate-check.helpers.ts'

/** Δ (3 days) + 6h operational tolerance, per design doc §8.3.2.5.7 / §8.5. */
const DELTA_ELAPSED_UPPER_BOUND_MS = (3 * 24 * 3600 + 6 * 3600) * 1000

/**
 * Phase (i). Binds BOTH generations via {@link bindGeneration} (the SAME
 * single-generation binding the top-level evaluator uses for the decision
 * generation — reused here, not re-derived) and checks epoch agreement plus
 * §12.3's two-sided `delta_elapsed` bound (the design doc's own text only
 * gave an upper bound; a negative interval — e.g. transposed run_ids on the
 * command line — is caught here too).
 */
export async function bindG2rPair(
  db: Smi5879GateCheckDbDeps,
  decisionRunId: string,
  windowRunId: string
): Promise<G2rPairBinding> {
  const decision = await bindGeneration(db, decisionRunId, 'decision')
  const window = await bindGeneration(db, windowRunId, 'window')

  if (!decision.bound) {
    return {
      decision,
      window,
      epochs_match: null,
      delta_elapsed_ms: null,
      bound: false,
      reason: `decision generation binding failed: ${decision.reason}`,
    }
  }
  if (!window.bound) {
    return {
      decision,
      window,
      epochs_match: null,
      delta_elapsed_ms: null,
      bound: false,
      reason: `window generation binding failed: ${window.reason}`,
    }
  }

  const ds = decision.summary
  const ws = window.summary
  if (ds === null || ws === null) {
    // Unreachable given the two `bound` guards above (bound is only ever
    // true when the summary was fetched) — kept as an explicit, distinctly
    // worded INCONCLUSIVE rather than a non-null assertion, per "absence of
    // evidence is INCONCLUSIVE."
    return {
      decision,
      window,
      epochs_match: null,
      delta_elapsed_ms: null,
      bound: false,
      reason: 'internal error: a bound generation had no summary',
    }
  }

  if (ds.ruleset_epoch !== ws.ruleset_epoch) {
    return {
      decision,
      window,
      epochs_match: false,
      delta_elapsed_ms: null,
      bound: false,
      reason: `ruleset_epoch mismatch — decision=${ds.ruleset_epoch}, window=${ws.ruleset_epoch}`,
    }
  }

  const deltaMs = Date.parse(ws.snapshot_started_at) - Date.parse(ds.snapshot_started_at)
  if (Number.isNaN(deltaMs)) {
    return {
      decision,
      window,
      epochs_match: true,
      delta_elapsed_ms: null,
      bound: false,
      reason: 'snapshot_started_at was not a parseable date on one or both generations',
    }
  }
  if (deltaMs < 0) {
    return {
      decision,
      window,
      epochs_match: true,
      delta_elapsed_ms: deltaMs,
      bound: false,
      reason:
        `delta_elapsed is negative (${deltaMs}ms, window precedes decision) — the decision/window ` +
        'run_ids are likely transposed on the command line (§12.3)',
    }
  }
  if (deltaMs > DELTA_ELAPSED_UPPER_BOUND_MS) {
    return {
      decision,
      window,
      epochs_match: true,
      delta_elapsed_ms: deltaMs,
      bound: false,
      reason:
        `delta_elapsed (${(deltaMs / 3_600_000).toFixed(1)}h) exceeds the 3d6h bound — the ` +
        'simulation is staler than the freeze was sized for; take a new decision snapshot',
    }
  }

  return {
    decision,
    window,
    epochs_match: true,
    delta_elapsed_ms: deltaMs,
    bound: true,
    reason:
      'generation pair bound: both sealed, correct purposes, matching ruleset_epoch, digests ' +
      `re-verified, delta_elapsed=${(deltaMs / 3_600_000).toFixed(1)}h within [0, 3d6h]`,
  }
}

function emptyReport(binding: G2rPairBinding): Smi5879G2rReport {
  return {
    binding,
    freeze_leak_rows: null,
    dr0_count: null,
    freeze_leak_cross_check_ok: null,
    drift_rows: [],
    undisposed_drift_ids: [],
    improperly_excluded_dr5_ids: [],
    drift_rate: null,
  }
}

export async function evaluateG2R(
  mode: Smi5879GateCheckMode,
  db: Smi5879GateCheckDbDeps,
  decisionRunId: string,
  windowRunId: string | null,
  ledger: ResolvedLedger
): Promise<{ gate: GateResult; report: Smi5879G2rReport | null }> {
  if (mode === 'decision') {
    return {
      gate: {
        id: 'G-2R',
        outcome: 'NOT_APPLICABLE',
        reason: 'G-2R only applies in --mode=reconciliation',
      },
      report: null,
    }
  }
  if (!windowRunId) {
    return {
      gate: {
        id: 'G-2R',
        outcome: 'INCONCLUSIVE',
        reason: '--mode=reconciliation requires --window-run-id',
      },
      report: null,
    }
  }

  // Phase (i) — binding.
  const binding = await bindG2rPair(db, decisionRunId, windowRunId)
  if (!binding.bound) {
    return {
      gate: {
        id: 'G-2R',
        outcome: 'INCONCLUSIVE',
        reason: `phase (i) binding failed: ${binding.reason}`,
      },
      report: emptyReport(binding),
    }
  }

  // Phase (ii) — freeze-leak. Drift is fetched here (once) because the
  // cross-check needs G-2R.1's own DR-0 count alongside G-2R.2's
  // freeze_leak_rows; phase (iii) reuses the SAME driftRows fetch below.
  const freezeLeakRows = await db.countFreezeLeak(decisionRunId, windowRunId)
  const driftRows = await db.enumerateDrift(decisionRunId, windowRunId)

  const missingCohortRows = driftRows.filter((r) => r.drift_class === MISSING_COHORT_DRIFT_CLASS)
  if (missingCohortRows.length > 0) {
    const ids = missingCohortRows.map((r) => r.id)
    return {
      gate: {
        id: 'G-2R',
        outcome: 'INCONCLUSIVE',
        reason:
          `${missingCohortRows.length} row(s) hit the NULL-cohort guard (§12.2) — an I-1 totality ` +
          `invariant violation surfaced during drift enumeration: ${ids.slice(0, 10).join(', ')}` +
          `${ids.length > 10 ? ', ...' : ''}`,
        detail: { ids },
      },
      report: { ...emptyReport(binding), freeze_leak_rows: freezeLeakRows, drift_rows: driftRows },
    }
  }

  const dr0Count = driftRows.filter((r) => r.drift_class === 'DR-0-new-row').length
  const crossCheckOk = dr0Count === freezeLeakRows
  if (!crossCheckOk) {
    return {
      gate: {
        id: 'G-2R',
        outcome: 'INCONCLUSIVE',
        reason:
          `phase (ii) cross-check failed: G-2R.1's DR-0 count (${dr0Count}) does not equal ` +
          `G-2R.2's freeze_leak_rows (${freezeLeakRows}) — sealed-generation immutability violation`,
      },
      report: {
        ...emptyReport(binding),
        freeze_leak_rows: freezeLeakRows,
        dr0_count: dr0Count,
        freeze_leak_cross_check_ok: false,
        drift_rows: driftRows,
      },
    }
  }

  if (freezeLeakRows > 0) {
    return {
      gate: {
        id: 'G-2R',
        outcome: 'INCONCLUSIVE',
        reason:
          `phase (ii) HARD FAIL: freeze_leak_rows=${freezeLeakRows} > 0 — NOT curable by exclusion ` +
          'dispositions (the population the gate closed over was incomplete). Check ' +
          'BACKFILL_KILL_SWITCH first (§8.3.2.5.7), then the writer census (§8.3.3.4), then W-9 ' +
          'direct SQL (§8.3.5.6).',
        detail: { freezeLeakRows },
      },
      report: {
        ...emptyReport(binding),
        freeze_leak_rows: freezeLeakRows,
        dr0_count: dr0Count,
        freeze_leak_cross_check_ok: true,
        drift_rows: driftRows,
      },
    }
  }

  // Phase (iii) — drift disposition.
  if (ledger.loadFailureReason !== null) {
    return {
      gate: {
        id: 'G-2R',
        outcome: 'INCONCLUSIVE',
        reason: `phase (iii): disposition ledger unavailable: ${ledger.loadFailureReason}`,
      },
      report: {
        ...emptyReport(binding),
        freeze_leak_rows: freezeLeakRows,
        dr0_count: dr0Count,
        freeze_leak_cross_check_ok: true,
        drift_rows: driftRows,
      },
    }
  }
  if (!ledger.validation.valid) {
    return {
      gate: {
        id: 'G-2R',
        outcome: 'INCONCLUSIVE',
        reason:
          `phase (iii): disposition ledger has conflicting verdicts for id(s): ` +
          `${ledger.validation.conflictingIds.join(', ')} — never resolved by last-write-wins`,
      },
      report: {
        ...emptyReport(binding),
        freeze_leak_rows: freezeLeakRows,
        dr0_count: dr0Count,
        freeze_leak_cross_check_ok: true,
        drift_rows: driftRows,
      },
    }
  }

  const requiringExclusion = driftRows.filter((r) =>
    (DRIFT_CLASSES_REQUIRING_EXCLUSION as readonly string[]).includes(r.drift_class)
  )
  const undisposed = requiringExclusion
    .filter((r) => ledger.validation.byId.get(r.id) !== 'exclude')
    .map((r) => r.id)
  const dr5Rows = driftRows.filter((r) => r.drift_class === 'DR-5-cohort-move-out')
  const improperlyExcludedDr5 = dr5Rows
    .filter((r) => ledger.validation.byId.get(r.id) === 'exclude')
    .map((r) => r.id)

  const decisionRowCount = binding.decision.summary?.row_count ?? null
  const driftRate =
    decisionRowCount !== null && decisionRowCount > 0
      ? requiringExclusion.length / decisionRowCount
      : null

  if (undisposed.length > 0) {
    return {
      gate: {
        id: 'G-2R',
        outcome: 'INCONCLUSIVE',
        reason:
          `phase (iii): ${undisposed.length} drift row(s) (DR-1..DR-4) lack a recorded exclude ` +
          `disposition: ${undisposed.slice(0, 10).join(', ')}${undisposed.length > 10 ? ', ...' : ''}`,
        detail: { undisposed },
      },
      report: {
        binding,
        freeze_leak_rows: freezeLeakRows,
        dr0_count: dr0Count,
        freeze_leak_cross_check_ok: true,
        drift_rows: driftRows,
        undisposed_drift_ids: undisposed,
        improperly_excluded_dr5_ids: improperlyExcludedDr5,
        drift_rate: driftRate,
      },
    }
  }

  return {
    gate: {
      id: 'G-2R',
      outcome: 'PASS',
      reason:
        `binding, freeze-leak (0, cross-checked against DR-0), and drift disposition ` +
        `(${requiringExclusion.length} DR-1..DR-4 row(s), all excluded) all pass. ` +
        `drift_rate=${driftRate === null ? 'n/a' : driftRate.toFixed(6)}` +
        (improperlyExcludedDr5.length > 0
          ? `; note: ${improperlyExcludedDr5.length} DR-5 row(s) improperly excluded (reported only, non-blocking)`
          : ''),
    },
    report: {
      binding,
      freeze_leak_rows: freezeLeakRows,
      dr0_count: dr0Count,
      freeze_leak_cross_check_ok: true,
      drift_rows: driftRows,
      undisposed_drift_ids: [],
      improperly_excluded_dr5_ids: improperlyExcludedDr5,
      drift_rate: driftRate,
    },
  }
}
