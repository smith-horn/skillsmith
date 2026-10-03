/**
 * G-1 disposition-ledger shape validation & internal-consistency checking.
 * Split out of `smi5879-gate-check.helpers.ts` (SMI-6444) once the bulk-
 * disposition batch/provenance/revocation fields pushed this logic past the
 * file-length policy's 500-line threshold on its own — re-exported from
 * `smi5879-gate-check.helpers.ts`, so every existing import site is
 * unaffected. `DispositionBatch`/`DispositionBatchStratum` parsing itself
 * lives in the sibling `smi5879-gate-check.disposition-batch.ts` (same
 * reason, applied a second time to this file's own growth).
 * @module scripts/indexer/smi5879-gate-check.ledger-validation
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 3 (schema extension) and Item 7 (validation rules, read in full —
 *   this file plus `disposition-batch.ts` together implement every shape
 *   rule Item 7 states).
 */

import {
  type Field,
  isPlainObject,
  optField,
  parseRevocationInfo,
  reqOneOf,
  reqString,
} from './smi5879-gate-check.field-parsers.ts'
import { parseDispositionBatch } from './smi5879-gate-check.disposition-batch.ts'
import type {
  DispositionBatch,
  DispositionRecord,
  DispositionVerdict,
  Smi5879DispositionLedger,
} from './smi5879-gate-check.types.ts'

// ---------------------------------------------------------------------------
// Per-entry shape parsing
// ---------------------------------------------------------------------------

const VALID_VERDICTS: readonly DispositionVerdict[] = ['confirm', 'exclude']
const VALID_METHODS = ['manual', 'bulk'] as const

function parseDispositionRecord(raw: unknown, index: number): Field<DispositionRecord> {
  const label = `entries[${index}]`
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object` }
  const id = reqString(raw['id'], `${label}.id`)
  if (!id.ok) return id
  const verdict = reqOneOf(raw['verdict'], VALID_VERDICTS, `${label}.verdict`)
  if (!verdict.ok) return verdict
  const method = optField(raw['method'], (v, l) => reqOneOf(v, VALID_METHODS, l), `${label}.method`)
  if (!method.ok) return method
  const batchId = optField(raw['batch_id'], reqString, `${label}.batch_id`)
  if (!batchId.ok) return batchId
  // Method/batch_id consistency (Item 7): bulk entries must carry batch_id;
  // manual-or-absent-method entries must NOT.
  if (method.value === 'bulk' && batchId.value === undefined) {
    return { ok: false, reason: `${label} has method:"bulk" but no batch_id` }
  }
  if (method.value !== 'bulk' && batchId.value !== undefined) {
    return {
      ok: false,
      reason: `${label} has a batch_id but method is not "bulk" (only bulk entries may carry batch_id)`,
    }
  }
  const revoked = optField(raw['revoked'], parseRevocationInfo, `${label}.revoked`)
  if (!revoked.ok) return revoked
  const reasonText = raw['reason']
  const recordedBy = raw['recorded_by']
  const recordedAt = raw['recorded_at']
  return {
    ok: true,
    value: {
      id: id.value,
      verdict: verdict.value,
      ...(typeof reasonText === 'string' ? { reason: reasonText } : {}),
      ...(typeof recordedBy === 'string' ? { recorded_by: recordedBy } : {}),
      ...(typeof recordedAt === 'string' ? { recorded_at: recordedAt } : {}),
      ...(method.value !== undefined ? { method: method.value } : {}),
      ...(batchId.value !== undefined ? { batch_id: batchId.value } : {}),
      ...(revoked.value !== undefined ? { revoked: revoked.value } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Whole-ledger shape validation — entries + batches + cross-checks
// ---------------------------------------------------------------------------

/**
 * A legacy ledger (no `method`/`batch_id`/`batches` anywhere) loads fine —
 * every SMI-6444 field is absent, never defaulted (Item 3).
 */
export function validateDispositionLedgerShape(
  value: unknown
): { ok: true; value: Smi5879DispositionLedger } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not a JSON object' }
  const runId = value['run_id']
  const entriesRaw = value['entries']
  if (typeof runId !== 'string' || runId.length === 0) {
    return { ok: false, reason: 'run_id must be a non-empty string' }
  }
  if (!Array.isArray(entriesRaw)) return { ok: false, reason: 'entries must be an array' }

  const entries: DispositionRecord[] = []
  for (const [i, raw] of entriesRaw.entries()) {
    const parsed = parseDispositionRecord(raw, i)
    if (!parsed.ok) return parsed
    entries.push(parsed.value)
  }

  let batches: DispositionBatch[] | undefined
  const batchesRaw = value['batches']
  if (batchesRaw !== undefined) {
    if (!Array.isArray(batchesRaw)) return { ok: false, reason: 'batches must be an array' }
    const parsedBatches: DispositionBatch[] = []
    const seenBatchIds = new Set<string>()
    for (const [i, raw] of batchesRaw.entries()) {
      const parsed = parseDispositionBatch(raw, i)
      if (!parsed.ok) return parsed
      // Item 3: a batch's run_id "must match the ledger's own run_id". The
      // producer enforces this at stage time, but that alone would make it a
      // producer-only invariant -- exactly the "gate trusts the producer to
      // self-police" posture the plan's architecture decision rejects as
      // option (c). Enforced here so a batch record lifted wholesale from a
      // DIFFERENT run's ledger (sign-off digest and all -- run_id is
      // digest-covered, so a copied batch's digest still verifies) can never
      // authorize bulk exclusions against this run's population.
      if (parsed.value.run_id !== runId) {
        return {
          ok: false,
          reason: `batches[${i}].run_id "${parsed.value.run_id}" does not match the ledger's run_id "${runId}" — a batch may only authorize rows in the run it was staged against`,
        }
      }
      // batch_id uniqueness across batches (Item 7) -- a duplicate
      // definition rejects the whole ledger; this is what makes batchById
      // (LedgerValidation, below) well-defined.
      if (seenBatchIds.has(parsed.value.batch_id)) {
        return {
          ok: false,
          reason: `batches[${i}].batch_id "${parsed.value.batch_id}" is a duplicate — batch_id must be unique across batches`,
        }
      }
      seenBatchIds.add(parsed.value.batch_id)
      parsedBatches.push(parsed.value)
    }
    batches = parsedBatches
  }

  const shapeCheck = checkEntryBatchCrossReferences(entries, batches ?? [])
  if (!shapeCheck.ok) return shapeCheck

  return {
    ok: true,
    value: { run_id: runId, entries, ...(batches !== undefined ? { batches } : {}) },
  }
}

