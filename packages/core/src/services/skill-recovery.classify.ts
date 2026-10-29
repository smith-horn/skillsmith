/**
 * SMI-6531 (A1 step 6a-i): doctor's classifier (plan §3.3 "Doctor
 * classification", the state table and "Role resolution"; design § 2).
 *
 * `classifyOp(reader, ctx, opId)` reads one operation directory of a skills
 * root's staging and says what it is, as a `RecoveryClass`:
 *
 *  - without a verified record: `empty-op-dir`, `no-record`, `unreadable`
 *    (including `inconsistent-record`), `other-user`, or `moved` (a record that
 *    verifies but belongs to another root or op dir; since 6b-iii it is
 *    checked for consistency and carries the facts `--abandon` acts on, or is
 *    `ab` once its abandon began);
 *  - with one: `identity-changed`, `ab` (an abandon began), a §3.3 row (`S0`,
 *    `S1`, `S2`, `S2'`, `S2x`, `S3`, `UN1`, `UN2`, each with its post-keep
 *    form) matched on **logical roles**, or `anything-else`.
 *
 * Each of O, N and U resolves to its op-dir source, one verified keep of this
 * op, or nothing; both a source and a verified keep, or two keeps, is
 * `anything-else`. A started keep's kind always wins over a kind recomputed
 * from hashes. T is observed directly.
 *
 * Read-only, and every read goes through the reader (this module has no `fs`),
 * so the re-plan digest covers everything it looked at. It decides nothing
 * about an action: `skill-recovery.plan.ts` says what each action would do.
 *
 * @module @skillsmith/core/services/skill-recovery.classify
 */
import path from 'node:path'
import { canonicalJson } from './skill-recovery.digest.js'
import { inconsistency, movedOf, stateRealOf } from './skill-recovery.consistency.js'
import type { MovedVerdict } from './skill-recovery.consistency.js'
import { noRecord } from './skill-recovery.norecord.js'
import { observeUnreadable, OWNER_CAP } from './skill-recovery.observe.js'
import { analyzeParkIntent } from './skill-recovery.opdir.js'
import {
  expectOfMoved,
  expectOfRecord,
  observeGroups,
  ROLE_DIR,
  STARTED_STATES,
} from './skill-recovery.pstate.js'
import type { OwnerProbe } from './skill-recovery.clean.types.js'
import type { ClassifierReader } from './skill-recovery.reader.js'
import { observeTree, sourceCheck, tStateOf } from './skill-recovery.trees.js'
import type {
  KeepGroup,
  OpFacts,
  RecoveryClass,
  Role,
  RoleRes,
  RowState,
  TreeObs,
  StatFact,
  TreePosition,
  TState,
  UnreadableWhy,
} from './skill-recovery.types.js'
import { backupAreaPath } from './skill-swap.area.js'
import { MAX_RECORD_BYTES, parseRecordBytes } from './skill-swap.record-schema.js'
import { OWNER_FILE, RECORD_FILE } from './skill-swap.types.js'
import type { RecordIdentity, SwapRecord } from './skill-swap.types.js'
import type { EntryState } from './skill-manifest.entry.js'

export interface ClassifyContext {
  /** R: the skills root's native realpath. */
  root: string
  /** ST: `<R>/.skillsmith-staging`. */
  stagingDir: string
  /** The effective uid (part of the plan, not a read). */
  euid: number
  /** The audit journal checked for this op's `update` line. */
  journalFile: string
  /** `--accept-identity`: identity is waived and each present tree must hash to its role's recorded hash. */
  acceptIdentity?: boolean
  /** The state roots discovered or given (6a-iii, governance S4); a park intent's must be one. */
  stateRoots?: readonly string[]
  /**
   * 6b-ii: how `owner.json`'s owner is judged (this host's name and the pid
   * liveness probe), injected so the classifier imports no process or
   * filesystem module. Absent, no owner is shown gone: an owner that names a
   * pid and host is `other-host` (this host's name is unknown), as
   * `ownerVerdict` decides.
   */
  ownerProbe?: OwnerProbe
}

