/**
 * SMI-6531 (A1 step 6c-i): the stable read and the strict sidecar schema for
 * prune (ADR-166 D-11), ported from the SMI-6676 spike's `prune.sidecar.mjs`.
 *
 * Two stores carry a sidecar beside each copy, and both are parsed here:
 *  - a parked copy (`<area>/.skillsmith-parked/<opId>/<name>-<8 hex>`, sidecar
 *    written by `park-tree.postmove.ts`), in one of three shapes: `U` (parked
 *    without a guard hash), `Q` (verified after the move) and `H` (held). Its
 *    recorded hash is `postMoveTreeHash`;
 *  - a kept tree in the update backup area (`<area>/<dirName>/<opId>` or
 *    `<opId>.<kind>[.<k>]`, sidecar `Sidecar` from `skill-swap.sidecar.ts`),
 *    shape `B`. Its recorded hash is `treeHash`.
 * A sidecar that fails the schema of its store counts as unverified, never
 * clean (ADR-166 D-10 item 4).
 *
 * fs is imported as the DEFAULT export only, and every call looks its method
 * up at call time, so an interposer sees every call (D-11 "Enforcement in tests").
 *
 * No caller yet: 6c-ii's listing and 6c-iii's `--prune --apply` use it.
 *
 * @module @skillsmith/core/install/prune.sidecar
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { errCode } from './park-result.js'
import type { HeldReason } from './park-tree.verify.js'
import type { PartialCause, PublishKind, Sidecar } from '../services/skill-swap.sidecar.js'

const HASH = /^[0-9a-f]{64}$/
const isHash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v)

/** A stable read that succeeded: the bytes, and the descriptor's metadata. */
export interface StableReadOk {
  ok: true
  bytes: Buffer
  dev: bigint
  ino: bigint
  size: bigint
  mode: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export type StableRead =
  | StableReadOk
  | {
      ok: false
      reason: 'unreadable' | 'not-a-file' | 'replaced-while-reading' | 'changed-while-reading'
      errno: string | null
    }

/**
 * The stable read: open with O_NOFOLLOW, require the descriptor's inode to be
 * the one lstat names, read everything, fstat again, and require size, mtimeNs
 * and ctimeNs unchanged. A same-size write between the two reads changes ctime
 * (ns resolution where the filesystem has it) and is reported, never returned
 * as data.
 *
 * `afterRead` is a test seam: called after the read, before the second fstat.
 */
export function readStable(p: string, { afterRead }: { afterRead?: () => void } = {}): StableRead {
  let ls: BigIntStats
  try {
    ls = fs.lstatSync(p, { bigint: true })
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: errCode(err) }
  }
  if (!ls.isFile()) return { ok: false, reason: 'not-a-file', errno: null }
  let fd: number
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: errCode(err) }
  }
  try {
    const a = fs.fstatSync(fd, { bigint: true })
    if (a.ino !== ls.ino || a.dev !== ls.dev) {
      return { ok: false, reason: 'replaced-while-reading', errno: null }
    }
    const bytes = fs.readFileSync(fd)
    if (typeof afterRead === 'function') afterRead()
    const b = fs.fstatSync(fd, { bigint: true })
    if (
      b.size !== a.size ||
      b.mtimeNs !== a.mtimeNs ||
      b.ctimeNs !== a.ctimeNs ||
      BigInt(bytes.length) !== a.size
    ) {
      return { ok: false, reason: 'changed-while-reading', errno: null }
    }
    return {
      ok: true,
      bytes,
      dev: a.dev,
      ino: a.ino,
      size: a.size,
      mode: a.mode,
      mtimeNs: a.mtimeNs,
      ctimeNs: a.ctimeNs,
    }
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: errCode(err) }
  } finally {
    fs.closeSync(fd)
  }
}

/** Which store a copy was found in, which decides the schema its sidecar must pass. */
export type SidecarStore = 'parked' | 'backup'

/** `U`, `Q` and `H` are the parked shapes; `B` is a backup-area sidecar. */
export type SidecarShape = 'U' | 'Q' | 'H' | 'B'

export type SidecarParse =
  | {
      ok: true
      store: SidecarStore
      shape: SidecarShape
      sidecar: Record<string, unknown>
      /** The hash the sidecar recorded for the copy, or null when it recorded none. */
      recordedHash: string | null
    }
  | { ok: false; reason: 'unparseable' | 'schema-invalid'; detail: string }

/** The parked sidecar's keys (`park-tree.postmove.ts` `finishAfterRename`), per shape. */
const PARKED_BASE = [
  'opId',
  'kind',
  'client',
  'rootKey',
  'originPath',
  'treeHash',
  'bytes',
  'createdAt',
  'skillsmithVersion',
]
const PARKED_SHAPES: Record<'U' | 'Q' | 'H', string[]> = {
  U: PARKED_BASE,
  Q: [...PARKED_BASE, 'postMoveVerified', 'postMoveTreeHash'],
  H: [...PARKED_BASE, 'hold', 'reason', 'heldPath', 'guardHash', 'postMoveTreeHash'],
}
const HELD_REASON_TABLE = {
  'changed-during-move': true,
  'mount-appeared-during-move': true,
} satisfies Record<HeldReason, true>
const HELD_REASONS: ReadonlySet<string> = new Set(Object.keys(HELD_REASON_TABLE))

