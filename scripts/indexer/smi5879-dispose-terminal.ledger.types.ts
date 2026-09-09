/**
 * Types, refusal codes, and injection seams for the SMI-6444 locked
 * ledger-mutation core (`smi5879-dispose-terminal.ledger.ts` +
 * `.ledger.mutations.ts`). Split out purely for the repo's 500-line file
 * policy, following the `*.types.ts` convention this directory already sets.
 * @module scripts/indexer/smi5879-dispose-terminal.ledger.types
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 8 (atomicity, resumability, revocation, the five-step write
 *   protocol), Item 7 (conflict/provenance rules), Item 4 (sign-off as a real
 *   checkpoint).
 */

import type { FileIoDeps } from './smi5879-dispose-terminal.io.ts'
import type {
  DispositionBatch,
  DispositionRecord,
  DispositionVerdict,
  SignOffRevocationEvent,
  Smi5879DispositionLedger,
} from './smi5879-gate-check.types.ts'

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every way a ledger command can fail closed. Codes are stable identifiers a
 * CLI can map to exit codes / messages; the accompanying `reason` string is
 * the human-readable detail (always distinct per refusal site, so two
 * refusals sharing a code are still distinguishable in output).
 */
export type LedgerRefusalCode =
  // -- protocol / file-level --
  | 'ledger_not_found'
  | 'ledger_unreadable'
  | 'ledger_invalid_shape'
  | 'ledger_conflicting_entries'
  | 'ledger_changed'
  | 'temp_validation_failed'
  // -- entry-level --
  | 'active_entry_exists'
  | 'entry_not_found'
  | 'entry_already_revoked'
  | 'entry_is_bulk'
  // -- batch-level --
  | 'batch_not_found'
  | 'batch_revoked'
  | 'batch_already_signed'
  | 'batch_not_signed'
  | 'duplicate_batch_id'
  | 'run_id_mismatch'
  | 'stage_digest_tampered'
  | 'confirmation_code_mismatch'
  // -- input --
  | 'invalid_input'

export interface LedgerRefusal {
  ok: false
  code: LedgerRefusalCode
  reason: string
}

/**
 * What a pure mutation hands back to the locked protocol wrapper.
 *
 * `write: false` is NOT a no-op success dressed up — it is the explicit
 * "computed something, deliberately writes nothing" outcome `sign-off`
 * without `--confirm` needs (plan Item 4: display-only, exits non-zero
 * without writing anything). The wrapper skips steps 2-5 entirely for it, so
 * a preview never renames a file into place.
 */
export type LedgerMutationOutcome<T> =
  | { ok: true; write: true; ledger: Smi5879DispositionLedger; result: T }
  | { ok: true; write: false; result: T }
  | LedgerRefusal

/** What a locked ledger command hands back to its caller. */
export type LedgerCommandResult<T> =
  | {
      ok: true
      /** False for a deliberate read-only outcome (sign-off preview). */
      written: boolean
      result: T
      /** Post-mutation ledger when `written`, the as-read ledger otherwise. */
      ledger: Smi5879DispositionLedger
    }
  | LedgerRefusal

export function refuse(code: LedgerRefusalCode, reason: string): LedgerRefusal {
  return { ok: false, code, reason }
}

// ---------------------------------------------------------------------------
// Injection seams (lock + filesystem)
// ---------------------------------------------------------------------------

export type {
  FileIoDeps,
  LockAcquireOptions,
  LockAcquirer,
  LockRelease,
} from './smi5879-dispose-terminal.io.ts'

/** The ledger's I/O surface is the shared {@link FileIoDeps} — aliased under
 *  a ledger-specific name because the sidecar takes the SAME shape while
 *  holding a DIFFERENT lock (plan Item 8). */
export type LedgerIoDeps = FileIoDeps

// ---------------------------------------------------------------------------
// Per-mutation parameters and results
// ---------------------------------------------------------------------------

export interface AddManualParams {
  id: string
  verdict: DispositionVerdict
  reason: string
  operator: string
  /** ISO 8601 — supplied by the caller so tests and audit trails are deterministic. */
  now: string
}

export interface AddManualResult {
  entry: DispositionRecord
}