const DENIED = new Set(['EACCES', 'EPERM'])

/** A `record.json.tmp` beside the record: its inode, marker and body, as facts. */
function analyzeRecordTmp(
  r: ClassifierReader,
  opDir: string,
  names: readonly string[],
  rec: SwapRecord
): { tmp: NonNullable<OpFacts['recordTmp']>; marker: OpFacts['fullDevice'] } | null {
  if (!names.includes(`${RECORD_FILE}.tmp`)) return null
  const tmp = path.join(opDir, `${RECORD_FILE}.tmp`)
  const a = r.stat(tmp)
  const b = r.stat(path.join(opDir, RECORD_FILE))
  const sameInode =
    a.ok && b.ok && a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino
  const read = r.readFile(tmp, MAX_RECORD_BYTES + 1)
  const parsed = read.bytes === null ? null : parseRecordBytes(read.bytes)
  const strip = (x: SwapRecord): string => {
    const { recordSha256: _h, fullDevice: _m, ...rest } = x
    return canonicalJson(rest)
  }
  // One read serves the facts and the marker: the marker is carried, not read again.
  return {
    marker: parsed?.ok === true ? (parsed.record.fullDevice ?? null) : null,
    tmp: {
      path: tmp,
      sameInode,
      hasMarker: parsed?.ok === true && parsed.record.fullDevice !== undefined,
      bodyMatches: parsed?.ok === true && strip(parsed.record) === strip(rec),
      emptySingleLink:
        a.ok && a.type === 'file' && a.nlink === 1 && read.fact.ok && read.fact.size === 0,
    },
  }
}

interface RoleResolution {
  roles: OpFacts['roles']
  /** Reasons a role cannot be resolved to exactly one of source, keep or nothing. */
  conflicts: string[]
  /** Positions whose identity differs from their role's but whose hash is the role's. */
  changed: TreePosition[]
}

/** Resolves O, N and U to a source, one verified keep, or nothing (plan §3.3 "Role resolution"). */
function resolveRoles(
  r: ClassifierReader,
  opDir: string,
  rec: SwapRecord,
  groups: readonly KeepGroup[],
  acceptIdentity: boolean,
  /** False for a moved op (6b-iii): its trees are kept as they are, so no role identity is checked. */
  checkSources = true
): RoleResolution {
  const conflicts: string[] = []
  const changed: TreePosition[] = []
  const one = (role: Role): RoleRes => {
    const obs = observeTree(r, path.join(opDir, ROLE_DIR[role]))
    const keeps = groups.filter((g) => g.role === role && g.verified)
    if (obs.present) {
      const chk = checkSources ? sourceCheck(role, obs, rec, acceptIdentity) : 'ok'
      if (chk === 'not-directory') conflicts.push(`${role} is not a directory`)
      else if (chk === 'foreign') conflicts.push(`${role} has neither its identity nor its hash`)
      else if (chk === 'identity-changed') changed.push(role)
      if (keeps.length > 0) conflicts.push(`${role} is both a source and a kept copy`)
      const started =
        groups.find((g) => g.role === role && g.state !== null && STARTED_STATES.has(g.state)) ??
        null
      return { kind: 'source', obs, started }
    }
    if (obs.errno !== null) conflicts.push(`${role} could not be inspected (${obs.errno})`)
    if (keeps.length > 1) conflicts.push(`${role} has ${keeps.length} kept copies`)
    if (keeps.length === 1) return { kind: 'kept', keep: keeps[0]! }
    return { kind: 'absent' }
  }
  return { roles: { O: one('O'), N: one('N'), U: one('U') }, conflicts, changed }
}

const gone = (x: RoleRes): boolean => x.kind === 'absent'

