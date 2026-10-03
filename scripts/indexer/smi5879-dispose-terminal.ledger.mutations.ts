/**
 * SMI-6444's three FORWARD ledger mutations — `add-manual`, `stage`, and
 * `sign-off`. The three revocations live in the sibling
 * `smi5879-dispose-terminal.ledger.revocations.ts` (split for the repo's
 * 500-line file policy); shared primitives in `.ledger.helpers.ts`.
 *
 * Every function here takes an already-parsed, already-validated
 * `Smi5879DispositionLedger` and returns a NEW one (the input is deep-cloned
 * first, never mutated in place), so each is independently testable without
 * touching the filesystem or a lock. The locked five-step write protocol that
 * composes them lives in `smi5879-dispose-terminal.ledger.ts`.
 * @module scripts/indexer/smi5879-dispose-terminal.ledger.mutations
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 4 (sign-off checkpoint + confirmation code), Item 7 (one-active-
 *   entry-per-id, batch_id uniqueness, provenance), Item 8 (`add-manual`,
 *   `stage`'s skip-active-rows rule).
 */

import { computeStageDigest, confirmationCodeFor } from './smi5879-disposition-digest.ts'
import type {
  DispositionBatch,
  DispositionRecord,
  Smi5879DispositionLedger,
} from './smi5879-gate-check.types.ts'
import {
  activeEntryIds,
  byBytes,
  cloneLedger,
  computeEntryIdsDigest,
  entryIdsForBatch,
  findBatch,
  nonEmpty,
  sortedUnique,
} from './smi5879-dispose-terminal.ledger.helpers.ts'
import {
  refuse,
  type AddManualParams,
  type AddManualResult,
  type LedgerMutationOutcome,
  type SignOffParams,
  type SignOffResult,
  type SignOffStratumSummary,
  type SignOffSummary,
  type StageBatchParams,
  type StageBatchResult,
} from './smi5879-dispose-terminal.ledger.types.ts'

/** How many mismatched ids a sign-off summary shows inline. */
const MISMATCH_PREVIEW_LIMIT = 10

// ---------------------------------------------------------------------------
// add-manual
// ---------------------------------------------------------------------------

/**
 * Append an operator-authored `DispositionRecord` with `method:'manual'` and
 * auto-filled `recorded_by`/`recorded_at` (plan Item 8). Refuses when the id
 * already carries an ACTIVE entry — the only legal way to replace one is to
 * `revoke-manual` (or `revoke-batch`) first, which makes revoke-then-add a
 * non-conflict by construction (Item 7).
 */
export function addManual(
  ledger: Smi5879DispositionLedger,
  params: AddManualParams
): LedgerMutationOutcome<AddManualResult> {
  const invalid =
    nonEmpty(params.id, 'id') ??
    nonEmpty(params.reason, 'reason') ??
    nonEmpty(params.operator, 'operator')
  if (invalid !== null) return refuse('invalid_input', `add-manual: ${invalid}`)
  if (activeEntryIds(ledger).has(params.id)) {
    return refuse(
      'active_entry_exists',
      `add-manual: id "${params.id}" already has an active disposition entry — revoke it first (revoke-manual, or revoke-batch for a bulk-covered id)`
    )
  }
  const next = cloneLedger(ledger)
  const entry: DispositionRecord = {
    id: params.id,
    verdict: params.verdict,
    reason: params.reason,
    recorded_by: params.operator,
    recorded_at: params.now,
    method: 'manual',
  }
  next.entries.push(entry)
  return { ok: true, write: true, ledger: next, result: { entry } }
}

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

/** Rebuild the batch explicitly field-by-field rather than spreading the
 *  draft, so no `signed_off_*`/`revoked`/`sign_off_revocations` value can
 *  leak in from an untyped caller — staging must never emit a signed batch. */
function buildStagedBatch(
  params: StageBatchParams,
  reason: string,
  entryIds: readonly string[]
): DispositionBatch {
  const d = params.draft
  const batch: DispositionBatch = {
    schema_version: d.schema_version,
    batch_id: d.batch_id,
    outcome_class: d.outcome_class,
    run_id: d.run_id,
    reason,
    tool_commit: d.tool_commit,
    tool_source_digest: d.tool_source_digest,
    population_count: d.population_count,
    population_cohort_counts: d.population_cohort_counts,
    ...(d.subtype_counts !== undefined ? { subtype_counts: d.subtype_counts } : {}),
    ...(d.confidence_pct !== undefined ? { confidence_pct: d.confidence_pct } : {}),
    ...(d.mismatch_threshold_bp !== undefined
      ? { mismatch_threshold_bp: d.mismatch_threshold_bp }
      : {}),
    ...(d.stratum_threshold_bp !== undefined
      ? { stratum_threshold_bp: d.stratum_threshold_bp }
      : {}),
    ...(d.design_point_bad_draws_per_stratum !== undefined
      ? { design_point_bad_draws_per_stratum: d.design_point_bad_draws_per_stratum }
      : {}),
    ...(d.allocation !== undefined ? { allocation: d.allocation } : {}),
    ...(d.sampling_seed !== undefined ? { sampling_seed: d.sampling_seed } : {}),
    ...(d.strata !== undefined ? { strata: d.strata } : {}),
    verified_count: d.verified_count,
    ...(d.observed_population_upper_bound_bp !== undefined
      ? { observed_population_upper_bound_bp: d.observed_population_upper_bound_bp }
      : {}),
    verified_at: d.verified_at,
    staged_at: params.now,
    entry_count: entryIds.length,
    entry_ids_digest: computeEntryIdsDigest(entryIds),
    stage_digest: '',
  }
  batch.stage_digest = computeStageDigest(batch, entryIds)
  return batch
}

