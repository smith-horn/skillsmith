/**
 * SMI-6531 (A1 step 8-i-a-2): `record.json` of a fresh install (op
 * `install`), with no filesystem access: the type, the exact key set, the
 * hash and the sealer (design § 2.1-2.4).
 *
 * Schema 1, discriminated on `op` (Q4): an install record has its own exact
 * key set, so an update record's bytes and hash are unchanged and an older
 * Skillsmith, whose shape check requires the update's keys, reads an install
 * record as `malformed` (unreadable: it refuses writes in the root, and loses
 * nothing). An install has no old folder, so it stores no `oldIdentity`,
 * `preTree` or `backupDest`; its keeps go to the same backup area as an
 * update's, `<area>/<opId>.<kind>`. `preEntry` is `null` (no entry) or the
 * stale entry the target guard accepted; `postEntry` is the entry the install
 * commits. No phase is stored: the manifest entry's state against `preEntry`
 * and `postEntry` says it.
 *
 * The sealer the staged install (8-i-a-3) serializes with is
 * `sealInstallRecord` (`skill-install.record-seal.ts`), beside the parser it
 * checks its bytes with.
 *
 * @module @skillsmith/core/services/skill-install.record-schema
 */
import crypto from 'node:crypto'
import { computeTreeHash } from '../install/tree-hash.js'
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
import type { FullDeviceMarker, RecordIdentity } from './skill-swap.types.js'

/** `record.json` of a fresh install, in its fixed key order. */
export interface InstallRecord {
  schema: 1
  op: 'install'
  opId: string
  pid: number
  host: string
  uid: number
  /** The update's eight target keys; `realDir` is `join(skillsDir, dirName)` (the target does not exist yet). */
  target: {
    comparedPath: string
    realDir: string
    skillsDir: string
    manifestPath: string
    manifestKey: string
    client: string
    scope: string
    dirName: string
  }
  rootIdentity: RecordIdentity
  opDirIdentity: RecordIdentity
  /** N's identity, bound when the build completed: the published folder keeps it. */
  newIdentity: RecordIdentity
  /** N's tree hash at the end of the build. */
  postTree: string
  /** `null` (no entry) or the stale entry the target guard accepted. */
  preEntry: unknown
  /** The complete entry the install commits. */
  postEntry: unknown
  /** Accepted for symmetry with the update: a cross-device keep by doctor may mark it. */
  fullDevice?: FullDeviceMarker
  recordSha256: string
}

export const INSTALL_TOP_KEYS = [
  'schema',
  'op',
  'opId',
  'pid',
  'host',
  'uid',
  'target',
  'rootIdentity',
  'opDirIdentity',
  'newIdentity',
  'postTree',
  'preEntry',
  'postEntry',
  'recordSha256',
] as const

/** The hash of a tree with no entries: a built install always holds `SKILL.md`, so never its `postTree`. */
export const EMPTY_TREE_HASH = computeTreeHash(new Map())

/** sha256 of the record's JSON without `recordSha256`, in the install record's fixed key order. */
export function computeInstallRecordSha256(record: Omit<InstallRecord, 'recordSha256'>): string {
  const ordered: Omit<InstallRecord, 'recordSha256'> = {
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
    rootIdentity: idOrder(record.rootIdentity),
    opDirIdentity: idOrder(record.opDirIdentity),
    newIdentity: idOrder(record.newIdentity),
    postTree: record.postTree,
    preEntry: record.preEntry,
    postEntry: record.postEntry,
    ...(record.fullDevice === undefined ? {} : { fullDevice: markerOrder(record.fullDevice) }),
  }
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

/** The record's shape is exactly an install record's (`InstallRecord`). */
export function isInstallRecord(v: unknown): v is InstallRecord {
  if (!isObject(v) || !hasExactKeys(v, INSTALL_TOP_KEYS, ['fullDevice'])) return false
  if (v.schema !== 1 || v.op !== 'install') return false
  if (!Number.isInteger(v.pid) || !Number.isInteger(v.uid)) return false
  if (!allStrings(v, ['opId', 'host', 'postTree', 'recordSha256'])) return false
  if (!isTarget(v.target)) return false
  if (![v.rootIdentity, v.opDirIdentity, v.newIdentity].every(isIdentity)) return false
  return v.fullDevice === undefined || isMarker(v.fullDevice)
}
