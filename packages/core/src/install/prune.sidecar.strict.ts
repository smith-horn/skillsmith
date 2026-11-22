/**
 * SMI-6531 (A1 step 6c-i; split out for #3283): the strict sidecar schema of
 * both stores (`prune.sidecar.ts` describes them), with no filesystem access:
 * it parses bytes already read. Prune's classifier and `skillsmith restore`
 * parse with it, and doctor's install classifier asks restore's question with
 * it on the bytes its reader read (`skill-restore.verdict.ts`).
 *
 * @module @skillsmith/core/install/prune.sidecar.strict
 */
import path from 'node:path'
import type { HeldReason } from './park-tree.verify.js'
import { parseBackupSidecarStrict } from './backup-sidecar.strict.js'

const HASH = /^[0-9a-f]{64}$/
const isHash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v)

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
