/**
 * G-1's per-entry authorization of `method:'bulk'` disposition entries
 * (SMI-6444, plan Item 2 steps (1)-(5)). Split out of
 * `smi5879-gate-check.gates.ts` per CLAUDE.md's <500-line-per-file
 * convention — that file already carries four gate evaluators, and this is a
 * self-contained "is this claimed authorization real?" decision rather than
 * gate control flow.
 * @module scripts/indexer/smi5879-gate-check.gates.bulk-authorization
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 2 (gate-side batch authorization) and Item 7 (revocation rules as
 *   they bind these checks).
 *
 * THE RULE THIS MODULE ENCODES: **the ledger file's own claims about a bulk
 * entry are never load-bearing on their own.** A bulk entry only disposes a
 * row when the gate can independently confirm, against the digest-verified
 * population and the authenticated report, that the batch it names is real,
 * genuinely signed over exactly the entries it currently covers, and scoped
 * to a row that is actually of the batch's declared terminal outcome class.
 * A failure of ANY check makes the row undisposed — the same state as if no
 * entry existed at all — so it falls through to G-1's existing
 * `missingUnfetchableExcludes`/`missingPrimaryNotFoundExcludes`/
 * `missingRDispositions` reporting. Nothing is ever silently dropped.
 */

import { computeStageDigest } from './smi5879-disposition-digest.ts'
import { R_OUTCOMES } from './smi5879-gate-check.helpers.ts'
import { deriveUnfetchableSubtype } from './smi5879-terminal-derivation.ts'
import type { LedgerValidation } from './smi5879-gate-check.ledger-validation.ts'
import type { DispositionVerdict } from './smi5879-gate-check.types.ts'
import type { BranchMap, SimRowResult, SimSnapshotRow } from './smi5879-simulate-full.types.ts'

/**
 * Group the ACTIVE bulk entries by the `batch_id` they carry.
 *
 * Active-only is deliberate and matches what the producer digests: revoked
 * entries are already excluded from `provenanceById` by
 * `validateDispositionLedger`, and a revoked entry authorizes nothing, so an
 * entry-ids digest recomputed over anything else would be checking a set the
 * gate does not actually act on. (A bulk entry is never individually
 * revocable through any sanctioned path — `revoke-sign-off`/`revoke-batch`
 * are the batch-level remedies — so in practice active === all for a
 * tool-written ledger; this only diverges for a hand-edited one, where
 * failing closed is the correct outcome.)
 */
function groupActiveBulkEntryIdsByBatch(validation: LedgerValidation): Map<string, string[]> {
  const byBatch = new Map<string, string[]>()
  for (const [id, provenance] of validation.provenanceById) {
    if (provenance.method !== 'bulk') continue
    const batchId = provenance.batch_id
    if (batchId === undefined) continue
    const ids = byBatch.get(batchId)
    if (ids === undefined) byBatch.set(batchId, [id])
    else ids.push(id)
  }
  return byBatch
}

/**
 * The batch_ids whose sign-off is REAL: a non-empty `signed_off_by` plus a
 * `sign_off_digest` equal to a digest recomputed FRESH, right now, over the
 * batch's own staged fields and the entry ids that currently carry its
 * `batch_id` — never the `stage_digest`/`entry_ids_digest` stored in the
 * file, which a hand-editor controls.
 *
 * Revoked batches need no special-casing here: `validateDispositionLedger`
 * already excludes them from `batchById`, so this never sees one. That is
 * the intended behaviour, not an oversight — a revoked batch's stored
 * digests are historical record over entries that no longer exist, so
 * recomputing them would be meaningless as well as authorizing nothing.
 *
 * A `computeStageDigest` throw (a batch shape its canonical serializer
 * refuses) is caught and treated as "not signed" — fail closed, never crash
 * the gate on a malformed ledger.
 */
function computeGenuinelySignedBatchIds(
  validation: LedgerValidation,
  entryIdsByBatch: Map<string, string[]>
): Set<string> {
  const signed = new Set<string>()
  for (const [batchId, batch] of validation.batchById) {
    if (batch.signed_off_by === undefined || batch.signed_off_by.length === 0) continue
    if (batch.sign_off_digest === undefined) continue
    let freshDigest: string
    try {
      freshDigest = computeStageDigest(batch, entryIdsByBatch.get(batchId) ?? [])
    } catch {
      continue
    }
    if (freshDigest === batch.sign_off_digest) signed.add(batchId)
  }
  return signed
}

