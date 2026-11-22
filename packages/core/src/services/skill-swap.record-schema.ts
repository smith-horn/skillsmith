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
 * Schema 1 carries `op`, `target.scope` and `target.dirName` since 6a-i:
 * doctor needs the scope and the folder name to find a record's backup area
 * and sidecars, and the kind of operation to refuse one it does not know. A
 * record missing any of them is malformed. Since 8-i-a-2 two shapes parse: the
 * update's (`SwapRecord`, the keys below) and the fresh install's
 * (`InstallRecord`, `skill-install.record-schema.ts`, `op: 'install'` with its
 * own exact keys). Which shape matched decides the type, never `op` alone: an
 * update-shaped record that says `op: 'install'` is malformed, and any other
 * `op` on the update's keys parses so doctor can name it (`inconsistent-record`).
 *
 * @module @skillsmith/core/services/skill-swap.record-schema
 */
import crypto from 'node:crypto'
import { computeInstallRecordSha256, isInstallRecord } from './skill-install.record-schema.js'
import type { InstallRecord } from './skill-install.record-schema.js'
import {
  allStrings,
  hasExactKeys,
  idOrder,
  isIdentity,
  isMarker,
  isObject,
  isTarget,
  markerOrder,
} from './skill-swap.record-shape.js'
import type { SwapRecord } from './skill-swap.types.js'

export { TARGET_KEYS } from './skill-swap.record-shape.js'

/** Every record a staging op dir can hold: an in-place update's, or a fresh install's. */
export type OpRecord = SwapRecord | InstallRecord

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
    ...(record.fullDevice === undefined ? {} : { fullDevice: markerOrder(record.fullDevice) }),
  }
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

/**
 * The record's shape is exactly an update record's (`SwapRecord`). Its `op`
 * may be any string but `'install'` (the install's own shape is
 * `isInstallRecord`): an op doctor does not know still parses, and doctor
 * names it (`inconsistent-record`).
 */
export function isSwapRecord(v: unknown): v is SwapRecord {
  if (!isObject(v) || !hasExactKeys(v, TOP_KEYS, ['fullDevice'])) return false
  if (v.schema !== 1 || !Number.isInteger(v.pid) || !Number.isInteger(v.uid)) return false
  if (!allStrings(v, ['op', 'opId', 'host', 'preTree', 'postTree', 'backupDest', 'recordSha256'])) {
    return false
  }
  if (v.op === 'install' || !isTarget(v.target)) return false
  for (const k of ['rootIdentity', 'opDirIdentity', 'oldIdentity', 'newIdentity'] as const) {
    if (!isIdentity(v[k])) return false
  }
  return v.fullDevice === undefined || isMarker(v.fullDevice)
}

/** Why bytes that were read are not a record of schema 1 (before any comparison with a root). */
export type RecordParseWhy = 'too-large' | 'not-json' | 'malformed' | 'hash-mismatch'

/** Why bytes that were read are not this root's record (every reason after the read). */
export type RecordBytesWhy = RecordParseWhy | 'foreign-op-dir' | 'foreign-root'

/**
 * The size cap, JSON, the schema-1 shape (update or install) and the hash
 * recomputed from the parsed body in that shape's key order: everything a
 * record's bytes prove on their own, with no root
 * or op dir to compare against. Doctor's classifier uses this directly, since
 * it names a record that verifies but belongs elsewhere (`moved`) rather than
 * calling it unreadable.
 */
export function parseRecordBytes(
  bytes: Buffer
): { ok: true; record: OpRecord } | { ok: false; why: RecordParseWhy } {
  if (bytes.length > MAX_RECORD_BYTES) return { ok: false, why: 'too-large' }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { ok: false, why: 'not-json' }
  }
  if (isInstallRecord(parsed)) {
    const { recordSha256, ...body } = parsed
    if (computeInstallRecordSha256(body) !== recordSha256)
      return { ok: false, why: 'hash-mismatch' }
    return { ok: true, record: parsed }
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
): { ok: true; record: OpRecord } | { ok: false; why: RecordBytesWhy } {
  const parsed = parseRecordBytes(bytes)
  if (!parsed.ok) return parsed
  if (parsed.record.opId !== opId) return { ok: false, why: 'foreign-op-dir' }
  if (parsed.record.target.skillsDir !== root) return { ok: false, why: 'foreign-root' }
  return parsed
}
