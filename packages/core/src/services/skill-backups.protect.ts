/**
 * SMI-6531 (A1 step 6c-ii-b): UD61 protection for EVERY listed copy, both
 * stores, decided once by the listing (`protectionOf` is the one rule set).
 *
 * The facts are the whole machine's, whatever `scope`, `--root` or `--client`
 * later show: every discovered root's records, every parked copy found in any
 * area (the `unreadable-record` copies rule (c) reads, and the copies whose
 * kind could not be read), and every ledger row that may hide a parked copy.
 * So a row carries the same protection in a scoped or narrowed listing as in
 * the full one, and the planner reads it rather than recomputing it.
 *
 * Read-only: it reads rows and facts and sets each row's `protection`.
 *
 * @module @skillsmith/core/services/skill-backups.protect
 */
import type { LedgerRow } from './skill-backups.ledger.js'
import type { BackupRow, ParkedRow } from './skill-backups.listing.types.js'
import { protectionOf } from './skill-backups.records.js'
import type { RecordFacts } from './skill-backups.records.js'

/** Fills `protection` on every backup and parked row from the global facts. */
export function protectAll(
  backupRows: readonly BackupRow[],
  parkedRows: readonly ParkedRow[],
  records: RecordFacts,
  ledger: readonly LedgerRow[]
): void {
  const parkedUnreadable = new Map<string, string>()
  // A parked copy whose kind could not be read may be an unreadable record (rule (c)).
  const maybe = new Map<string, string[]>()
  for (const r of parkedRows) {
    if (r.kind === 'unreadable-record') {
      if (!parkedUnreadable.has(r.copy.opId)) parkedUnreadable.set(r.copy.opId, r.copy.copyPath)
    } else if (r.kind === null) {
      const list = maybe.get(r.copy.opId)
      if (list === undefined) maybe.set(r.copy.opId, [r.copy.copyPath])
      else list.push(r.copy.copyPath)
    }
  }
  // Rule (c) cannot be ruled out for what the parked scan or the index could not see.
  const hidden = ledger
    .filter((r) => r.mayHideCopies && (r.where.store === 'parked' || r.where.store === 'index'))
    .map((r) => r.path)
  const unseen = { hidden, maybe }
  for (const r of backupRows) {
    const s = r.classification.sidecar?.['sourceUnchanged']
    r.protection = protectionOf(
      records,
      parkedUnreadable,
      {
        copyPath: r.copy.copyPath,
        opId: r.opId,
        kind: r.kind,
        sourceUnchanged: typeof s === 'boolean' ? s : null,
        store: 'backup',
      },
      unseen
    )
  }
  for (const r of parkedRows) {
    r.protection = protectionOf(
      records,
      parkedUnreadable,
      {
        copyPath: r.copy.copyPath,
        opId: r.copy.opId,
        identity: r.classification.rootIdentity,
        kind: r.kind,
        sourceUnchanged: null,
        store: 'parked',
      },
      unseen
    )
  }
}