/**
 * Everything `stage` needs about the batch EXCEPT the fields staging itself
 * derives (`reason` suffixing, `staged_at`, `entry_count`, `entry_ids_digest`,
 * `stage_digest`) and the lifecycle fields staging must never emit
 * (`signed_off_*`, `sign_off_digest`, `revoked`, `sign_off_revocations`).
 */
export type StagedBatchDraft = Omit<
  DispositionBatch,
  | 'reason'
  | 'staged_at'
  | 'entry_count'
  | 'entry_ids_digest'
  | 'stage_digest'
  | 'signed_off_by'
  | 'signed_off_at'
  | 'sign_off_digest'
  | 'revoked'
  | 'sign_off_revocations'
>

export interface StageBatchParams {
  draft: StagedBatchDraft
  /**
   * Every population row this batch proposes to dispose. Rows that already
   * carry an active ledger entry are skipped (plan Item 8's "one adjacent
   * rule this closes for free"); rows withheld by the sample
   * (`mismatched_ids`/`unavailable_ids` in `draft.strata`) never get an entry.
   */
  populationIds: readonly string[]
  /** Base rationale; the skip count is appended to it by staging itself. */
  reason: string
  operator: string
  /** ISO 8601 — becomes `staged_at` and every generated entry's `recorded_at`. */
  now: string
}

export interface StageBatchResult {
  batch: DispositionBatch
  /** Sorted ids of the generated `method:'bulk'` entries. */
  entryIds: string[]
  /** Sorted population ids skipped because they already had an active entry. */
  skippedIds: string[]
  /** Sorted mismatched ∪ unavailable ids, withheld from this batch's entries. */
  withheldIds: string[]
  confirmationCode: string
}

/** One stratum, flattened for display by a sign-off summary. */
export interface SignOffStratumSummary {
  stratum_key: string
  population_count: number
  selected_count: number
  verified_count: number
  mismatched_count: number
  unavailable_count: number
  upper_bound_bp: number
}

/**
 * Everything `sign-off` prints before an operator confirms. Deliberately a
 * data structure, not pre-rendered text — the CLI owns presentation.
 */
export interface SignOffSummary {
  batch_id: string
  outcome_class: DispositionBatch['outcome_class']
  run_id: string
  reason: string
  population_count: number
  entry_count: number
  verified_count: number
  total_mismatched: number
  total_unavailable: number
  /** First several mismatched ids across strata, sorted; full lists live in the batch. */
  mismatched_ids_preview: string[]
  confidence_pct?: number
  mismatch_threshold_bp?: number
  stratum_threshold_bp?: number
  design_point_bad_draws_per_stratum?: number
  observed_population_upper_bound_bp?: number
  strata: SignOffStratumSummary[]
  /** Recomputed fresh from the ledger's CURRENT state, never read from the file. */
  fresh_stage_digest: string
  confirmation_code: string
  already_signed: boolean
  stage_digest_matches_stored: boolean
}

export interface SignOffParams {
  batchId: string
  operator: string
  /** Absent → display-only; nothing is written (plan Item 4). */
  confirmCode?: string
  /** ISO 8601 — becomes `signed_off_at`. */
  now: string
}

export type SignOffResult =
  | { kind: 'preview'; summary: SignOffSummary }
  | { kind: 'signed'; summary: SignOffSummary; batch: DispositionBatch }

export interface RevokeManualParams {
  id: string
  reason: string
  operator: string
  now: string
}

export interface RevokeManualResult {
  entry: DispositionRecord
}

export interface RevokeSignOffParams {
  batchId: string
  reason: string
  operator: string
  now: string
}

export interface RevokeSignOffResult {
  batch: DispositionBatch
  event: SignOffRevocationEvent
}

export interface RevokeBatchParams {
  batchId: string
  reason: string
  operator: string
  now: string
}

export interface RevokeBatchResult {
  batch: DispositionBatch
  /** Sorted ids of the entries removed from the file by this revocation. */
  removedEntryIds: string[]
  /** Present iff a live sign-off was archived before being cleared. */
  archivedSignOff?: SignOffRevocationEvent
}