/** The §3.3 row for T, the resolved roles and the manifest, or null ("anything else"). */
function matchRow(
  tS: TState,
  roles: OpFacts['roles'],
  m: EntryState
): { state: RowState; postKeep: boolean } | null {
  const { O, N, U } = roles
  const unclaimed = tS === 'absent' || tS === 'claim'
  if (unclaimed && O.kind === 'source' && N.kind === 'source' && gone(U) && m === 'pre') {
    return { state: 'S1', postKeep: false }
  }
  if (tS === 'new' && gone(N) && gone(U) && (O.kind === 'source' || O.kind === 'kept')) {
    const postKeep = O.kind === 'kept'
    if (m === 'pre') return { state: 'S2', postKeep }
    if (m === 'other') return { state: 'S2prime', postKeep }
    return { state: 'S3', postKeep }
  }
  if (
    (tS === 'absent' || tS === 'foreign') &&
    O.kind === 'source' &&
    gone(N) &&
    gone(U) &&
    m !== 'post'
  ) {
    return { state: 'S2x', postKeep: false }
  }
  if (unclaimed && O.kind === 'source' && U.kind === 'source' && gone(N) && m !== 'post') {
    return { state: 'UN1', postKeep: false }
  }
  if (tS === 'old' && gone(O) && gone(N) && !gone(U) && m !== 'post') {
    return { state: 'UN2', postKeep: U.kind === 'kept' }
  }
  if (tS === 'old' && gone(O) && gone(U) && m === 'pre') {
    return { state: 'S0', postKeep: N.kind === 'kept' }
  }
  return null
}

/** What a verified record's classification starts from. */
interface Verified {
  opId: string
  opDir: string
  rec: SwapRecord
  names: readonly string[]
  /** OP's identity, from its `lstat`. */
  opIdentity: RecordIdentity
  /**
   * 6b-iii: the record belongs to another root or op dir. Its trees are then
   * observed in this root as they are (no role identity check), its keeps in
   * the scanned root's area (`rootKey` over R, PLAN:1069) with the op dir's
   * own name, and its intent is the op dir's own: `--abandon` acts on it.
   */
  moved: MovedVerdict | null
}

