/**
 * SMI-6531 (A1 step 6c-ii-a): the UD61 FACTS `doctor backups` prints: which
 * live record protects a kept tree, and which opIds a parked unreadable
 * record protects (PLAN 233). Facts only: nothing here selects or excludes.
 *
 * Protection depends on the records of EVERY discovered root, not the root a
 * tree sits under, so the scan covers all of them (it is the same verifier as
 * the update's step 3, `scanStagingRecords`, so doctor and update agree, UD44).
 * Rule (a) is its own fact (6c-ii-b, M-P3): every live record's `backupDest`
 * is protected by path, whatever its opId or kind. A record's backup is
 * normally `<area>/<opId>`, which rule (b) also covers by opId, so (a) is
 * checked first and named when it applies.
 *
 * Q2 (8-i-a-2): a live fresh-install record protects the parked copy its own
 * post-claim park made (kind `install-rollback`, the record's opId), the
 * parked-store analogue of rule (b): while the record is live, doctor's FI4
 * row names that copy, and a prune that took it would leave the install with
 * nothing to restore. An install record has no `backupDest`, so rule (a)
 * gets nothing from it.
 *
 * `protectionOf` is the one rule set for both stores (6c-ii-b): the listing
 * applies it to every backup tree and every parked copy
 * (`skill-backups.protect.ts`), and the planner adds no rule of its own.
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
  rule: 'backup-dest' | 'live-record' | 'parked-unreadable-record'
  /** The record's path (backup-dest, live), or the parked copy's path (unreadable). */
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
  /**
   * UD61(a): each verified live record's `backupDest`, mapped to that record's
   * path. `collectRecordFacts` always fills it; it is optional only so a
   * hand-built fact set without records stays valid.
   */
  backupDests?: Map<string, string>
  /**
   * Q2: verified live install records by opId (the record's path): each
   * protects the parked `install-rollback` copy carrying its opId. Optional
   * for the same reason as `backupDests`.
   */
  liveInstalls?: Map<string, string>
  /** Records that could not be verified, by root: they block every write there. */
  unreadable: { root: string; record: UnreadableRecord }[]
  /** A root's staging directory could not be scanned: nothing about its records is known. */
  scanFailures: { root: string; path: string; errno: string }[]
}

/** Scans every root's staging directory for records. */
export async function collectRecordFacts(roots: readonly string[]): Promise<RecordFacts> {
  const facts: RecordFacts = {
    live: new Map(),
    backupDests: new Map(),
    liveInstalls: new Map(),
    unreadable: [],
    scanFailures: [],
  }
  for (const root of roots) {
    const scan = await scanStagingRecords(root, path.join(root, STAGING_DIR))
    if (!scan.ok) {
      facts.scanFailures.push({ root, path: scan.path, errno: scan.errno })
      continue
    }
    for (const r of scan.pending) {
      if (!facts.live.has(r.opId)) facts.live.set(r.opId, r.path)
      // An install record has no backup (`backupDest` null): rule (a) has nothing to protect.
      if (r.backupDest !== null && !facts.backupDests?.has(r.backupDest)) {
        facts.backupDests?.set(r.backupDest, r.path)
      }
      if (r.op === 'install' && !facts.liveInstalls?.has(r.opId)) {
        facts.liveInstalls?.set(r.opId, r.path)
      }
    }
    for (const u of scan.unreadable) facts.unreadable.push({ root, record: u })
  }
  return facts
}

/** What a kept tree or a parked copy needs for the protection question. */
export interface ProtectionQuery {
  /** The copy's path, compared exactly with each live record's `backupDest` (rule a). */
  copyPath?: string
  opId: string
  kind: string | null
  /** For `partial-copy`: the sidecar's `sourceUnchanged`. */
  sourceUnchanged: boolean | null
  /**
   * The store the copy is in (default `backup`). Rule (b) covers only the
   * state-root backup area (UD61), so a parked copy is not protected by a live
   * record's opId; and a parked `unreadable-record` copy is the record rule (c)
   * names, so (c) and what may hide (c) never protect it.
   */
  store?: 'backup' | 'parked'
}

/**
 * What the parked scan could not see, so rule (c) cannot be ruled out:
 * `hidden` names areas (or staging directories) that were refused, skipped or
 * partly unreadable, any of which may hold an `unreadable-record` copy; `maybe`
 * maps an opId to the parked copies whose kind could not be read, any of which
 * may be one. A copy is never its own `maybe`.
 */
export interface ParkedUnseen {
  hidden: readonly string[]
  maybe: ReadonlyMap<string, readonly string[]>
}

/**
 * UD61 as a fact, one rule set for both stores: (a) the live record whose
 * `backupDest` is this copy's path; else, for a backup tree, (b) the live
 * record whose opId the tree carries (except a `partial-copy` with
 * `sourceUnchanged: true`), and for a parked `install-rollback` copy the live
 * install record whose opId it carries (Q2); else (c) the parked unreadable record with that
 * opId (`parkedUnreadable` maps an opId to the parked copy's path), unless the
 * copy is itself a parked `unreadable-record`. With none, the answer is
 * `unknown` when an unreadable live record carries this opId (D17, named), some
 * root's records could not be scanned, a record in one could not be verified
 * (its opId is unknown, so it may be this copy's), another parked copy with
 * this opId has an unknown kind, or a parked area could not be read
 * (`unseen`); and `unprotected` otherwise.
 */
export function protectionOf(
  facts: RecordFacts,
  parkedUnreadable: ReadonlyMap<string, string>,
  q: ProtectionQuery,
  unseen?: ParkedUnseen
): Protection {
  const dest = q.copyPath === undefined ? undefined : facts.backupDests?.get(q.copyPath)
  if (dest !== undefined) return { status: 'protected', rule: 'backup-dest', path: dest }
  const parkedStore = q.store === 'parked'
  const exempt = q.kind === 'partial-copy' && q.sourceUnchanged === true
  const live = parkedStore ? undefined : facts.live.get(q.opId)
  if (live !== undefined && !exempt) return { status: 'protected', rule: 'live-record', path: live }
  // Q2: the parked copy a live install record's own post-claim park made (FI4).
  const install =
    parkedStore && q.kind === 'install-rollback' ? facts.liveInstalls?.get(q.opId) : undefined
  if (install !== undefined) return { status: 'protected', rule: 'live-record', path: install }
  // Rule (c) and what may hide it do not apply to the parked record copy itself.
  const ruleC = !(parkedStore && q.kind === 'unreadable-record')
  const parked = ruleC ? parkedUnreadable.get(q.opId) : undefined
  if (parked !== undefined && parked !== q.copyPath) {
    return { status: 'protected', rule: 'parked-unreadable-record', path: parked }
  }
  // D17: an unreadable live record with this opId is named, ahead of the general reasons.
  const named = facts.unreadable.find((u) => u.record.opId === q.opId)
  if (named !== undefined) {
    return {
      status: 'unknown',
      reason: `the unreadable update record ${named.record.path} has this operation id`,
    }
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
  if (!ruleC) return { status: 'unprotected' }
  const maybe = unseen?.maybe.get(q.opId)?.find((p) => p !== q.copyPath)
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
