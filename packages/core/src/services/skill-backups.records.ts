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

/**
 * UD61 as a fact with three answers, never two: a record protects the tree, no
 * record does, or the records could not all be read so nobody can say. "No
 * record found" and "records unknown" must not read the same.
 */
export type Protection =
  | ({ status: 'protected' } & ProtectedBy)
  | { status: 'unprotected' }
  | { status: 'unknown'; reason: string }

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
 * What the parked scan could not see, so rule (c) cannot be ruled out:
 * `hidden` names areas (or staging directories) that were refused, skipped or
 * partly unreadable, any of which may hold an `unreadable-record` copy; `maybe`
 * maps an opId to a parked copy whose kind could not be read, which may be one.
 */
export interface ParkedUnseen {
  hidden: readonly string[]
  maybe: ReadonlyMap<string, string>
}

/**
 * UD61 (b) and (c) as a fact: the live record whose opId the tree carries
 * (except a `partial-copy` with `sourceUnchanged: true`), else the parked
 * unreadable record with that opId (`parkedUnreadable` maps an opId to the
 * parked copy's path). With neither, the answer is `unknown` when some root's
 * records could not be scanned, a record in one could not be verified (its
 * opId is unknown, so it may be this tree's), a parked copy with this opId has
 * an unknown kind, or a parked area could not be read (`unseen`); and
 * `unprotected` otherwise.
 */
export function protectionOf(
  facts: RecordFacts,
  parkedUnreadable: ReadonlyMap<string, string>,
  q: ProtectionQuery,
  unseen?: ParkedUnseen
): Protection {
  const exempt = q.kind === 'partial-copy' && q.sourceUnchanged === true
  const live = facts.live.get(q.opId)
  if (live !== undefined && !exempt) return { status: 'protected', rule: 'live-record', path: live }
  const parked = parkedUnreadable.get(q.opId)
  if (parked !== undefined) {
    return { status: 'protected', rule: 'parked-unreadable-record', path: parked }
  }
  const failed = facts.scanFailures[0]
  if (failed !== undefined) {
    return {
      status: 'unknown',
      reason: 'records under ' + failed.root + ' could not be read (' + failed.errno + ')',
    }
  }
  const unreadable = facts.unreadable[0]
  if (unreadable !== undefined) {
    return {
      status: 'unknown',
      reason: 'an unreadable update record in ' + unreadable.root + ' may protect it',
    }
  }
  const maybe = unseen?.maybe.get(q.opId)
  if (maybe !== undefined) {
    return {
      status: 'unknown',
      reason: 'the set-aside copy ' + maybe + ' has this operation id and an unreadable kind',
    }
  }
  const hidden = unseen?.hidden[0]
  if (hidden !== undefined) {
    return {
      status: 'unknown',
      reason: hidden + ' could not be read and may hold a set-aside record for this operation',
    }
  }
  return { status: 'unprotected' }
}
