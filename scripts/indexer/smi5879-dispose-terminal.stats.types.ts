/**
 * Shared types and policy constants for the SMI-6444 bulk disposition
 * producer's statistical core. Split from `smi5879-dispose-terminal.stats.ts`
 * to keep both files under the repo's 500-line standard
 * (`scripts/check-file-length.mjs`), following the `*.types.ts` convention
 * `merge-duplicate-skills.types.ts` already sets in this directory.
 * @module scripts/indexer/smi5879-dispose-terminal.stats.types
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *       ("### 5. Statistical design for `primary_not_found`'s sample")
 */

/**
 * The two strata this design uses, derived from a row's stored `repo_url`.
 *
 * Deliberately NOT the row's `reason` text (`processRow` writes one fixed
 * constant string for every `primary_not_found` row, so it carries zero
 * stratification information) and deliberately NOT cohort — ref-handling is
 * the one axis with a documented, incident-derived misclassification
 * mechanism (SMI-6157).
 */
export type StratumKey = 'embedded_ref' | 'default_branch'

/** Both stratum keys, in the order reports should present them. */
export const STRATUM_KEYS: readonly StratumKey[] = ['embedded_ref', 'default_branch']

/**
 * Predeclared, digest-covered sampling policy. Every field is an integer:
 * these values are serialized into the batch record and covered by the
 * sign-off digest, and float JSON rendering is writer-ambiguous across
 * languages and versions (plan Item 4).
 */
export interface SamplingPolicy {
  /** One-sided overall confidence, e.g. 95 for 95%. */
  readonly confidencePct: number
  /** Population-arm acceptance threshold, basis points (default 200 = 2%). */
  readonly mismatchThresholdBp: number
  /** Per-stratum acceptance threshold, basis points (default 1000 = 10%). */
  readonly stratumThresholdBp: number
  /** Sizing robustness target: bad draws tolerated per stratum (default 1). */
  readonly designPointBadDrawsPerStratum: number
}

/**
 * The plan's ratified defaults. All four are POLICY choices for the SMI-6015
 * owner, not derived facts — collected here so a change is one edit and so
 * tests pin the derived numbers against a single named source.
 */
export const DEFAULT_SAMPLING_POLICY: SamplingPolicy = {
  confidencePct: 95,
  mismatchThresholdBp: 200,
  stratumThresholdBp: 1000,
  designPointBadDrawsPerStratum: 1,
}

/**
 * Non-normative Poisson sanity anchors from the plan. A computed value ABOVE
 * its anchor indicates a bug, because Poisson >= binomial Clopper-Pearson >=
 * exact hypergeometric for these one-sided upper bounds.
 */
export const POISSON_ANCHORS = {
  /** `2 * 5.5716 / 0.02` — overall n at one bad draw per stratum, H = 2. */
  overallSampleSize: 558,
  /** `5.5716 / 0.10` — a single per-stratum floor. */
  stratumFloor: 56,
} as const

/** Inputs to a single stratum's exact one-sided upper bound. */
export interface UpperBoundInput {
  /** `N_h` — rows of this outcome class in this stratum. */
  readonly populationCount: number
  /** `n_h` — rows selected into the sample (NOT an "evaluable" subset). */
  readonly sampleSize: number
  /** `k'_h` — mismatched + unavailable, already summed by the caller. */
  readonly badDraws: number
  /** Per-stratum alpha, e.g. 0.025. */
  readonly alpha: number
}

/** A stratum's population as handed to the sizing search. */
export interface StratumPopulation {
  readonly stratumKey: string
  readonly populationCount: number
}

/** How the sizing search treats a stratum. */
export type StratumFeasibility = 'empty' | 'feasible' | 'infeasible'

/** Per-stratum result of the sizing search. */
export interface StratumSizing {
  readonly stratumKey: string
  readonly populationCount: number
  /** `n_h` after the allocation formula, clamped to `N_h`. */
  readonly sampleSize: number
  /** `f_h`, the computed floor at `k' = 1`. */
  readonly floor: number
  /** `M_u_h` at the evaluated `k'_h`. */
  readonly upperBoundCount: number
  /** `M_u_h / N_h` in basis points, rounded up. */
  readonly upperBoundBp: number
}

/** Outcome of the joint sample-size search. */
export interface JointSizingResult {
  /** The smallest nominal `n` at which both arms pass at the design point. */
  readonly overallSampleSize: number
  /** `sum_h n_h` — the number of rows actually re-fetched. */
  readonly totalSelectedCount: number
  /** Total population across the feasible strata only. */
  readonly populationCount: number
  /** Per-stratum allocation and bounds at the design point. */
  readonly strata: readonly StratumSizing[]
  /** Strata omitted because `N_h === 0`. */
  readonly emptyStrataKeys: readonly string[]
  /** Strata routed to individual manual disposition (`manual_review_required`). */
  readonly infeasibleStrata: readonly StratumPopulation[]
  /** The Bonferroni-split alpha actually used. */
  readonly perStratumAlpha: number
  /** Population-arm bound at the design point, basis points (rounded up). */
  readonly populationUpperBoundBp: number
}

/** One stratum's realized sample, as handed to the acceptance evaluation. */
export interface StratumObservation {
  readonly stratumKey: string
  readonly populationCount: number
  /** `|selected_ids_h|` — the FULL selected count, never an evaluable subset. */
  readonly selectedCount: number
  /** `|mismatched_ids_h|`. */
  readonly mismatchedCount: number
  /** `|unavailable_ids_h|` — priced as mismatches, per plan Items 5/7. */
  readonly unavailableCount: number
}

/** Per-stratum acceptance detail. */
export interface StratumAcceptance extends StratumSizing {
  /** `k'_h = mismatched + unavailable`. */
  readonly badDraws: number
  /** Did this stratum clear `stratumThresholdBp`? */
  readonly stratumArmPass: boolean
}

/** Outcome of the acceptance evaluation. */
export interface AcceptanceResult {
  readonly accepted: boolean
  readonly populationArmPass: boolean
  readonly stratumArmPass: boolean
  readonly populationCount: number
  readonly populationUpperBoundBp: number
  readonly perStratumAlpha: number
  readonly strata: readonly StratumAcceptance[]
  /** Human-readable reasons for a refusal; empty when accepted. */
  readonly failures: readonly string[]
}