/** The backup sidecar's keys (`skill-swap.sidecar.ts` `Sidecar`), required and optional. */
const BACKUP_REQUIRED = [
  'opId',
  'kind',
  'dirName',
  'createdAt',
  'treeHash',
  'identity',
  'client',
  'skillsDir',
  'scope',
  'manifestKey',
] as const satisfies readonly (keyof Sidecar)[]
const BACKUP_OPTIONAL = [
  'treeHashError',
  'sourceUnchanged',
  'partialCause',
  'opDirIdentity',
] as const satisfies readonly (keyof Sidecar)[]
/** `satisfies` makes a new `PublishKind` a compile error here until it is listed. */
const KIND_TABLE = {
  backup: true,
  undone: true,
  conflict: true,
  'failed-build': true,
  'edited-new': true,
  'unrecorded-new': true,
  'partial-copy': true,
  'unused-new': true,
  'abandoned-old': true,
  'abandoned-new': true,
  'abandoned-undone': true,
} satisfies Record<PublishKind, true>
const KINDS: ReadonlySet<string> = new Set(Object.keys(KIND_TABLE))
const PARTIAL_CAUSE_TABLE = {
  enospc: true,
  mismatch: true,
  'copy-failed': true,
} satisfies Record<PartialCause, true>
const PARTIAL_CAUSES: ReadonlySet<string> = new Set(Object.keys(PARTIAL_CAUSE_TABLE))
const DECIMAL = /^[0-9]+$/

const sameKeys = (obj: object, keys: readonly string[]): boolean =>
  Object.keys(obj).sort().join('\0') === [...keys].sort().join('\0')

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function roundTrips(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const d = new Date(v)
  return !Number.isNaN(d.getTime()) && d.toISOString() === v
}
const isSegment = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  !v.startsWith('.') &&
  !v.includes('/') &&
  !v.includes('\\')
const isRecordIdentity = (v: unknown): boolean =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  sameKeys(v, ['dev', 'ino', 'birthtimeNs', 'fmt']) &&
  Object.values(v).every((x) => typeof x === 'string' && DECIMAL.test(x))

type Bad = { ok: false; reason: 'schema-invalid'; detail: string }
const bad = (detail: string): Bad => ({ ok: false, reason: 'schema-invalid', detail })

/** The parked shapes: exactly one key set, no extras, nothing missing. */
function parseParked(
  s: Record<string, unknown>,
  copyPath: string,
  parentName: string
): SidecarParse {
  const optional = Object.prototype.hasOwnProperty.call(s, 'bytesError')
  const have = Object.keys(s)
    .filter((k) => k !== 'bytesError')
    .sort()
    .join('\0')
  let shape: 'U' | 'Q' | 'H' | null = null
  for (const [k, ks] of Object.entries(PARKED_SHAPES)) {
    if (have === [...ks].sort().join('\0')) shape = k as 'U' | 'Q' | 'H'
  }
  if (shape === null) return bad(`key set matches no shape: ${Object.keys(s).sort().join(',')}`)
  if (s.opId !== parentName) return bad(`opId ${JSON.stringify(s.opId)} is not the op dir name`)
  if (typeof s.originPath !== 'string' || !path.isAbsolute(s.originPath)) {
    return bad('originPath is not an absolute path')
  }
  const want = new RegExp(`^${escapeRe(path.basename(s.originPath))}-[0-9a-f]{8}$`)
  if (!want.test(path.basename(copyPath))) {
    return bad('originPath basename plus -<8 hex> is not the copy name')
  }
  // The park records an uncountable tree as `bytes: null` plus `bytesError`.
  if (optional) {
    if (s.bytes !== null || typeof s.bytesError !== 'string') {
      return bad('bytesError must be a string, and only with bytes null')
    }
  } else if (!Number.isSafeInteger(s.bytes) || (s.bytes as number) < 0) {
    return bad('bytes is not a non-negative safe integer')
  }
  if (!roundTrips(s.createdAt)) return bad('createdAt does not round-trip through Date')
  for (const k of ['kind', 'client', 'skillsmithVersion']) {
    if (typeof s[k] !== 'string') return bad(`${k} is not a string`)
  }
  if (s.rootKey !== null && typeof s.rootKey !== 'string') {
    return bad('rootKey is not a string or null')
  }
  if (shape === 'U') {
    if (s.treeHash !== null) return bad('U: treeHash must be null')
    return { ok: true, store: 'parked', shape, sidecar: s, recordedHash: null }
  }
  if (shape === 'Q') {
    if (s.postMoveVerified !== true) return bad('Q: postMoveVerified must be true')
    if (!isHash(s.treeHash) || !isHash(s.postMoveTreeHash)) return bad('Q: a hash is malformed')
    if (s.treeHash !== s.postMoveTreeHash) return bad('Q: treeHash differs from postMoveTreeHash')
    return { ok: true, store: 'parked', shape, sidecar: s, recordedHash: s.postMoveTreeHash }
  }
  if (s.hold !== true) return bad('H: hold must be true')
  if (typeof s.reason !== 'string' || !HELD_REASONS.has(s.reason)) {
    return bad(`H: reason ${JSON.stringify(s.reason)} unknown`)
  }
  if (s.heldPath !== copyPath) return bad('H: heldPath is not the copy path')
  if (!isHash(s.treeHash) || !isHash(s.guardHash)) return bad('H: a hash is malformed')
  if (s.postMoveTreeHash !== null && !isHash(s.postMoveTreeHash)) {
    return bad('H: postMoveTreeHash is neither a hash nor null')
  }
  return {
    ok: true,
    store: 'parked',
    shape,
    sidecar: s,
    recordedHash: (s.postMoveTreeHash as string | null) ?? null,
  }
}

