/**
 * SMI-6531 (A1 step 6a-i): doctor's classifier (plan §3.3 "Doctor
 * classification", the state table and "Role resolution"; design § 2).
 *
 * `classifyOp(reader, ctx, opId)` reads one operation directory of a skills
 * root's staging and says what it is, as a `RecoveryClass`:
 *
 *  - without a verified record: `empty-op-dir`, `no-record`, `unreadable`
 *    (including `inconsistent-record`), `other-user`, or `moved` (a record that
 *    verifies but belongs to another root or op dir);
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
import { analyzeParkIntent, noRecordIntent } from './skill-recovery.opdir.js'
import { observeGroups, ROLE_DIR } from './skill-recovery.pstate.js'
import type { ClassifierReader } from './skill-recovery.reader.js'
import { observeTree, sameId, sourceCheck, tStateOf } from './skill-recovery.trees.js'
import type {
  KeepGroup,
  OpFacts,
  RecoveryClass,
  Role,
  RoleRes,
  RowState,
  TreeObs,
  TreePosition,
  TState,
} from './skill-recovery.types.js'
import { backupAreaPath } from './skill-swap.area.js'
import { MAX_RECORD_BYTES, parseRecordBytes } from './skill-swap.record-schema.js'
import { OWNER_FILE, PARK_INTENT_FILE, RECORD_FILE } from './skill-swap.types.js'
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
}

const OWNER_CAP = 4096
const DENIED = new Set(['EACCES', 'EPERM'])

/** One path component: not empty, not `.`/`..`, no separator or NUL. */
const oneComponent = (s: string): boolean =>
  s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0')

/** `record.json` is internally consistent (plan §3.3 `inconsistent-record`); the reason, or null. */
function inconsistency(r: ClassifierReader, root: string, rec: SwapRecord): string | null {
  const t = rec.target
  if (rec.op !== 'update') return `its op is ${JSON.stringify(rec.op)}, not "update"`
  for (const [name, v] of [
    ['client', t.client],
    ['scope', t.scope],
    ['dirName', t.dirName],
  ] as const) {
    if (!oneComponent(v)) return `${name} ${JSON.stringify(v)} is not a single path component`
  }
  if (t.dirName !== path.basename(t.comparedPath)) return 'dirName is not the name of comparedPath'
  if (!path.isAbsolute(t.manifestPath) || path.basename(t.manifestPath) !== 'manifest.json') {
    return 'manifestPath is not an absolute path to a manifest.json'
  }
  if (path.dirname(t.realDir) !== root) return 'realDir is not directly inside the skills root'
  const stateDir = path.dirname(t.manifestPath)
  const real = r.realpath(stateDir)
  const stateReal = real.ok ? real.path : path.resolve(stateDir)
  const area = backupAreaPath(stateReal, t.client, root, t.dirName)
  if (rec.backupDest !== path.join(area, rec.opId)) {
    return 'backupDest is not the backup area the update computes for it, plus its opId'
  }
  if (
    !r.portAccepts({
      manifestPath: t.manifestPath,
      manifestKey: t.manifestKey,
      preEntry: rec.preEntry,
      postEntry: rec.postEntry,
    }).ok
  ) {
    return 'the manifest port rejects its preEntry and postEntry'
  }
  return null
}

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

const STARTED = new Set(['P1', 'P2', 'P3', 'P4', 'R1', 'R2', 'R3'])

