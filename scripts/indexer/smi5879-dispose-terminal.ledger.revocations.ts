/**
 * The three SMI-6444 revocation mutations — `revoke-manual`,
 * `revoke-sign-off`, `revoke-batch`. Split from
 * `smi5879-dispose-terminal.ledger.mutations.ts` for the repo's 500-line file
 * policy; same contract as its siblings (pure, deep-clones its input, returns
 * a `LedgerMutationOutcome`).
 * @module scripts/indexer/smi5879-dispose-terminal.ledger.revocations
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 8, round 5 — revocation needed its own sanctioned, lock-holding path
 *   for the same reason additions did: without one, an operator wanting to
 *   revoke was forced into the exact hand-edit the residual race punishes, and
 *   a lost raw revocation fails OPEN.
 *
 * None of the three requires a confirmation-code ceremony: Item 4's ceremony
 * exists to slow the GRANTING of authorization, and revocation moves in the
 * fail-closed direction. The mandatory `--reason` preserves the audit trail
 * instead — enforced here, not merely at the CLI layer.
 */

import type {
  DispositionBatch,
  SignOffRevocationEvent,
  Smi5879DispositionLedger,
} from './smi5879-gate-check.types.ts'
import {
  activeEntryIds,
  cloneLedger,
  entryIdsForBatch,
  findBatch,
  nonEmpty,
} from './smi5879-dispose-terminal.ledger.helpers.ts'
import {
  refuse,
  type LedgerMutationOutcome,
  type RevokeBatchParams,
  type RevokeBatchResult,
  type RevokeManualParams,
  type RevokeManualResult,
  type RevokeSignOffParams,
  type RevokeSignOffResult,
} from './smi5879-dispose-terminal.ledger.types.ts'

/** Move a live sign-off triple into `sign_off_revocations` and clear it —
 *  nothing about the prior sign-off is silently dropped. Returns `undefined`
 *  when the batch was not signed. MUTATES the batch it is handed (always a
 *  clone by the time it gets here). */
function archiveSignOff(
  batch: DispositionBatch,
  params: { reason: string; operator: string; now: string }
): SignOffRevocationEvent | undefined {
  if (
    batch.signed_off_by === undefined ||
    batch.signed_off_at === undefined ||
    batch.sign_off_digest === undefined
  ) {
    return undefined
  }
  const event: SignOffRevocationEvent = {
    revoked_by: params.operator,
    revoked_at: params.now,
    reason: params.reason,
    prior_signed_off_by: batch.signed_off_by,
    prior_signed_off_at: batch.signed_off_at,
    prior_sign_off_digest: batch.sign_off_digest,
  }
  batch.sign_off_revocations = [...(batch.sign_off_revocations ?? []), event]
  delete batch.signed_off_by
  delete batch.signed_off_at
  delete batch.sign_off_digest
  return event
}

/**
 * Tombstone a manual entry — it STAYS in the file (the ledger's own path is
 * not guaranteed git-tracked, so an in-file tombstone is the only guaranteed
 * history of the revocation). G-1 needs zero new logic: `byId`/
 * `provenanceById` already skip revoked entries, so the row reverts to
 * undisposed (plan Item 8).
 */
export function revokeManual(
  ledger: Smi5879DispositionLedger,
  params: RevokeManualParams
): LedgerMutationOutcome<RevokeManualResult> {
  const invalid =
    nonEmpty(params.id, 'id') ??
    nonEmpty(params.reason, 'reason') ??
    nonEmpty(params.operator, 'operator')
  if (invalid !== null) return refuse('invalid_input', `revoke-manual: ${invalid}`)

  const all = ledger.entries.filter((e) => e.id === params.id)
  if (all.length === 0) {
    return refuse('entry_not_found', `revoke-manual: no ledger entry for id "${params.id}"`)
  }
  if (!activeEntryIds(ledger).has(params.id)) {
    return refuse(
      'entry_already_revoked',
      `revoke-manual: every ledger entry for id "${params.id}" is already revoked`
    )
  }
  const active = all.filter((e) => e.revoked === undefined)
  if (active.some((e) => e.method === 'bulk')) {
    return refuse(
      'entry_is_bulk',
      `revoke-manual: id "${params.id}" is covered by a method:"bulk" entry — a bulk entry is never individually revocable (removing one would break its batch's entry_ids_digest); use revoke-sign-off or revoke-batch`
    )
  }

  const next = cloneLedger(ledger)
  const target = next.entries.find((e) => e.id === params.id && e.revoked === undefined)
  /* c8 ignore next 3 -- unreachable: the clone mirrors `ledger`, where the
     same predicate already matched. */
  if (target === undefined) {
    return refuse('entry_not_found', `revoke-manual: id "${params.id}" vanished from the clone`)
  }
  target.revoked = { revoked_by: params.operator, revoked_at: params.now, reason: params.reason }
  return { ok: true, write: true, ledger: next, result: { entry: target } }
}

