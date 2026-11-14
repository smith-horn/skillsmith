/**
 * SMI-6531 (A1 step 6c-ii-a): the UD61 FACTS `doctor backups` prints: which
 * live record protects a kept tree, and which opIds a parked unreadable
 * record protects (PLAN 233). Facts only: nothing here selects or excludes.
 *
 * Protection depends on the records of EVERY discovered root, not the root a
 * tree sits under, so the scan covers all of them (it is the same verifier as
 * the update's step 3, `scanStagingRecords`, so doctor and update agree, UD44).
 * `PendingRecord` does not carry `backupDest`; a record's backup is
 * `<area>/<opId>`, which rule (b) covers by opId, so (a) needs no separate
 * check here.
 *
 * Read-only.
 *
 * @module @skillsmith/core/services/skill-backups.records
 */
import path from 'node:path'
import { scanStagingRecords } from './skill-swap.records.js'
import type { UnreadableRecord } from './skill-swap.records.js'
import { STAGING_DIR } from './skill-backups.areas.js'

export interface ProtectedBy {
  rule: 'live-record' | 'parked-unreadable-record'
  /** The record's path (live), or the parked copy's path (unreadable). */
  path: string
}

export interface RecordFacts {
  /** Verified live records by opId: the first record path seen for each. */
  live: Map<string, string>
  /** Records that could not be verified, by root: they block every write there. */
  unreadable: { root: string; record: UnreadableRecord }[]
  /** A root's staging directory could not be scanned: nothing about its records is known. */
  scanFailures: { root: string; path: string; errno: string }[]
}

/** Scans every root's staging directory for records. */
export async function collectRecordFacts(roots: readonly string[]): Promise<RecordFacts> {
  const facts: RecordFacts = { live: new Map(), unreadable: [], scanFailures: [] }
  for (const root of roots) {
    const scan = await scanStagingRecords(root, path.join(root, STAGING_DIR))
    if (!scan.ok) {
      facts.scanFailures.push({ root, path: scan.path, errno: scan.errno })
      continue
    }
    for (const r of scan.pending) if (!facts.live.has(r.opId)) facts.live.set(r.opId, r.path)
    for (const u of scan.unreadable) facts.unreadable.push({ root, record: u })
  }
  return facts
}

/** What a kept tree needs for the protection question. */
export interface ProtectionQuery {
  opId: string
  kind: string | null
  /** For `partial-copy`: the sidecar's `sourceUnchanged`. */
  sourceUnchanged: boolean | null
}

/**
 * UD61 (b) and (c) as a fact: the live record whose opId the tree carries
 * (except a `partial-copy` with `sourceUnchanged: true`), else the parked
 * unreadable record with that opId. `parkedUnreadable` maps an opId to the
 * parked copy's path.
 */
export function protectionOf(
  facts: RecordFacts,
  parkedUnreadable: ReadonlyMap<string, string>,
  q: ProtectionQuery
): ProtectedBy | null {
  const exempt = q.kind === 'partial-copy' && q.sourceUnchanged === true
  const live = facts.live.get(q.opId)
  if (live !== undefined && !exempt) return { rule: 'live-record', path: live }
  const parked = parkedUnreadable.get(q.opId)
  if (parked !== undefined) return { rule: 'parked-unreadable-record', path: parked }
  return null
}
