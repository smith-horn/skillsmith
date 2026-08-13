/**
 * Types for smi5879-gate-check.ts, split out per CLAUDE.md's `foo.types.ts`
 * convention.
 * @module scripts/indexer/smi5879-gate-check.types
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.5
 * (merge-gating table), §8.3.5.2 (generation model), §8.3.2.5.7 (G-2R), and
 * §12 (Round-8 addendum — authoritative corrections to §8.5 for this file).
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md
 * §"Gates G-1 through G-8".
 *
 * THE ONE RULE THIS WHOLE MODULE ENCODES: absence of evidence is
 * `INCONCLUSIVE`, never `PASS`. There is deliberately no `FAIL` state — see
 * `GateOutcome` below and §8.5's provenance note ("There is no FAIL state
 * distinct from INCONCLUSIVE anywhere in this table, by owner decision").
 */

import type { InvariantResult, Smi5879Purpose, Smi5879RunStatus } from './smi5879-census.types.ts'
import type { Smi5879SimulateFullReport } from './smi5879-simulate-full.types.ts'

// ---------------------------------------------------------------------------
// Gate identity and outcome
// ---------------------------------------------------------------------------

/**
 * The numbered gates from design doc §8.5. G-4 and G-6 are explicitly NOT
 * numbered gates (§8.5's provenance note) — I-1..I-5 are a fail-closed
 * precondition (not G-4) and the excluded-cohort-E/ruleset-provenance
 * disclosure is a required census-report field (not G-6). G-2R is new
 * (§8.3.2.5.7) and only applies in `--mode=reconciliation`.
 */
export type GateId = 'G-1' | 'G-2' | 'G-2R' | 'G-3' | 'G-5' | 'G-7' | 'G-8'

/**
 * No separate FAIL state exists anywhere in §8.5's table, by owner decision
 * (2026-08-07) — every failure is `INCONCLUSIVE -> merge blocked`, uniformly.
 * `NOT_APPLICABLE` is new here (not in §8.5's vocabulary, which only ever
 * describes a single-mode evaluation): it is used exclusively for G-2R when
 * `--mode=decision` — G-2R is defined only for the reconciliation timeline
 * (§8.3.2.5.7) and simply does not apply when there is no window generation
 * to reconcile against. `NOT_APPLICABLE` never blocks `overall`.
 */
export type GateOutcome = 'PASS' | 'INCONCLUSIVE' | 'NOT_APPLICABLE'

