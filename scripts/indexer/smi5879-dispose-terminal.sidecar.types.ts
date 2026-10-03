/**
 * Types for SMI-6444's `.sample.json` sidecar — the resumable, independently
 * locked record of one `primary_not_found` sampling run.
 * @module scripts/indexer/smi5879-dispose-terminal.sidecar.types
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 8 — the sidecar's full field list, its own dedicated lock (distinct
 *   from the ledger lock: a live re-fetch run can take hours, and holding the
 *   ledger lock that long would block staging/sign-off for every other batch),
 *   resume semantics (`unavailable` is retryable, never terminal), and the
 *   complete resume-validation list.
 */

import type { SamplingPolicy } from './smi5879-dispose-terminal.stats.types.ts'

export const SIDECAR_KIND = 'smi5879_disposition_sample'
export const SIDECAR_SCHEMA_VERSION = 1

/** Label the `StuckLockError` message reports for a sidecar lock. */
export const SIDECAR_LOCK_LABEL = 'smi5879 disposition sample'

/**
 * A selected row's recorded outcome. `'verified'`/`'mismatched'` are the ONLY
 * terminal states — `'unavailable'` (and an unrecorded row) is re-attempted on
 * resume, so ordinary rate-limiting is handled by resuming later rather than
 * by permanently pricing the row as a mismatch.
 */
export type SampleResultValue = 'verified' | 'mismatched' | 'unavailable'

export const SAMPLE_RESULT_VALUES: readonly SampleResultValue[] = [
  'verified',
  'mismatched',
  'unavailable',
]

export interface SidecarStratum {
  stratum_key: string
  population_count: number
  /** `n_h` — re-derived from live sizing inputs on resume, never trusted. */
  selected_count: number
}

export interface SidecarSelectedRow {
  id: string
  stratum_key: string
}

export interface SampleSidecar {
  sidecar_kind: typeof SIDECAR_KIND
  schema_version: number
  // -- identity --
  run_id: string
  outcome_class: 'unfetchable' | 'primary_not_found'
  batch_id: string
  /** SHA-256 over the sorted candidate id set at selection time. */
  candidate_ids_digest: string
  // -- every sizing input, not just the seed (round-5 correction) --
  sampling_seed: string
  confidence_pct: number
  mismatch_threshold_bp: number
  stratum_threshold_bp: number
  design_point_bad_draws_per_stratum: number
  allocation: 'proportional'
  /** Sorted by stratum_key. */
  strata: SidecarStratum[]
  /** Sorted by id. */
  selected: SidecarSelectedRow[]
  // -- progress --
  results: Record<string, SampleResultValue>
  // -- provenance --
  tool_commit: string
  tool_source_digest: string
  /** ISO 8601. */
  created_at: string
  /** ISO 8601. */
  updated_at: string
}

/** One candidate row of the outcome class, as handed to the derivation.
 *  `stratum_key: null` means the row's URL did not parse at all — it cannot
 *  be a `primary_not_found` row by construction, so it routes to manual
 *  review rather than silently landing in `default_branch`. */
export interface SampleCandidate {
  id: string
  stratum_key: string | null
}

/** The full, deterministic derivation of a sampling run from live inputs —
 *  computed identically at creation time and at resume-validation time, so a
 *  resumed run can never proceed under different parameters than it started
 *  under. */
export interface DerivedSampleSelection {
  candidate_ids_digest: string
  strata: SidecarStratum[]
  selected: SidecarSelectedRow[]
  /** Ids excluded from the sampled batch: unparseable-URL rows plus every row
   *  in an infeasible stratum (plan Item 5's `manual_review_required`). */
  manual_review_required_ids: string[]
  /** Strata omitted because `N_h === 0`. */
  empty_stratum_keys: string[]
}

export interface SampleRunIdentity {
  run_id: string
  outcome_class: SampleSidecar['outcome_class']
  batch_id: string
  sampling_seed: string
  policy: SamplingPolicy
  allocation: 'proportional'
  tool_commit: string
  tool_source_digest: string
}

export type SidecarRefusalCode =
  | 'sidecar_unreadable'
  | 'sidecar_invalid_shape'
  | 'identity_mismatch'
  | 'sizing_input_mismatch'
  | 'candidate_set_changed'
  | 'selection_mismatch'
  | 'stratum_count_mismatch'
  | 'results_out_of_range'
  | 'tool_source_digest_mismatch'

export interface SidecarRefusal {
  ok: false
  code: SidecarRefusalCode
  reason: string
}

/** Every resume refusal ends with this — a partial sidecar is never silently
 *  re-sampled, and the operator is told exactly how to start over. */
export function deleteToRestart(sidecarPath: string): string {
  return `Delete ${sidecarPath} to restart this sample from scratch (a fresh selection is drawn; no partial results are reused).`
}

export function refuseSidecar(
  code: SidecarRefusalCode,
  reason: string,
  sidecarPath: string
): SidecarRefusal {
  return { ok: false, code, reason: `${reason} ${deleteToRestart(sidecarPath)}` }
}