/** Resolves O, N and U to a source, one verified keep, or nothing (plan §3.3 "Role resolution"). */
function resolveRoles(
  r: ClassifierReader,
  opDir: string,
  rec: SwapRecord,
  groups: readonly KeepGroup[],
  acceptIdentity: boolean
): RoleResolution {
  const conflicts: string[] = []
  const changed: TreePosition[] = []
  const one = (role: Role): RoleRes => {
    const obs = observeTree(r, path.join(opDir, ROLE_DIR[role]))
    const keeps = groups.filter((g) => g.role === role && g.verified)
    if (obs.present) {
      const chk = sourceCheck(role, obs, rec, acceptIdentity)
      if (chk === 'not-directory') conflicts.push(`${role} is not a directory`)
      else if (chk === 'foreign') conflicts.push(`${role} has neither its identity nor its hash`)
      else if (chk === 'identity-changed') changed.push(role)
      if (keeps.length > 0) conflicts.push(`${role} is both a source and a kept copy`)
      const started =
        groups.find((g) => g.role === role && g.state !== null && STARTED.has(g.state)) ?? null
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

/** A verified record: observe everything, then match a row. */
async function classifyRecorded(
  r: ClassifierReader,
  ctx: ClassifyContext,
  opId: string,
  opDir: string,
  rec: SwapRecord,
  names: readonly string[]
): Promise<RecoveryClass> {
  const accept = ctx.acceptIdentity === true
  const tPath = rec.target.realDir
  const area = path.dirname(rec.backupDest)
  const entry = await r.manifestEntry(
    rec.target.manifestPath,
    rec.target.manifestKey,
    rec.preEntry,
    rec.postEntry
  )
  const t: TreeObs = observeTree(r, tPath)
  const view = observeGroups(r, { opDir, opId, area, rec })
  const resolved = resolveRoles(r, opDir, rec, view.groups, accept)
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
    journal: journal.ok ? journal : null,
    otherUid: rec.uid !== ctx.euid ? rec.uid : null,
    fullDevice: rec.fullDevice ?? null,
    recordTmp,
    nHashesToPost: nSource === null ? null : nSource.hash === rec.postTree,
    ...analyzeParkIntent(r, opDir, names, rec),
  }
  const base = { opId, opDir }
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
  const abandoned = view.groups.filter((g) => g.kind.startsWith('abandoned-')).map((g) => g.base)
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
        }
  }
  if (listed.names.length === 0) return { kind: 'empty-op-dir', ...base }

  const read = r.readFile(path.join(opDir, RECORD_FILE), MAX_RECORD_BYTES + 1)
  if (!read.fact.ok) {
    const errno = read.fact.errno
    if (errno === 'ENOENT') return noRecord(r, ctx, base, listed.names, dir.identity)
    if (DENIED.has(errno)) return { kind: 'other-user', ...base, ownerUid: dir.uid, errno }
    if (errno === 'NOT_A_FILE') return { kind: 'unreadable', ...base, why: 'not-a-file' }
    return { kind: 'unreadable', ...base, why: 'open-failed', errno }
  }
  const parsed = parseRecordBytes(read.bytes!)
  if (!parsed.ok) return { kind: 'unreadable', ...base, why: parsed.why }
  const rec = parsed.record

  // A record that verifies but belongs elsewhere is `moved`: only its owner root or op dir can finish it.
  const moved = (
    why: 'foreign-root' | 'foreign-op-dir' | 'root-identity' | 'op-dir-identity',
    detail: string
  ): RecoveryClass => ({
    kind: 'moved',
    ...base,
    why,
    detail,
    otherUid: rec.uid !== ctx.euid ? rec.uid : null,
  })
  if (rec.opId !== opId) return moved('foreign-op-dir', `the record names operation ${rec.opId}`)
  if (rec.target.skillsDir !== ctx.root) {
    return moved('foreign-root', `the record names the skills root ${rec.target.skillsDir}`)
  }
  const rootNow = r.stat(ctx.root)
  if (!rootNow.ok || !sameId(rec.rootIdentity, rootNow.identity)) {
    return moved('root-identity', 'the skills root is not the one the record was written for')
  }
  if (!sameId(rec.opDirIdentity, dir.identity)) {
    return moved('op-dir-identity', 'the op dir is not the one the record was written for')
  }
  const why = inconsistency(r, ctx.root, rec)
  if (why !== null) {
    return { kind: 'unreadable', ...base, why: 'inconsistent-record', detail: why }
  }
  return classifyRecorded(r, ctx, opId, opDir, rec, listed.names)
}

/** An op dir with no `record.json`: its owner (if any), its entries, whether a park intent is there. */
function noRecord(
  r: ClassifierReader,
  ctx: ClassifyContext,
  base: { opId: string; opDir: string },
  names: readonly string[],
  opIdentity: RecordIdentity
): RecoveryClass {
  let owner: { pid: number | null; host: string | null; uid: number | null } | null = null
  if (names.includes(OWNER_FILE)) {
    const read = r.readFile(path.join(base.opDir, OWNER_FILE), OWNER_CAP)
    if (read.bytes !== null) {
      try {
        const v = JSON.parse(read.bytes.toString('utf8')) as Record<string, unknown>
        owner = {
          pid: typeof v.pid === 'number' ? v.pid : null,
          host: typeof v.host === 'string' ? v.host : null,
          uid: typeof v.uid === 'number' ? v.uid : null,
        }
      } catch {
        owner = { pid: null, host: null, uid: null }
      }
    }
  }
  const intent = noRecordIntent(r, {
    ...base,
    root: ctx.root,
    names,
    opIdentity,
    stateRoots: ctx.stateRoots ?? [],
  })
  // Whose op dir this is: owner.json's uid, else the verifying intent's (6a-iii).
  const uid = owner?.uid ?? (intent?.valid === true ? intent.ownerUid : null)
  return {
    kind: 'no-record',
    ...base,
    owner,
    entries: [...names],
    hasParkIntent: names.includes(PARK_INTENT_FILE),
    otherUid: uid !== null && uid !== ctx.euid ? uid : null,
    intent,
    recordTmp: names.includes(`${RECORD_FILE}.tmp`)
      ? path.join(base.opDir, `${RECORD_FILE}.tmp`)
      : null,
  }
}