export interface GateResult {
  id: GateId
  outcome: GateOutcome
  /** One-line summary. Always populated, including on PASS. */
  reason: string
  /** Optional machine-readable detail (offending ids, counts, etc). Never required for PASS. */
  detail?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Generation binding (§8.5 "Report/input binding", §12.1, §12.3)
// ---------------------------------------------------------------------------

/** Raw `smi5879_run` row fields gate-check needs — {@link Smi5879GateCheckDbDeps.getRunSummary}. */
export interface Smi5879RunSummary {
  run_id: string
  purpose: Smi5879Purpose
  status: Smi5879RunStatus
  /** ISO 8601 UTC — pinned literal, per 8.3.1.3. */
  ruleset_epoch: string
  /** ISO 8601 UTC. */
  snapshot_started_at: string
  /** ISO 8601 UTC, or null while `status !== 'sealed'`. */
  snapshot_sealed_at: string | null
  row_count: number | null
  population_digest: string | null
  branch_digest: string | null
}

/**
 * The result of binding ONE generation: exists, `sealed`, correct `purpose`,
 * and its digest re-verifies (§8.5's binding checks (a)/(b)/(c), applied to a
 * single `run_id`). `summary` is null when no `smi5879_run` row was found at
 * all — a distinct case from "found but not sealed" or "found but digest
 * mismatch", each of which gets its own `reason` text.
 */
export interface GenerationBinding {
  run_id: string
  expected_purpose: Smi5879Purpose
  summary: Smi5879RunSummary | null
  /** null when not evaluated (e.g. `summary` is null, so there is nothing to verify). */
  digest_verified: boolean | null
  bound: boolean
  reason: string
}

// ---------------------------------------------------------------------------
// G-2R — reconciliation (design doc §8.3.2.5.7 / §12.2 / §12.3)
// ---------------------------------------------------------------------------

/**
 * The six drift classes from G-2R.1's CASE statement (design doc
 * §8.3.2.5.7) — SIX values, DR-0 through DR-5. Some prose passages in the
 * design doc only name DR-1..DR-5, but the SQL's own CASE statement includes
 * DR-0 (the freeze-leak class), and G-2R.2 cross-checks its count against
 * `freeze_leak_rows` (§12.2's neighbouring correctness requirement) — DR-0
 * MUST be representable here or that cross-check cannot be expressed.
 */
export const DRIFT_CLASSES = [
  'DR-0-new-row',
  'DR-1-deleted-row',
  'DR-2-content-drift',
  'DR-3-verdict-baseline-drift',
  'DR-4-cohort-move-in',
  'DR-5-cohort-move-out',
] as const
export type DriftClass = (typeof DRIFT_CLASSES)[number]

/**
 * §12.2's NULL-cohort guard — a distinct, out-of-band condition, NOT a
 * `DR-*` value (§12.2: "classify as its own out-of-band condition (not a
 * `DR-*` value)"). Any occurrence is its own automatic G-2R `INCONCLUSIVE`,
 * because it means the enumeration query hit a cohort the view failed to
 * classify — a violation of I-1's totality invariant that must surface
 * loudly here, not silently fall through to `stable`.
 */
export const MISSING_COHORT_DRIFT_CLASS = 'gate-check: missing cohort assignment' as const

/** DR-1..DR-4 require a recorded `exclude` disposition (§8.5 G-2R row (iii)). */
export const DRIFT_CLASSES_REQUIRING_EXCLUSION: readonly DriftClass[] = [
  'DR-1-deleted-row',
  'DR-2-content-drift',
  'DR-3-verdict-baseline-drift',
  'DR-4-cohort-move-in',
]

/** One row from G-2R.1's drift enumeration (decision generation vs. window generation). */
export interface DriftRow {
  id: string
  drift_class: DriftClass | typeof MISSING_COHORT_DRIFT_CLASS
  decision_content_hash: string | null
  window_content_hash: string | null
  decision_score: number | null
  window_score: number | null
  decision_quarantined: boolean | null
  window_quarantined: boolean | null
  decision_cohort: string | null
  window_cohort: string | null
  repo_url: string | null
  author: string | null
  name: string | null
}

/** G-2R phase (i) — binding a `(decision, window)` pair (§8.5 G-2R, §12.3's lower-bound fix). */
export interface G2rPairBinding {
  decision: GenerationBinding
  window: GenerationBinding
  epochs_match: boolean | null
  /** `window.snapshot_started_at - decision.snapshot_started_at`, in ms. Null when not computable. */
  delta_elapsed_ms: number | null
  bound: boolean
  reason: string
}

/** Full G-2R evaluation detail, carried in {@link Smi5879GateCheckReport.g2r} for audit. */
export interface Smi5879G2rReport {
  binding: G2rPairBinding
  freeze_leak_rows: number | null
  dr0_count: number | null
  freeze_leak_cross_check_ok: boolean | null
  drift_rows: DriftRow[]
  undisposed_drift_ids: string[]
  /** DR-5 rows found WITH a recorded exclude — reported, never blocking (§8.5 G-2R row). */
  improperly_excluded_dr5_ids: string[]
  /** `|DR-1 ∪ DR-2 ∪ DR-3 ∪ DR-4| / decision_rows`. No gating semantics (owner decision, 2026-08-08). */
  drift_rate: number | null
}

// ---------------------------------------------------------------------------
// G-1 — reviewer disposition ledger (operator-authored; no producer exists)
// ---------------------------------------------------------------------------

export type DispositionVerdict = 'confirm' | 'exclude'

export interface DispositionRecord {
  id: string
  verdict: DispositionVerdict
  /** Free-text rationale — operator-authored. */
  reason?: string
  recorded_by?: string
  /** ISO 8601. */
  recorded_at?: string
}

/**
 * The G-1 reviewer-disposition ledger. This artifact has NO producer
 * anywhere in the repo (per task spec) — gate-check.ts only CONSUMES an
 * operator-authored file at this shape, it never generates one.
 */
export interface Smi5879DispositionLedger {
  run_id: string
  entries: DispositionRecord[]
}

// ---------------------------------------------------------------------------
// G-7 / G-8 — freeze + gate-precondition attestation (operator-authored; no producer exists)
// ---------------------------------------------------------------------------

export type AttestationCheckStatus = 'green' | 'red' | 'missing'

/** One F-N / F-NS / P-0.N check, as recorded by the operator running the runbook (design doc §8.3.2.4/§8.3.2.5.7/§8.3.2.0). */
export interface AttestationCheck {
  id: string
  status: AttestationCheckStatus
  detail?: string
}

/**
 * The G-7/G-8 freeze + gate-precondition attestation. Same situation as the
 * disposition ledger: no producer exists in the repo — an operator records
 * F-1..F-9/F-1S..F-6S/P-0.1..P-0.6 by hand per the runbook (§8.3.2.4/
 * §8.3.2.5.7/§8.3.2.0) and gate-check.ts consumes the result.
 */
export interface Smi5879FreezeAttestation {
  run_id: string
  /** Every F-N / F-NS / P-0.N check the operator recorded, id-keyed. */
  checks: AttestationCheck[]
  /** G-7: no successful `indexer-backfill.yml` run anywhere in the Δ span. */
  backfill_kill_switch_clean: boolean
  /** G-8: PR-2192a (design doc §8.2.1.1) merged and its scoped deploy green. */
  pr2192a_merged: boolean
  pr2192a_deploy_green: boolean
  /** ISO 8601, or null if PR-2192a is not yet merged. Independently combined with a
   *  DB-sourced `snapshot_started_at` (never a file-provided one) per the task spec's
   *  "ALSO independently re-derive what you can from the DB" instruction. */
  pr2192a_merged_at: string | null
  recorded_at: string
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/**
 * DB-facing dependencies, mirroring `Smi5879SimulateFullDbDeps`'s injectable
 * pattern — production wires real `psql` calls (`smi5879-gate-check.pg.ts`),
 * tests inject fakes.
 */
export interface Smi5879GateCheckDbDeps {
  getRunSummary(runId: string): Promise<Smi5879RunSummary | null>
  /** Recomputes and compares both digests against the sealed values recorded at seal time. */
  verifyDigest(runId: string): Promise<{ populationMatches: boolean; branchMatches: boolean }>
  /** G-2R.2 — rows present in the window generation but absent from the decision generation. */
  countFreezeLeak(decisionRunId: string, windowRunId: string): Promise<number>
  /** G-2R.1 — full drift enumeration between the decision and window generations. */
  enumerateDrift(decisionRunId: string, windowRunId: string): Promise<DriftRow[]>
}

/** The outcome of gate-check's own self-invoked structural closure test run (§12.1). */
export interface StructuralClosureResult {
  /** True iff the test process actually ran to completion and collected >0 tests. */
  ran: boolean
  /** Only meaningful when `ran` is true. */
  passed: boolean
  /** `git rev-parse HEAD`, captured at test-invocation time — null when it could not be derived. */
  baseline_commit: string | null
  /**
   * Always populated whenever `ran` is false (spawn error, timeout, dirty
   * tree, zero collected tests, unparseable output), never left implicit.
   * SMI-5879 Wave 1: ALSO populated on a subset of `ran: true` outcomes — when
   * {@link fixtureCorpusCorroborationVerified} is false despite the closure
   * subprocess itself completing, this names which corroboration file or
   * sentinel assertion was missing/failed, so a caller can distinguish
   * "corroboration failed" from "corroboration never ran" (corroboration spec
   * doc §6, point 4) without re-deriving it. `null` only when both the
   * closure run succeeded AND corroboration verified.
   */
  unavailable_reason: string | null
  /**
   * §8.3.1.2.4's THIRD corroboration bullet — "no non-AI RiskScoreBreakdown
   * key changes over the fixture corpus" (finding #3, adversarial review of
   * this file's first implementation). True IFF the fixture-corpus
   * corroboration test files (`packages/core/tests/security/
   * smi5879-corroboration.core.test.ts`,
   * `scripts/tests/indexer/smi5879-corroboration.edge.test.ts`) ran, as part
   * of THIS SAME self-invoked vitest subprocess, and every one of their
   * pinned sentinel assertions passed (`CORROBORATION_COLLECTION`,
   * `smi5879-corroboration.types.ts`) — computed by
   * `computeFixtureCorpusCorroborationVerified` in
   * `smi5879-gate-check.closure.ts`, never inferred from the vitest report's
   * aggregate `success` boolean. §8.5's G-5 row requires "both halves" (the
   * structural closure test AND this corroboration) to block merge uniformly.
   * SMI-5879 Wave 1 built the producer this field always deferred to before;
   * on a PRE-PORT branch (PR #2192 unmerged) this is vacuously true — see the
   * two test files' own module docs. Only meaningful when `ran` is true —
   * irrelevant otherwise, same as `passed`.
   */
  fixtureCorpusCorroborationVerified: boolean
}

/** Test-facing dependencies — injectable so the gate-check test suite never spawns real vitest. */
export interface Smi5879GateCheckTestDeps {
  runStructuralClosureTests(): Promise<StructuralClosureResult>
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

export type Smi5879GateCheckMode = 'decision' | 'reconciliation'

export interface Smi5879GateCheckReport {
  report_kind: 'gate_check'
  mode: Smi5879GateCheckMode
  decision_run_id: string
  window_run_id: string | null
  /** I-1..I-5 from every census report supplied (decision, plus window in reconciliation mode). */
  preconditions: InvariantResult[]
  preconditions_passed: boolean
  precondition_failure_reason: string | null
  artifact_binding_ok: boolean
  artifact_binding_reason: string | null
  gates: GateResult[]
  g2r: Smi5879G2rReport | null
  overall: 'PASS' | 'INCONCLUSIVE'
  overall_reason: string | null
  generated_at: string
}

/** Re-exported for callers that only need the simulator report shape. */
export type { Smi5879SimulateFullReport }
