/**
 * SMI-6531 (A1 step 6a-i): schema 1 of `record.json`, with no filesystem
 * access: the shape check, the hash, and the parse of bytes already read.
 *
 * Split out of `skill-swap.records.ts` so doctor's classifier can parse a
 * record without importing a module that touches the filesystem (the
 * classifier's only reads go through its reader; see `skill-recovery.reader.ts`).
 * `skill-swap.records.ts` re-exports everything here, so existing callers are
 * unchanged.
 *
 * Schema 1 carries `op` (`'update'`), `target.scope` and `target.dirName` since
 * 6a-i: doctor needs the scope and the folder name to find a record's backup
 * area and sidecars, and the kind of operation to refuse one it does not know.
 * A record missing any of them is malformed.
 *
 * @module @skillsmith/core/services/skill-swap.record-schema
 */
import crypto from 'node:crypto'
import type { FullDeviceStage, RecordIdentity, SwapRecord } from './skill-swap.types.js'

/** Far above any record step 5 writes (its manifest entries are small). */
export const MAX_RECORD_BYTES = 1024 * 1024

/** sha256 of the record's JSON without `recordSha256`, in the record's fixed key order. */
export function computeRecordSha256(record: Omit<SwapRecord, 'recordSha256'>): string {
  const ordered: Omit<SwapRecord, 'recordSha256'> = {
    schema: record.schema,
    op: record.op,
    opId: record.opId,
    pid: record.pid,
    host: record.host,
    uid: record.uid,
    target: {
      comparedPath: record.target.comparedPath,
      realDir: record.target.realDir,
      skillsDir: record.target.skillsDir,
      manifestPath: record.target.manifestPath,
      manifestKey: record.target.manifestKey,
      client: record.target.client,
      scope: record.target.scope,
      dirName: record.target.dirName,
    },
    rootIdentity: record.rootIdentity,
    opDirIdentity: record.opDirIdentity,
    oldIdentity: record.oldIdentity,
    newIdentity: record.newIdentity,
    preTree: record.preTree,
    postTree: record.postTree,
    preEntry: record.preEntry,
    postEntry: record.postEntry,
    backupDest: record.backupDest,
    // Explicit key order, like every other field (governance round 4).
    ...(record.fullDevice === undefined
      ? {}
      : {
          fullDevice: {
            cause: record.fullDevice.cause,
            stage: record.fullDevice.stage,
            area: record.fullDevice.area,
            opId: record.fullDevice.opId,
            dest: record.fullDevice.dest,
          },
        }),
  }
  const idOrder = (i: RecordIdentity): RecordIdentity => ({
    dev: i.dev,
    ino: i.ino,
    birthtimeNs: i.birthtimeNs,
    fmt: i.fmt,
  })
  ordered.rootIdentity = idOrder(ordered.rootIdentity)
  ordered.opDirIdentity = idOrder(ordered.opDirIdentity)
  ordered.oldIdentity = idOrder(ordered.oldIdentity)
  ordered.newIdentity = idOrder(ordered.newIdentity)
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

export const TOP_KEYS = [
  'schema',
  'op',
  'opId',
  'pid',
  'host',
  'uid',
  'target',
  'rootIdentity',
  'opDirIdentity',
  'oldIdentity',
  'newIdentity',
  'preTree',
  'postTree',
  'preEntry',
  'postEntry',
  'backupDest',
  'recordSha256',
] as const
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
const IDENTITY_KEYS = ['dev', 'ino', 'birthtimeNs', 'fmt'] as const
const MARKER_KEYS = ['cause', 'stage', 'area', 'opId', 'dest'] as const
const STAGES: ReadonlySet<string> = new Set<FullDeviceStage>([
  'copy',
  'partial-keep',
  'sidecar-rewrite',
  'final-rename',
  'final-sync',
])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `v` has every one of `keys`, and no own key outside `keys` and `optional`. */
function hasExactKeys(
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

const allStrings = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every((k) => typeof v[k] === 'string')

/** The record's shape is exactly schema 1's (`SwapRecord`, `skill-swap.types.ts`). */
export function isSwapRecord(v: unknown): v is SwapRecord {
  if (!isObject(v) || !hasExactKeys(v, TOP_KEYS, ['fullDevice'])) return false
  if (v.schema !== 1 || !Number.isInteger(v.pid) || !Number.isInteger(v.uid)) return false
  if (!allStrings(v, ['op', 'opId', 'host', 'preTree', 'postTree', 'backupDest', 'recordSha256'])) {
    return false
  }
  const t = v.target
  if (!isObject(t) || !hasExactKeys(t, TARGET_KEYS) || !allStrings(t, TARGET_KEYS)) return false
  for (const k of ['rootIdentity', 'opDirIdentity', 'oldIdentity', 'newIdentity'] as const) {
    const id = v[k]
    if (!isObject(id) || !hasExactKeys(id, IDENTITY_KEYS) || !allStrings(id, IDENTITY_KEYS)) {
      return false
    }
  }
  if (v.fullDevice === undefined) return true
  const m = v.fullDevice
  return (
    isObject(m) &&
    hasExactKeys(m, MARKER_KEYS) &&
    allStrings(m, MARKER_KEYS) &&
    (m.cause === 'ENOSPC' || m.cause === 'EDQUOT') &&
    STAGES.has(m.stage as string)
  )
}

/** Why bytes that were read are not a record of schema 1 (before any comparison with a root). */
export type RecordParseWhy = 'too-large' | 'not-json' | 'malformed' | 'hash-mismatch'

/** Why bytes that were read are not this root's record (every reason after the read). */
export type RecordBytesWhy = RecordParseWhy | 'foreign-op-dir' | 'foreign-root'

/**
 * The size cap, JSON, the schema-1 shape and the hash recomputed from the
 * parsed body: everything a record's bytes prove on their own, with no root
 * or op dir to compare against. Doctor's classifier uses this directly, since
 * it names a record that verifies but belongs elsewhere (`moved`) rather than
 * calling it unreadable.
 */
export function parseRecordBytes(
  bytes: Buffer
): { ok: true; record: SwapRecord } | { ok: false; why: RecordParseWhy } {
  if (bytes.length > MAX_RECORD_BYTES) return { ok: false, why: 'too-large' }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { ok: false, why: 'not-json' }
  }
  if (!isSwapRecord(parsed)) return { ok: false, why: 'malformed' }
  const { recordSha256, ...body } = parsed
  if (computeRecordSha256(body) !== recordSha256) return { ok: false, why: 'hash-mismatch' }
  return { ok: true, record: parsed }
}

/**
 * Every check the scan makes after reading a record's bytes: the size cap,
 * JSON, the schema-1 shape, the hash recomputed from the parsed body, the op
 * dir's name and the root. Step 5 and the full-device rewrite run it on the
 * exact bytes they then write, so a record they publish is one the scan
 * accepts (owner decision 2026-10-25, retro of PR #3162).
 */
export function verifyRecordBytes(
  bytes: Buffer,
  root: string,
  opId: string
): { ok: true; record: SwapRecord } | { ok: false; why: RecordBytesWhy } {
  const parsed = parseRecordBytes(bytes)
  if (!parsed.ok) return parsed
  if (parsed.record.opId !== opId) return { ok: false, why: 'foreign-op-dir' }
  if (parsed.record.target.skillsDir !== root) return { ok: false, why: 'foreign-root' }
  return parsed
}
