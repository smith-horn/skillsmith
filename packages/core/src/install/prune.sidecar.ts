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
 *    shape `B`, checked by the one shared strict parser
 *    (`backup-sidecar.strict.ts`) plus where the tree sits. Its recorded hash
 *    is `treeHash`.
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
import { parseBackupSidecarStrict } from './backup-sidecar.strict.js'

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
      reason:
        | 'unreadable'
        | 'not-a-file'
        | 'too-large'
        | 'replaced-while-reading'
        | 'changed-while-reading'
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
 * `maxBytes` refuses a larger file (`too-large`) before it is opened, and
 * again from the descriptor's own size before anything is read.
 */
export function readStable(
  p: string,
  { afterRead, maxBytes }: { afterRead?: () => void; maxBytes?: number } = {}
): StableRead {
  let ls: BigIntStats
  try {
    ls = fs.lstatSync(p, { bigint: true })
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: errCode(err) }
  }
  if (!ls.isFile()) return { ok: false, reason: 'not-a-file', errno: null }
  if (maxBytes !== undefined && ls.size > BigInt(maxBytes)) {
    return { ok: false, reason: 'too-large', errno: null }
  }
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
    if (maxBytes !== undefined && a.size > BigInt(maxBytes)) {
      return { ok: false, reason: 'too-large', errno: null }
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function roundTrips(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const d = new Date(v)
  return !Number.isNaN(d.getTime()) && d.toISOString() === v
}
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

/**
 * The backup-area shape: the shared strict schema (`backup-sidecar.strict.ts`),
 * plus where the tree sits: named `<opId>` (a backup) or `<opId>.<kind>[.<k>]`,
 * in the area directory its `dirName` names.
 */
function parseBackup(
  s: Record<string, unknown>,
  copyPath: string,
  parentName: string
): SidecarParse {
  const r = parseBackupSidecarStrict(s)
  if (!r.ok) return bad(r.detail)
  const sc = r.sidecar
  const name = path.basename(copyPath)
  const nameOk =
    sc.kind === 'backup'
      ? name === sc.opId
      : new RegExp(`^${escapeRe(sc.opId)}\\.${escapeRe(sc.kind)}(\\.[1-9][0-9]*)?$`).test(name)
  if (!nameOk) return bad('the copy name is not <opId> or <opId>.<kind>[.<k>] for this sidecar')
  if (sc.dirName !== parentName) return bad('dirName is not the area directory name')
  return { ok: true, store: 'backup', shape: 'B', sidecar: s, recordedHash: sc.treeHash }
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