/**
 * Write the batch record AND its generated `method:'bulk'` entries in ONE
 * mutation, so a batch is never momentarily present without the entries its
 * own `entry_count`/`entry_ids_digest` describe (plan Item 8).
 *
 * Skips any population row that already has an active entry and records the
 * skip count in the batch's own `reason` — without this, the
 * `revoke-batch` → `add-manual` → `stage` correction workflow would
 * regenerate a bulk entry for the just-`add-manual`'d row and trip Item 7's
 * one-active-entry rule on the very next staging. Rows the sample withheld
 * (`mismatched_ids`/`unavailable_ids`) never get an entry either, which is
 * the invariant `checkEntryBatchCrossReferences` enforces on load.
 */
export function stageBatch(
  ledger: Smi5879DispositionLedger,
  params: StageBatchParams
): LedgerMutationOutcome<StageBatchResult> {
  const invalid =
    nonEmpty(params.draft.batch_id, 'batch_id') ??
    nonEmpty(params.reason, 'reason') ??
    nonEmpty(params.operator, 'operator')
  if (invalid !== null) return refuse('invalid_input', `stage: ${invalid}`)
  // batch_id uniqueness binds REVOKED records too (Item 7/8) — a re-stage
  // must mint a fresh id so history is never overwritten.
  if (findBatch(ledger, params.draft.batch_id) !== undefined) {
    return refuse(
      'duplicate_batch_id',
      `stage: batch_id "${params.draft.batch_id}" already exists in this ledger (revoked batches keep their id — mint a fresh one)`
    )
  }
  if (params.draft.run_id !== ledger.run_id) {
    return refuse(
      'run_id_mismatch',
      `stage: batch run_id "${params.draft.run_id}" does not match the ledger's run_id "${ledger.run_id}"`
    )
  }

  const withheld = new Set<string>()
  for (const stratum of params.draft.strata ?? []) {
    for (const id of stratum.mismatched_ids) withheld.add(id)
    for (const id of stratum.unavailable_ids) withheld.add(id)
  }
  const active = activeEntryIds(ledger)
  const eligible: string[] = []
  const skipped: string[] = []
  for (const id of sortedUnique(params.populationIds)) {
    if (withheld.has(id)) continue
    if (active.has(id)) skipped.push(id)
    else eligible.push(id)
  }

  const reason =
    skipped.length === 0
      ? params.reason
      : `${params.reason} Skipped ${skipped.length} population row(s) that already had an active ledger entry.`
  const batch = buildStagedBatch(params, reason, eligible)

  const next = cloneLedger(ledger)
  for (const id of eligible) {
    next.entries.push({
      id,
      verdict: 'exclude',
      recorded_by: params.operator,
      recorded_at: params.now,
      method: 'bulk',
      batch_id: batch.batch_id,
    })
  }
  next.batches = [...(next.batches ?? []), batch]

  return {
    ok: true,
    write: true,
    ledger: next,
    result: {
      batch,
      entryIds: eligible,
      skippedIds: skipped,
      withheldIds: [...withheld].sort(byBytes),
      confirmationCode: confirmationCodeFor(batch.stage_digest),
    },
  }
}

// ---------------------------------------------------------------------------
// sign-off
// ---------------------------------------------------------------------------

function summarizeStrata(batch: DispositionBatch): SignOffStratumSummary[] {
  return (batch.strata ?? []).map((s) => ({
    stratum_key: s.stratum_key,
    population_count: s.population_count,
    selected_count: s.selected_ids.length,
    verified_count: s.verified_count,
    mismatched_count: s.mismatched_ids.length,
    unavailable_count: s.unavailable_ids.length,
    upper_bound_bp: s.upper_bound_bp,
  }))
}

