// SMI-7123 Wave 5, Sol code round 1 finding 2: Skillsmith's staging metadata
// (`intent.json`, `deleting`) is removed only when it is PROVABLY ours.
//
// A name is not proof. A file is removed only if (1) a stable read shows the
// exact bytes and inode that were recorded -- either written by this very
// process, or stable-read and schema-checked when the leftover was inspected
// and then covered by the user's confirmation -- and (2) an lstat immediately
// before unlink still shows that inode, size, mtime and ctime. On any mismatch
// the file is kept and the caller reports it.
//
// Residual (stated, not closed): one syscall between that lstat and unlink,
// the same out-of-model window as R-swap (design §2).
//
// fs is the DEFAULT export, looked up at call time.

import fs from 'node:fs'
import path from 'node:path'
import { readStable } from './prune.sidecar.mjs'

const HEX16 = /^[0-9a-f]{16}$/
const HASH = /^[0-9a-f]{64}$/
const INTENT_KEYS = [
  'pruneId',
  'copyPath',
  'sidecarPath',
  'leaf',
  'approvedHash',
  'approvedSidecarSha256',
  'class',
  'authorization',
  'createdAt',
  'pid',
  'host',
  'version',
]
export const INTENT_VERSION = 'smi-7123-spike'

const exactKeys = (o, keys) =>
  o !== null &&
  typeof o === 'object' &&
  !Array.isArray(o) &&
  Object.keys(o).sort().join('\0') === [...keys].sort().join('\0')
const parse = (bytes) => {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return undefined
  }
}

/** The intent the walker writes at P4c, exactly. @returns {object|null} */
export function parseIntentStrict(bytes) {
  const o = parse(bytes)
  if (!exactKeys(o, INTENT_KEYS)) return null
  const d = new Date(o.createdAt)
  const ok =
    HEX16.test(o.pruneId) &&
    typeof o.copyPath === 'string' &&
    path.isAbsolute(o.copyPath) &&
    (o.sidecarPath === null ||
      (typeof o.sidecarPath === 'string' && path.isAbsolute(o.sidecarPath))) &&
    typeof o.leaf === 'string' &&
    o.leaf.length > 0 &&
    !o.leaf.includes('/') &&
    o.leaf !== '.' &&
    o.leaf !== '..' &&
    HASH.test(o.approvedHash) &&
    (o.approvedSidecarSha256 === null || HASH.test(o.approvedSidecarSha256)) &&
    typeof o.class === 'string' &&
    typeof o.authorization === 'string' &&
    typeof o.createdAt === 'string' &&
    !Number.isNaN(d.getTime()) &&
    d.toISOString() === o.createdAt &&
    Number.isSafeInteger(o.pid) &&
    (o.host === null || typeof o.host === 'string') &&
    o.version === INTENT_VERSION
  return ok ? o : null
}

/** The `deleting` marker the walker writes at W0, exactly. @returns {object|null} */
export function parseDeletingStrict(bytes) {
  const o = parse(bytes)
  if (!exactKeys(o, ['pruneId', 'pid'])) return null
  return HEX16.test(o.pruneId) && Number.isSafeInteger(o.pid) ? o : null
}

/** The record a later removal is checked against: {ino (string), bytes (base64)}. */
export function recordOf(p, bytes) {
  const st = fs.lstatSync(p, { bigint: true })
  return { ino: String(st.ino), bytes: Buffer.from(bytes).toString('base64') }
}

/**
 * Unlinks `p` only if it is still exactly `expect` ({ino, bytes(base64)}).
 * @returns {{removed:true}|{removed:false, kept:string|null}} kept:null when absent
 */
export function removeIfIdentical(p, expect) {
  let pre
  try {
    pre = fs.lstatSync(p, { bigint: true })
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: false, kept: null }
    return { removed: false, kept: `${path.basename(p)}: unreadable (${err.code})` }
  }
  if (!expect)
    return { removed: false, kept: `${path.basename(p)}: not written or inspected by this run` }
  const rs = readStable(p)
  if (!rs.ok) return { removed: false, kept: `${path.basename(p)}: ${rs.reason}` }
  if (String(rs.ino) !== expect.ino || String(pre.ino) !== expect.ino) {
    return {
      removed: false,
      kept: `${path.basename(p)}: a different file (inode) than the one recorded`,
    }
  }
  if (!rs.bytes.equals(Buffer.from(expect.bytes, 'base64'))) {
    return { removed: false, kept: `${path.basename(p)}: bytes differ from the ones recorded` }
  }
  let now
  try {
    now = fs.lstatSync(p, { bigint: true })
  } catch (err) {
    return { removed: false, kept: `${path.basename(p)}: vanished before removal (${err.code})` }
  }
  if (
    now.ino !== rs.ino ||
    now.size !== rs.size ||
    now.mtimeNs !== rs.mtimeNs ||
    now.ctimeNs !== rs.ctimeNs
  ) {
    return { removed: false, kept: `${path.basename(p)}: changed immediately before removal` }
  }
  fs.unlinkSync(p)
  return { removed: true }
}