/**
 * Clear a batch's sign-off triple after archiving it to
 * `sign_off_revocations` — the batch reverts to staged-unsigned, keeping the
 * expensive sampling evidence and an UNCHANGED `stage_digest`, so a fresh
 * `sign-off` re-signs the same staged content under the same confirmation
 * code (plan Item 8). Every row the batch covers immediately fails Item 2's
 * per-entry authorization check, with zero new gate logic.
 */
export function revokeSignOff(
  ledger: Smi5879DispositionLedger,
  params: RevokeSignOffParams
): LedgerMutationOutcome<RevokeSignOffResult> {
  const invalid =
    nonEmpty(params.batchId, 'batch-id') ??
    nonEmpty(params.reason, 'reason') ??
    nonEmpty(params.operator, 'operator')
  if (invalid !== null) return refuse('invalid_input', `revoke-sign-off: ${invalid}`)

  const existing = findBatch(ledger, params.batchId)
  if (existing === undefined) {
    return refuse('batch_not_found', `revoke-sign-off: no batch with batch_id "${params.batchId}"`)
  }
  if (existing.revoked !== undefined) {
    return refuse(
      'batch_revoked',
      `revoke-sign-off: batch "${params.batchId}" is revoked — it carries no active sign-off to revoke`
    )
  }
  if (existing.signed_off_by === undefined) {
    return refuse(
      'batch_not_signed',
      `revoke-sign-off: batch "${params.batchId}" is staged but not signed off — there is nothing to revoke`
    )
  }

  const next = cloneLedger(ledger)
  const target = findBatch(next, params.batchId)
  /* c8 ignore next 3 -- unreachable: the clone mirrors `ledger`, where the
     same lookup already succeeded. */
  if (target === undefined) {
    return refuse('batch_not_found', `revoke-sign-off: batch "${params.batchId}" vanished`)
  }
  const event = archiveSignOff(target, params)
  /* c8 ignore next 3 -- unreachable: `existing.signed_off_by` was checked
     above, and the shape parser guarantees the triple is jointly present. */
  if (event === undefined) {
    return refuse('batch_not_signed', `revoke-sign-off: batch "${params.batchId}" has no sign-off`)
  }
  return { ok: true, write: true, ledger: next, result: { batch: target, event } }
}

/**
 * Terminal revocation: remove every ledger entry carrying this `batch_id`
 * (per-entry tombstones would double the file at scale for no audit value —
 * the tombstoned batch record is the audit anchor), archive a live sign-off
 * before clearing it, and mark the batch `revoked`. The batch record STAYS in
 * `batches` permanently, so `batch_id` uniqueness keeps a re-stage from
 * overwriting history. Works on staged-unsigned batches too — otherwise a
 * botched staging would squat on its rows forever (plan Item 8).
 */
export function revokeBatch(
  ledger: Smi5879DispositionLedger,
  params: RevokeBatchParams
): LedgerMutationOutcome<RevokeBatchResult> {
  const invalid =
    nonEmpty(params.batchId, 'batch-id') ??
    nonEmpty(params.reason, 'reason') ??
    nonEmpty(params.operator, 'operator')
  if (invalid !== null) return refuse('invalid_input', `revoke-batch: ${invalid}`)

  const existing = findBatch(ledger, params.batchId)
  if (existing === undefined) {
    return refuse('batch_not_found', `revoke-batch: no batch with batch_id "${params.batchId}"`)
  }
  if (existing.revoked !== undefined) {
    return refuse(
      'batch_revoked',
      `revoke-batch: batch "${params.batchId}" is already revoked — revocation is terminal`
    )
  }

  const removedEntryIds = entryIdsForBatch(ledger, params.batchId)
  const next = cloneLedger(ledger)
  const target = findBatch(next, params.batchId)
  /* c8 ignore next 3 -- unreachable: see revokeSignOff's identical note. */
  if (target === undefined) {
    return refuse('batch_not_found', `revoke-batch: batch "${params.batchId}" vanished`)
  }
  next.entries = next.entries.filter((e) => e.batch_id !== params.batchId)
  const archivedSignOff = archiveSignOff(target, params)
  target.revoked = { revoked_by: params.operator, revoked_at: params.now, reason: params.reason }

  return {
    ok: true,
    write: true,
    ledger: next,
    result: {
      batch: target,
      removedEntryIds,
      ...(archivedSignOff !== undefined ? { archivedSignOff } : {}),
    },
  }
}
