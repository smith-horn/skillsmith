/**
 * Small shared primitives for the SMI-6444 ledger mutations — split out of
 * `smi5879-dispose-terminal.ledger.mutations.ts` purely for the repo's
 * 500-line file policy, and imported by both the forward mutations
 * (`.ledger.mutations.ts`) and the revocations (`.ledger.revocations.ts`) so
 * neither has to import the other.
 * @module scripts/indexer/smi5879-dispose-terminal.ledger.helpers
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 4 (`entry_ids_digest`), Item 7 (one-active-entry rule).
 */

import type { DispositionBatch, Smi5879DispositionLedger } from './smi5879-gate-check.types.ts'

/**
 * Re-exported (not re-implemented) from the shared digest module — this file
 * used to carry a byte-identical private duplicate of this exact function;
 * `smi5879-dispose-terminal.test.ts`'s "entry_ids_digest agrees with the
 * digest module" case still pins the two names together, but there is now
 * only one implementation for it to pin.
 */
export { computeEntryIdsDigest } from './smi5879-disposition-digest.ts'

export function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(byBytes)
}

/** Every mutation deep-clones its input first, so it is pure with respect to
 *  the ledger it was handed — the locked protocol wrapper depends on the
 *  as-read ledger staying intact for its own refusal paths. */
export function cloneLedger(ledger: Smi5879DispositionLedger): Smi5879DispositionLedger {
  return structuredClone(ledger)
}

/** Returns a message when the field is missing/blank, `null` when it is fine. */
export function nonEmpty(value: string, field: string): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? null : `${field} must be non-empty`
}

/** Ids carrying an ACTIVE (non-revoked) entry — the set Item 7's
 *  one-active-entry rule and Item 8's stage-skip rule both key off. */
export function activeEntryIds(ledger: Smi5879DispositionLedger): Set<string> {
  const ids = new Set<string>()
  for (const entry of ledger.entries) {
    if (entry.revoked === undefined) ids.add(entry.id)
  }
  return ids
}

/** Looks up ANY batch with this id, revoked included — `batch_id` uniqueness
 *  binds revoked records too, so a re-stage must mint a fresh id. */
export function findBatch(
  ledger: Smi5879DispositionLedger,
  batchId: string
): DispositionBatch | undefined {
  return (ledger.batches ?? []).find((b) => b.batch_id === batchId)
}

/** Every entry carrying `batchId`, sorted — the exact id set `stage_digest`'s
 *  `entry_ids_digest` component is computed over (plan Item 4). */
export function entryIdsForBatch(ledger: Smi5879DispositionLedger, batchId: string): string[] {
  return sortedUnique(ledger.entries.filter((e) => e.batch_id === batchId).map((e) => e.id))
}