function buildSignOffSummary(batch: DispositionBatch, freshDigest: string): SignOffSummary {
  const strata = summarizeStrata(batch)
  const mismatched = sortedUnique((batch.strata ?? []).flatMap((s) => s.mismatched_ids))
  return {
    batch_id: batch.batch_id,
    outcome_class: batch.outcome_class,
    run_id: batch.run_id,
    reason: batch.reason,
    population_count: batch.population_count,
    entry_count: batch.entry_count,
    verified_count: batch.verified_count,
    total_mismatched: strata.reduce((n, s) => n + s.mismatched_count, 0),
    total_unavailable: strata.reduce((n, s) => n + s.unavailable_count, 0),
    mismatched_ids_preview: mismatched.slice(0, MISMATCH_PREVIEW_LIMIT),
    ...(batch.confidence_pct !== undefined ? { confidence_pct: batch.confidence_pct } : {}),
    ...(batch.mismatch_threshold_bp !== undefined
      ? { mismatch_threshold_bp: batch.mismatch_threshold_bp }
      : {}),
    ...(batch.stratum_threshold_bp !== undefined
      ? { stratum_threshold_bp: batch.stratum_threshold_bp }
      : {}),
    ...(batch.design_point_bad_draws_per_stratum !== undefined
      ? { design_point_bad_draws_per_stratum: batch.design_point_bad_draws_per_stratum }
      : {}),
    ...(batch.observed_population_upper_bound_bp !== undefined
      ? { observed_population_upper_bound_bp: batch.observed_population_upper_bound_bp }
      : {}),
    strata,
    fresh_stage_digest: freshDigest,
    confirmation_code: confirmationCodeFor(freshDigest),
    already_signed: batch.signed_off_by !== undefined,
    stage_digest_matches_stored: batch.stage_digest === freshDigest,
  }
}

/**
 * Without `confirmCode`: recompute the digest fresh from the ledger's CURRENT
 * state, build the summary, and return it with `write: false` — nothing is
 * written (plan Item 4; the caller displays and exits non-zero).
 *
 * With `confirmCode`: two independent refusals, deliberately distinct
 * messages — a stored-vs-recomputed `stage_digest` mismatch (tamper: the
 * staged content or entry membership changed outside the tool) and a
 * confirmation code that doesn't match the FRESH digest (the operator's
 * confirmation refers to content that has since changed).
 *
 * Signing an ALREADY-signed batch is refused rather than silently overwriting
 * the existing triple: the plan does not state this case, and overwriting
 * would discard a prior sign-off without the `sign_off_revocations` archive
 * every other clearing path is required to write. `revoke-sign-off` first.
 */
export function signOff(
  ledger: Smi5879DispositionLedger,
  params: SignOffParams
): LedgerMutationOutcome<SignOffResult> {
  const invalid = nonEmpty(params.batchId, 'batch-id') ?? nonEmpty(params.operator, 'operator')
  if (invalid !== null) return refuse('invalid_input', `sign-off: ${invalid}`)
  const batch = findBatch(ledger, params.batchId)
  if (batch === undefined) {
    return refuse('batch_not_found', `sign-off: no batch with batch_id "${params.batchId}"`)
  }
  if (batch.revoked !== undefined) {
    return refuse(
      'batch_revoked',
      `sign-off: batch "${params.batchId}" is revoked — a revoked batch is terminal and is never re-activated`
    )
  }

  const ids = entryIdsForBatch(ledger, params.batchId)
  const freshDigest = computeStageDigest(batch, ids)
  const summary = buildSignOffSummary(batch, freshDigest)

  if (params.confirmCode === undefined) {
    return { ok: true, write: false, result: { kind: 'preview', summary } }
  }
  if (batch.signed_off_by !== undefined) {
    return refuse(
      'batch_already_signed',
      `sign-off: batch "${params.batchId}" is already signed off by "${batch.signed_off_by}" — run revoke-sign-off first if it must be re-signed`
    )
  }
  if (batch.stage_digest !== freshDigest) {
    return refuse(
      'stage_digest_tampered',
      `sign-off: batch "${params.batchId}"'s stored stage_digest (${batch.stage_digest}) does not match a fresh recomputation (${freshDigest}) — its staged content or entry membership changed outside this tool`
    )
  }
  if (params.confirmCode !== summary.confirmation_code) {
    return refuse(
      'confirmation_code_mismatch',
      `sign-off: --confirm "${params.confirmCode}" does not match this batch's current confirmation code "${summary.confirmation_code}" — the code must be re-read from a fresh display pass`
    )
  }

  const next = cloneLedger(ledger)
  const target = findBatch(next, params.batchId)
  /* c8 ignore next 3 -- unreachable: the clone is structurally identical to
     `ledger`, in which the same lookup already succeeded above. */
  if (target === undefined) {
    return refuse('batch_not_found', `sign-off: batch "${params.batchId}" vanished from the clone`)
  }
  target.signed_off_by = params.operator
  target.signed_off_at = params.now
  target.sign_off_digest = freshDigest

  return {
    ok: true,
    write: true,
    ledger: next,
    result: { kind: 'signed', summary, batch: target },
  }
}
