/**
 * SMI-6531 (A1 step 6c-i): the one strict parser of a backup-area sidecar
 * (`Sidecar`, written by `services/skill-swap.sidecar.ts` `sidecarOf`), shared
 * by every reader that must refuse anything it did not write (owner decision
 * 2026-11-05). fs-free, and in `src/install` so prune can use it inside its fs
 * boundary. Prune uses it now; moving doctor's recovery reader
 * (`skill-recovery.pstate.ts`) onto it is SMI-7214.
 *
 * The key table is exhaustive over `Sidecar`: a new key, or one whose
 * optionality changes, fails to compile here until it is classified.
 *
 * @module @skillsmith/core/install/backup-sidecar.strict
 */
import path from 'node:path'
import type { PartialCause, PublishKind, Sidecar } from '../services/skill-swap.sidecar.js'

/** For each `Sidecar` key: 'optional' exactly when the type makes it optional. */
type KeyTable = {
  [K in keyof Sidecar]-?: object extends Pick<Sidecar, K> ? 'optional' : 'required'
}

/** Every `Sidecar` key, classified. */
export const SIDECAR_KEYS = {
  opId: 'required',
  kind: 'required',
  dirName: 'required',
  createdAt: 'required',
  treeHash: 'required',
  treeHashError: 'optional',
  identity: 'required',
  client: 'required',
  skillsDir: 'required',
  scope: 'required',
  manifestKey: 'required',
  sourceUnchanged: 'optional',
  partialCause: 'optional',
  opDirIdentity: 'optional',
} as const satisfies KeyTable

/** Every kind `sidecarOf` writes. `satisfies` makes a new `PublishKind` a compile error until listed. */
export const PUBLISH_KIND_TABLE = {
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
const KINDS: ReadonlySet<string> = new Set(Object.keys(PUBLISH_KIND_TABLE))
const PARTIAL_CAUSE_TABLE = {
  enospc: true,
  mismatch: true,
  'copy-failed': true,
} satisfies Record<PartialCause, true>
const PARTIAL_CAUSES: ReadonlySet<string> = new Set(Object.keys(PARTIAL_CAUSE_TABLE))

const HASH = /^[0-9a-f]{64}$/
const DECIMAL = /^[0-9]+$/
const KNOWN: ReadonlySet<string> = new Set(Object.keys(SIDECAR_KEYS))
const REQUIRED = Object.entries(SIDECAR_KEYS)
  .filter(([, v]) => v === 'required')
  .map(([k]) => k)

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const isSegment = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  !v.startsWith('.') &&
  !v.includes('/') &&
  !v.includes('\\')
const isIdentity = (v: unknown): boolean =>
  isObj(v) &&
  Object.keys(v).sort().join(',') === 'birthtimeNs,dev,fmt,ino' &&
  Object.values(v).every((x) => typeof x === 'string' && DECIMAL.test(x))
function roundTrips(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const d = new Date(v)
  return !Number.isNaN(d.getTime()) && d.toISOString() === v
}

export type BackupSidecarParse = { ok: true; sidecar: Sidecar } | { ok: false; detail: string }

/**
 * The strict schema of a parsed backup sidecar: a plain object with exactly
 * the classified keys, each typed, and each optional key only on the kind it
 * belongs to. Says nothing about where the tree sits; a caller that knows
 * the path checks that itself.
 */
export function parseBackupSidecarStrict(v: unknown): BackupSidecarParse {
  const bad = (detail: string): BackupSidecarParse => ({ ok: false, detail })
  if (!isObj(v) || Object.getPrototypeOf(v) !== Object.prototype) return bad('not a plain object')
  const extra = Object.keys(v).find((k) => !KNOWN.has(k))
  if (extra !== undefined) return bad(`unknown key ${extra}`)
  const missing = REQUIRED.find((k) => !Object.prototype.hasOwnProperty.call(v, k))
  if (missing !== undefined) return bad(`${missing} missing`)
  if (!isSegment(v.opId)) return bad('opId is not a single path segment')
  if (typeof v.kind !== 'string' || !KINDS.has(v.kind)) {
    return bad(`kind ${JSON.stringify(v.kind)} unknown`)
  }
  if (!isSegment(v.dirName)) return bad('dirName is not a single path segment')
  if (!roundTrips(v.createdAt)) return bad('createdAt does not round-trip through Date')
  if (v.treeHash !== null && !(typeof v.treeHash === 'string' && HASH.test(v.treeHash))) {
    return bad('treeHash is neither a hash nor null')
  }
  if (!isIdentity(v.identity)) return bad('identity is malformed')
  for (const k of ['client', 'scope', 'manifestKey']) {
    if (typeof v[k] !== 'string') return bad(`${k} is not a string`)
  }
  if (typeof v.skillsDir !== 'string' || !path.isAbsolute(v.skillsDir)) {
    return bad('skillsDir is not an absolute path')
  }
  if (
    v.treeHashError !== undefined &&
    (typeof v.treeHashError !== 'string' || v.treeHash !== null)
  ) {
    return bad('treeHashError must be a string, and only with treeHash null')
  }
  const partial = v.kind === 'partial-copy'
  if (v.sourceUnchanged !== undefined && (!partial || typeof v.sourceUnchanged !== 'boolean')) {
    return bad('sourceUnchanged must be a boolean, on a partial-copy only')
  }
  if (
    v.partialCause !== undefined &&
    (!partial || typeof v.partialCause !== 'string' || !PARTIAL_CAUSES.has(v.partialCause))
  ) {
    return bad('partialCause must be a known cause, on a partial-copy only')
  }
  if (
    v.opDirIdentity !== undefined &&
    (!v.kind.startsWith('abandoned-') || !isIdentity(v.opDirIdentity))
  ) {
    return bad('opDirIdentity must be an identity, on an abandoned-* tree only')
  }
  return { ok: true, sidecar: v as unknown as Sidecar }
}