/**
 * Item 7's cross-structure shape rules that need both `entries` and
 * `batches` in scope at once (so they can't live inside either individual
 * parser): a non-revoked entry referencing a REVOKED batch is a hard
 * shape-reject of the whole ledger, a withheld (mismatched/unavailable) id
 * must never also have a generated entry under the same batch_id, and — for
 * every NON-revoked batch — `entry_count` must equal the actual number of
 * ledger entries carrying that `batch_id` (queen review correction,
 * SMI-6444: `Σ strata[].verified_count` is a SAMPLE-level count and does NOT
 * equal `entry_count` for a sampled `primary_not_found` batch, whose staged
 * entries cover the whole population it disposes minus mismatched/
 * unavailable/already-active-skipped rows, not one entry per sampled row —
 * see `smi5879-gate-check.disposition-batch.ts`'s `checkAggregateInvariants`
 * doc comment. This file sees the whole ledger, so it can count directly
 * instead of relying on a same-batch derived total. Entries are written at
 * stage time (Item 8), so equality holds from staging onward; a revoked
 * batch has had its entries removed by `revoke-batch`, so `entry_count`
 * (frozen from staging) is deliberately never re-checked against it).
 */
function checkEntryBatchCrossReferences(
  entries: readonly DispositionRecord[],
  batches: readonly DispositionBatch[]
): { ok: true } | { ok: false; reason: string } {
  const batchById = new Map<string, DispositionBatch>()
  for (const b of batches) batchById.set(b.batch_id, b)

  const entryIdsByBatch = new Map<string, Set<string>>()
  for (const [i, entry] of entries.entries()) {
    if (entry.batch_id === undefined) continue
    const batch = batchById.get(entry.batch_id)
    if (batch !== undefined && entry.revoked === undefined && batch.revoked !== undefined) {
      return {
        ok: false,
        reason: `entries[${i}] references batch_id "${entry.batch_id}", which is revoked — a non-revoked entry may never reference a revoked batch`,
      }
    }
    const set = entryIdsByBatch.get(entry.batch_id) ?? new Set<string>()
    set.add(entry.id)
    entryIdsByBatch.set(entry.batch_id, set)
  }

  for (const [batchId, batch] of batchById) {
    const covered = entryIdsByBatch.get(batchId) ?? new Set<string>()
    if (batch.revoked === undefined && batch.entry_count !== covered.size) {
      return {
        ok: false,
        reason: `batch_id "${batchId}": entry_count (${batch.entry_count}) must equal the actual number of ledger entries carrying this batch_id (${covered.size})`,
      }
    }
    if (covered.size === 0) continue
    for (const stratum of batch.strata ?? []) {
      for (const id of [...stratum.mismatched_ids, ...stratum.unavailable_ids]) {
        if (covered.has(id)) {
          return {
            ok: false,
            reason: `batch_id "${batchId}": id "${id}" is withheld (mismatched_ids/unavailable_ids) but also has a generated ledger entry for this batch`,
          }
        }
      }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Internal-consistency validation (post-shape) — byId/provenanceById/batchById
// ---------------------------------------------------------------------------

export interface LedgerValidation {
  valid: boolean
  byId: Map<string, DispositionVerdict>
  /** ids with two-or-more entries carrying DIFFERENT verdicts — never last-write-wins. */
  conflictingIds: string[]
  /** SMI-6444 — per-entry provenance, revoked entries excluded (Item 3/7). */
  provenanceById: Map<string, { method: 'manual' | 'bulk'; batch_id?: string }>
  /** SMI-6444 — keyed by batch_id; revoked batches excluded (Item 3/7). */
  batchById: Map<string, DispositionBatch>
}

/**
 * Validate internal consistency of an already-shape-checked ledger.
 *
 * SMI-6444 (round-5 correction, replaces the old same-id-different-verdict-
 * only rule): at most one ACTIVE (non-revoked) entry is permitted per id,
 * full stop — a second active entry is always a conflict, even if outwardly
 * identical to the first. Revoked entries are skipped entirely when building
 * `byId`/`provenanceById` and when checking conflicts, so a revoke-then-add
 * sequence for the same id is never itself a conflict. Revoked batches are
 * excluded from `batchById` — their stored digests are historical record
 * over entries that no longer exist, and authorize nothing.
 */
export function validateDispositionLedger(ledger: Smi5879DispositionLedger): LedgerValidation {
  const byId = new Map<string, DispositionVerdict>()
  const provenanceById = new Map<string, { method: 'manual' | 'bulk'; batch_id?: string }>()
  const conflicting = new Set<string>()

  for (const entry of ledger.entries) {
    if (entry.revoked !== undefined) continue
    if (byId.has(entry.id)) {
      // The first-seen entry's byId/provenanceById values are left in place
      // (never overwritten by the conflicting entry) purely for continuity
      // with the pre-existing byId semantics -- evaluateG1 short-circuits on
      // `!valid` before ever consulting byId for a conflicting id, so this
      // has no observable effect on gate outcomes.
      conflicting.add(entry.id)
      continue
    }
    byId.set(entry.id, entry.verdict)
    provenanceById.set(entry.id, {
      method: entry.method ?? 'manual',
      ...(entry.batch_id !== undefined ? { batch_id: entry.batch_id } : {}),
    })
  }

  const batchById = new Map<string, DispositionBatch>()
  for (const batch of ledger.batches ?? []) {
    if (batch.revoked !== undefined) continue
    batchById.set(batch.batch_id, batch)
  }

  return {
    valid: conflicting.size === 0,
    byId,
    conflictingIds: [...conflicting].sort(),
    provenanceById,
    batchById,
  }
}

export interface ResolvedLedger {
  validation: LedgerValidation
  /** Non-null iff the ledger could not be loaded at all (missing/malformed) — distinct
   *  from "loaded but incomplete", which each gate reports on its own terms. */
  loadFailureReason: string | null
}

/**
 * Structurally identical to `smi5879-gate-check.helpers.ts`'s generic
 * `LoadResult<T>` — redeclared locally (rather than imported) to avoid a
 * circular import, since `helpers.ts` re-exports `resolveLedger` FROM this
 * file. Any real `LoadResult<Smi5879DispositionLedger>` value is assignable
 * here by TypeScript's structural typing, so callers need no adapter.
 */
type DispositionLedgerLoadResult =
  | { status: 'ok'; value: Smi5879DispositionLedger }
  | { status: 'missing' | 'malformed'; reason: string }

/**
 * Normalize a `loadJsonFile` result for the disposition ledger into a shape
 * both G-1 and G-2R can consume uniformly: a load failure (missing file,
 * unparseable JSON, failed shape validation) produces an EMPTY, vacuously
 * "valid" ledger plus a distinct `loadFailureReason` — callers check that
 * field FIRST, so "no ledger at all" is never silently indistinguishable
 * from "ledger loaded but every row happens to be undisposed."
 */
export function resolveLedger(loadResult: DispositionLedgerLoadResult): ResolvedLedger {
  if (loadResult.status === 'ok') {
    return { validation: validateDispositionLedger(loadResult.value), loadFailureReason: null }
  }
  return {
    validation: {
      valid: true,
      byId: new Map(),
      conflictingIds: [],
      provenanceById: new Map(),
      batchById: new Map(),
    },
    loadFailureReason: loadResult.reason,
  }
}