/** The backup-area shape (`Sidecar`): its required keys, and each optional one only where it applies. */
function parseBackup(
  s: Record<string, unknown>,
  copyPath: string,
  parentName: string
): SidecarParse {
  const known: readonly string[] = [...BACKUP_REQUIRED, ...BACKUP_OPTIONAL]
  const extra = Object.keys(s).find((k) => !known.includes(k))
  if (extra !== undefined) return bad(`unknown key ${extra}`)
  const missing = BACKUP_REQUIRED.find((k) => !Object.prototype.hasOwnProperty.call(s, k))
  if (missing !== undefined) return bad(`${missing} missing`)
  if (!isSegment(s.opId)) return bad('opId is not a single path segment')
  if (typeof s.kind !== 'string' || !KINDS.has(s.kind)) {
    return bad(`kind ${JSON.stringify(s.kind)} unknown`)
  }
  const name = path.basename(copyPath)
  const nameOk =
    s.kind === 'backup'
      ? name === s.opId
      : new RegExp(`^${escapeRe(s.opId)}\\.${escapeRe(s.kind)}(\\.[1-9][0-9]*)?$`).test(name)
  if (!nameOk) return bad('the copy name is not <opId> or <opId>.<kind>[.<k>] for this sidecar')
  if (s.dirName !== parentName) return bad('dirName is not the area directory name')
  if (!roundTrips(s.createdAt)) return bad('createdAt does not round-trip through Date')
  if (s.treeHash !== null && !isHash(s.treeHash)) return bad('treeHash is neither a hash nor null')
  if (!isRecordIdentity(s.identity)) return bad('identity is malformed')
  for (const k of ['client', 'scope', 'manifestKey']) {
    if (typeof s[k] !== 'string') return bad(`${k} is not a string`)
  }
  if (typeof s.skillsDir !== 'string' || !path.isAbsolute(s.skillsDir)) {
    return bad('skillsDir is not an absolute path')
  }
  if (
    s.treeHashError !== undefined &&
    (typeof s.treeHashError !== 'string' || s.treeHash !== null)
  ) {
    return bad('treeHashError must be a string, and only with treeHash null')
  }
  const partial = s.kind === 'partial-copy'
  if (s.sourceUnchanged !== undefined && (!partial || typeof s.sourceUnchanged !== 'boolean')) {
    return bad('sourceUnchanged must be a boolean, on a partial-copy only')
  }
  if (
    s.partialCause !== undefined &&
    (!partial || typeof s.partialCause !== 'string' || !PARTIAL_CAUSES.has(s.partialCause))
  ) {
    return bad('partialCause must be a known cause, on a partial-copy only')
  }
  if (
    s.opDirIdentity !== undefined &&
    (!s.kind.startsWith('abandoned-') || !isRecordIdentity(s.opDirIdentity))
  ) {
    return bad('opDirIdentity must be an identity, on an abandoned-* tree only')
  }
  return {
    ok: true,
    store: 'backup',
    shape: 'B',
    sidecar: s,
    recordedHash: (s.treeHash as string | null) ?? null,
  }
}

/**
 * The strict schema of `store`. Anything else is `schema-invalid` (or
 * `unparseable`), which classifies as unverified.
 *
 * `parentName` is the name of the directory holding the copy: for a parked
 * copy its op dir, which must equal `opId`; for a backup its area directory,
 * which must equal `dirName`.
 */
export function parseSidecarStrict(
  bytes: Buffer | string,
  { copyPath, parentName, store }: { copyPath: string; parentName: string; store: SidecarStore }
): SidecarParse {
  let s: unknown
  try {
    s = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes))
  } catch {
    return { ok: false, reason: 'unparseable', detail: 'sidecar is not JSON' }
  }
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return bad('not a JSON object')
  if (Object.getPrototypeOf(s) !== Object.prototype) return bad('not a plain object')
  const o = s as Record<string, unknown>
  return store === 'parked'
    ? parseParked(o, copyPath, parentName)
    : parseBackup(o, copyPath, parentName)
}
