/**
 * SMI-6531 (A1 step 8-i-a-2): the shape checks every `record.json` schema
 * shares, with no filesystem access: exact key sets, string fields, the
 * identity form and the full-device marker. The update record
 * (`skill-swap.record-schema.ts`) and the fresh-install record
 * (`skill-install.record-schema.ts`) both build on these, so the two can never
 * disagree about what an identity or a marker looks like.
 *
 * @module @skillsmith/core/services/skill-swap.record-shape
 */
import type { FullDeviceMarker, FullDeviceStage, RecordIdentity } from './skill-swap.types.js'

export const TARGET_KEYS = [
  'comparedPath',
  'realDir',
  'skillsDir',
  'manifestPath',
  'manifestKey',
  'client',
  'scope',
  'dirName',
] as const
export const IDENTITY_KEYS = ['dev', 'ino', 'birthtimeNs', 'fmt'] as const
const MARKER_KEYS = ['cause', 'stage', 'area', 'opId', 'dest'] as const
const STAGES: ReadonlySet<string> = new Set<FullDeviceStage>([
  'copy',
  'partial-keep',
  'sidecar-rewrite',
  'final-rename',
  'final-sync',
])

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `v` has every one of `keys`, and no own key outside `keys` and `optional`. */
export function hasExactKeys(
  v: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = []
): boolean {
  const own = Object.keys(v)
  return (
    keys.every((k) => Object.hasOwn(v, k)) &&
    own.every((k) => keys.includes(k) || optional.includes(k))
  )
}

export const allStrings = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every((k) => typeof v[k] === 'string')

/** `v` is a record identity: exactly the four keys, each a string. */
export const isIdentity = (v: unknown): v is RecordIdentity =>
  isObject(v) && hasExactKeys(v, IDENTITY_KEYS) && allStrings(v, IDENTITY_KEYS)

/** `v` is a record's `target`: exactly the eight keys, each a string. */
export const isTarget = (v: unknown): boolean =>
  isObject(v) && hasExactKeys(v, TARGET_KEYS) && allStrings(v, TARGET_KEYS)

/** `v` is a full-device marker (`FullDeviceMarker`). */
export function isMarker(v: unknown): v is FullDeviceMarker {
  return (
    isObject(v) &&
    hasExactKeys(v, MARKER_KEYS) &&
    allStrings(v, MARKER_KEYS) &&
    (v.cause === 'ENOSPC' || v.cause === 'EDQUOT') &&
    STAGES.has(v.stage as string)
  )
}

/** An identity with its keys in the record's fixed order, for the hash. */
export const idOrder = (i: RecordIdentity): RecordIdentity => ({
  dev: i.dev,
  ino: i.ino,
  birthtimeNs: i.birthtimeNs,
  fmt: i.fmt,
})

/** A marker with its keys in the record's fixed order, for the hash. */
export const markerOrder = (m: FullDeviceMarker): FullDeviceMarker => ({
  cause: m.cause,
  stage: m.stage,
  area: m.area,
  opId: m.opId,
  dest: m.dest,
})