/** A verified record: observe everything, then match a row (or, moved, say so with the facts). */
async function classifyRecorded(
  r: ClassifierReader,
  ctx: ClassifyContext,
  v: Verified
): Promise<RecoveryClass> {
  const { opId, opDir, rec, names, moved } = v
  const accept = ctx.acceptIdentity === true
  const tPath = moved === null ? rec.target.realDir : path.join(ctx.root, rec.target.dirName)
  const area =
    moved === null
      ? path.dirname(rec.backupDest)
      : backupAreaPath(stateRealOf(r, rec), rec.target.client, ctx.root, rec.target.dirName)
  const expect = moved === null ? expectOfRecord(rec) : expectOfMoved(rec, ctx.root)
  // The op dir the intent must name: the record's, or (moved) this op dir as it is now.
  const intentOp =
    moved === null
      ? { opId: rec.opId, opIdentity: rec.opDirIdentity }
      : { opId, opIdentity: v.opIdentity }
  const entry = await r.manifestEntry(
    rec.target.manifestPath,
    rec.target.manifestKey,
    rec.preEntry,
    rec.postEntry
  )
  const t: TreeObs = observeTree(r, tPath)
  const view = observeGroups(r, { opDir, opId, area, expect, opIdentity: v.opIdentity })
  const resolved = resolveRoles(r, opDir, rec, view.groups, accept, moved === null)
  const tmpRead = analyzeRecordTmp(r, opDir, names, rec)
  // `owner.json` is a metadata file doctor unlinks: read through the reader so
  // its identity and bytes are in the digest, which is what adoption checks.
  if (names.includes(OWNER_FILE)) r.readFile(path.join(opDir, OWNER_FILE), OWNER_CAP)
  const recordTmp = tmpRead === null ? null : tmpRead.tmp
  const journal = r.journalHasUpdate(opId, ctx.journalFile)
  const nSource = resolved.roles.N.kind === 'source' ? resolved.roles.N.obs : null
  const tS = tStateOf(t, rec, accept)
  const facts: OpFacts = {
    opId,
    opDir,
    record: rec,
    tPath,
    tState: tS,
    t,
    manifest: entry.ok ? entry.state : null,
    manifestRefusal: entry.ok ? null : entry.refusal,
    roles: resolved.roles,
    groups: view.groups,
    area,
    moved: moved?.why ?? null,
    opIdentity: v.opIdentity,
    hasOwnerFile: names.includes(OWNER_FILE),
    journal: journal.ok ? journal : null,
    otherUid: rec.uid !== ctx.euid ? rec.uid : null,
    // A moved op's marker names the record's own area; it is followed only when that is this one.
    fullDevice: moved === null || rec.fullDevice?.area === area ? (rec.fullDevice ?? null) : null,
    recordTmp,
    nHashesToPost: nSource === null ? null : nSource.hash === rec.postTree,
    ...analyzeParkIntent(r, opDir, names, intentOp),
  }
  const base = { opId, opDir }
  // O4: only this op dir's own abandon makes AB, never another copy's keeps.
  const abandoned = view.groups
    .filter((g) => !g.otherCopy && g.kind.startsWith('abandoned-'))
    .map((g) => g.base)
  if (moved !== null) {
    // Only `--abandon` acts on it; its plan refuses any entry it cannot act on.
    if (abandoned.length > 0) return { kind: 'ab', ...base, facts, abandoned }
    return { kind: 'moved', ...base, ...moved, otherUid: facts.otherUid, facts }
  }
  const elseWith = (reason: string): RecoveryClass => ({
    kind: 'anything-else',
    ...base,
    reason,
    facts,
  })

  if (recordTmp !== null && !recordTmp.sameInode) {
    if (recordTmp.hasMarker && recordTmp.bodyMatches) {
      // A marker rewrite that crashed after the temp's sync: the op is marked with the temp's marker.
      if (tmpRead !== null && tmpRead.marker !== null) facts.fullDevice = tmpRead.marker
    } else if (recordTmp.hasMarker) {
      return {
        kind: 'unreadable',
        ...base,
        why: 'inconsistent-record',
        detail: `${recordTmp.path} carries a full-device marker but is not this record's body`,
        observed: null,
      }
    } else if (!recordTmp.bodyMatches && !recordTmp.emptySingleLink) {
      return elseWith(`${recordTmp.path} is not provably this operation's`)
    }
  }
  if (facts.parkIntent !== null && !facts.parkIntent.valid) {
    return elseWith(`${facts.parkIntent.path} is not this operation's move-source park intent`)
  }
  if (facts.parkIntentTmp !== null && !facts.parkIntentTmp.provable) {
    return elseWith(`${facts.parkIntentTmp.path} is not provably this operation's`)
  }
  const fd = facts.fullDevice
  if (fd !== null && (fd.opId !== opId || fd.area !== area || path.dirname(fd.dest) !== area)) {
    // Its leftovers are read from the record's own area; a marker naming another is not followed.
    return elseWith(
      `the full-device marker names ${fd.dest}, outside this operation's area ${area}`
    )
  }
  if (!entry.ok) return elseWith(`the manifest could not be read (${entry.refusal})`)
  if (view.listError !== null)
    return elseWith(`the backup area could not be listed (${view.listError})`)
  const cp = r.realpath(rec.target.comparedPath)
  if (cp.ok && t.present && cp.path !== tPath) {
    return elseWith(`comparedPath now resolves to ${cp.path}, not ${tPath}`)
  }
  if (abandoned.length > 0) return { kind: 'ab', ...base, facts, abandoned }
  const unclassified = view.groups.find((g) => g.unclassified !== null)
  if (unclassified !== undefined) {
    return elseWith(`${unclassified.base} is kept but ${unclassified.unclassified}`)
  }
  if (tS === 'not-directory') return elseWith('the skill path is not a directory')
  const changed: TreePosition[] = [
    ...(tS === 'identity-changed' ? (['T'] as const) : []),
    ...resolved.changed,
  ]
  if (changed.length > 0) return { kind: 'identity-changed', ...base, positions: changed, facts }
  if (resolved.conflicts.length > 0) return elseWith(resolved.conflicts.join('; '))
  const row = matchRow(tS, resolved.roles, entry.state)
  if (row === null) return elseWith('no row of the state table matches the trees and the manifest')
  return { kind: 'state', ...base, ...row, facts }
}