/**
 * Build G-1's disposition lookup: the verdict a row EFFECTIVELY carries,
 * after bulk-entry authorization.
 *
 * A `manual` (or legacy method-less) entry is returned unchanged — per-row
 * human judgment is unaffected by SMI-6444. A `bulk` entry must clear all
 * five of plan Item 2's checks or the lookup returns `undefined`, exactly as
 * if the ledger had no entry for that id:
 *
 *   1. its `batch_id` resolves to a live (non-revoked) batch record;
 *   2. that batch is genuinely signed off — non-empty `signed_off_by` AND a
 *      `sign_off_digest` matching a fresh recomputation (above);
 *   3. the id is in the digest-verified population, is present in the
 *      authenticated report, and the report-recorded `outcome` equals the
 *      batch's declared `outcome_class` — and for an `unfetchable` batch,
 *      the population row must additionally RE-DERIVE as `unfetchable` via
 *      `deriveUnfetchableSubtype`, against digest-verified data, regardless
 *      of what the report claims;
 *   4. the entry's verdict is `exclude` — a bulk entry can never satisfy
 *      G-1 as a `confirm`;
 *   5. the row's outcome is NOT in `R_OUTCOMES` — a bulk entry can never
 *      satisfy a security-review disposition.
 *
 * @param validation - the already-consistency-checked ledger view
 * @param reportRows - the simulator report's rows, AFTER
 *   `bindSimulatorReportToPopulation` has authenticated them (this lookup's
 *   outcome cross-check is only as trustworthy as that binding)
 * @param population - the digest-verified sealed population
 * @param branchMap - the sealed `(owner, repo)` branch-resolution map
 */
export function makeAuthorizedDispositionLookup(
  validation: LedgerValidation,
  reportRows: readonly SimRowResult[],
  population: readonly SimSnapshotRow[],
  branchMap: BranchMap
): (id: string) => DispositionVerdict | undefined {
  const reportRowsById = new Map(reportRows.map((row) => [row.id, row]))
  const populationById = new Map(population.map((row) => [row.id, row]))
  const entryIdsByBatch = groupActiveBulkEntryIdsByBatch(validation)
  const signedBatchIds = computeGenuinelySignedBatchIds(validation, entryIdsByBatch)

  return (id: string): DispositionVerdict | undefined => {
    const verdict = validation.byId.get(id)
    if (verdict === undefined) return undefined
    const provenance = validation.provenanceById.get(id)
    if (provenance === undefined || provenance.method !== 'bulk') return verdict

    // (1) batch_id resolves — read from provenanceById, looked up in batchById.
    const batchId = provenance.batch_id
    if (batchId === undefined) return undefined
    const batch = validation.batchById.get(batchId)
    if (batch === undefined) return undefined
    // (2) the batch is genuinely signed off over exactly these entries.
    if (!signedBatchIds.has(batchId)) return undefined
    // (4) a bulk entry can never satisfy G-1 as a `confirm`.
    if (verdict !== 'exclude') return undefined
    // (3) the row is in the digest-verified population and the report.
    const populationRow = populationById.get(id)
    if (populationRow === undefined) return undefined
    const reportRow = reportRowsById.get(id)
    if (reportRow === undefined) return undefined
    // (5) never a security-review row.
    if ((R_OUTCOMES as readonly string[]).includes(reportRow.outcome)) return undefined
    // (3, cont.) the report-recorded outcome matches the batch's declared class.
    if (reportRow.outcome !== batch.outcome_class) return undefined
    // (3, cont.) `unfetchable` gets full ground-truth re-derivation — a row
    // that does not independently re-derive fails regardless of the report.
    if (
      batch.outcome_class === 'unfetchable' &&
      deriveUnfetchableSubtype(populationRow, branchMap) === null
    ) {
      return undefined
    }
    return verdict
  }
}

/**
 * The G-2R drift specialization of the same rule: **a bulk entry can never
 * dispose a drift row, full stop.** Only a `manual` (or legacy method-less)
 * entry counts; every bulk entry reads as `undefined`.
 *
 * WHY THIS IS NOT JUST {@link makeAuthorizedDispositionLookup} (SMI-6444,
 * queen-coordinated extension): plan Item 0 keeps the G-2R drift classes
 * (DR-1..DR-4) on the manual path — this plan's bulk mechanism covers only
 * `unfetchable`/`primary_not_found`. It is tempting to assume the general
 * lookup's outcome-class check already guarantees that, since a drift class
 * is neither bulk outcome class. It does not: `drift_class` and the report's
 * `outcome` are INDEPENDENT axes. A row can be `unfetchable` in the decision
 * report AND deleted from the window generation (DR-1) at the same time — a
 * signed `unfetchable` batch covering it would then satisfy every one of the
 * general lookup's five checks and silently dispose a drift row the design
 * requires a human to review. Hence the categorical rule here rather than a
 * reliance on the outcome-class check.
 *
 * Used by BOTH G-2R phase (iii) and G-1's own `missingDriftExcludes` check,
 * so the two gates can never disagree about whether a drift row is disposed.
 */
export function makeManualOnlyDispositionLookup(
  validation: LedgerValidation
): (id: string) => DispositionVerdict | undefined {
  return (id: string): DispositionVerdict | undefined => {
    const verdict = validation.byId.get(id)
    if (verdict === undefined) return undefined
    const provenance = validation.provenanceById.get(id)
    if (provenance === undefined || provenance.method === 'bulk') return undefined
    return verdict
  }
}