/** What one operation directory of a staging dir is. */
export async function classifyOp(
  r: ClassifierReader,
  ctx: ClassifyContext,
  opId: string
): Promise<RecoveryClass> {
  const opDir = path.join(ctx.stagingDir, opId)
  const base = { opId, opDir }
  const dir = r.stat(opDir)
  if (!dir.ok) {
    return DENIED.has(dir.errno)
      ? { kind: 'other-user', ...base, ownerUid: null, errno: dir.errno }
      : {
          kind: 'unreadable',
          ...base,
          why: 'open-failed',
          errno: dir.errno,
          detail: 'the op dir cannot be inspected',
          observed: null,
        }
  }
  if (dir.type !== 'dir') {
    return {
      kind: 'anything-else',
      ...base,
      reason: 'the op dir entry is not a directory',
      facts: null,
    }
  }
  const listed = r.list(opDir, { name: 'all' })
  if (!listed.ok) {
    return DENIED.has(listed.errno)
      ? { kind: 'other-user', ...base, ownerUid: dir.uid, errno: listed.errno }
      : {
          kind: 'unreadable',
          ...base,
          why: 'open-failed',
          errno: listed.errno,
          detail: 'the op dir cannot be listed',
          observed: null,
        }
  }
  if (listed.names.length === 0) return { kind: 'empty-op-dir', ...base }
  const cls = await classifyListed(r, ctx, base, dir, listed.names)
  // 6b-i: the record file failed in a listed op dir: read what `--park` would move.
  return cls.kind === 'unreadable' ? observeUnreadable(r, ctx.euid, cls, dir, listed.names) : cls
}

/** An op dir that was `lstat`ed as a directory and listed, with at least one entry. */
async function classifyListed(
  r: ClassifierReader,
  ctx: ClassifyContext,
  base: { opId: string; opDir: string },
  dir: Extract<StatFact, { ok: true }>,
  names: readonly string[]
): Promise<RecoveryClass> {
  const { opId, opDir } = base
  const read = r.readFile(path.join(opDir, RECORD_FILE), MAX_RECORD_BYTES + 1)
  const unreadable = (
    why: UnreadableWhy,
    more: { errno?: string; detail?: string } = {}
  ): RecoveryClass => ({ kind: 'unreadable', ...base, why, ...more, observed: null })
  if (!read.fact.ok) {
    const errno = read.fact.errno
    if (errno === 'ENOENT') return noRecord(r, ctx, base, names, dir.identity)
    if (DENIED.has(errno)) return { kind: 'other-user', ...base, ownerUid: dir.uid, errno }
    if (errno === 'NOT_A_FILE') return unreadable('not-a-file')
    return unreadable('open-failed', { errno })
  }
  const parsed = parseRecordBytes(read.bytes!)
  if (!parsed.ok) return unreadable(parsed.why)
  const rec = parsed.record

  // A record that verifies but belongs elsewhere is `moved`: only its owner root or op
  // dir could finish it, so here only `--abandon` acts on it (6b-iii), from facts it observes.
  const moved = movedOf(r, ctx.root, opId, rec, dir.identity)
  // The consistency checks need no root of the scan, so a moved record gets them too.
  const why = inconsistency(r, rec)
  if (why !== null) return unreadable('inconsistent-record', { detail: why })
  return classifyRecorded(r, ctx, { opId, opDir, rec, names, opIdentity: dir.identity, moved })
}
