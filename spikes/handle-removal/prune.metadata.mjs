// SMI-7123 Wave 5, Sol code round 1 finding 2: Skillsmith's staging metadata
// (`intent.json`, `deleting`) is removed only when it is PROVABLY ours.
//
// A name is not proof. A file is removed only if it is the exact bytes and
// inode that were recorded -- either written by this very process, or
// stable-read and schema-checked when the leftover was inspected and then
// covered by the user's confirmation -- and it is never unlinked by its known
// name: it is renamed to a random name and re-checked there first (Sol c2
// finding 2; removeIfIdentical below). On any mismatch the file is kept and
// the caller reports its exact path.
//
// Residual (stated, not closed): one syscall between the final lstat of the
// random name and its unlink -- the R-swap class (design §2), out of model.
//
// fs is the DEFAULT export, looked up at call time.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
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

/** Is the stable read `rs` exactly the recorded `expect` (inode and bytes)? */
const matches = (rs, expect) =>
  rs.ok && String(rs.ino) === expect.ino && rs.bytes.equals(Buffer.from(expect.bytes, 'base64'))

/**
 * Removes `p` only if it is exactly `expect` ({ino, bytes(base64)}), with the
 * walk's own discipline (Sol c2 finding 2): the known name is never unlinked.
 *  1. pre-check at the known name (stable read: inode and bytes) -- a mismatch
 *     leaves the file untouched where it is;
 *  2. rename it to a fresh random `.m-<16 hex>` name in the same directory;
 *  3. re-check inode and bytes AT THE RANDOM NAME, and an lstat immediately
 *     before unlink (inode, size, mtime, ctime as just read);
 *  4. unlink the random name.
 * A swap at the known name after step 1 is caught in step 3: the replacement
 * is kept under its random name and reported by that exact path. What remains
 * is one syscall between step 3's lstat and the unlink of a random name -- the
 * R-swap class (design §2), out of model.
 * @returns {{removed:true}|{removed:false, kept:string|null}} kept:null when absent;
 *   `kept` always names the file's exact current path.
 */
export function removeIfIdentical(p, expect) {
  const keep = (at, why) => ({ removed: false, kept: `${at}: ${why}` })
  try {
    fs.lstatSync(p, { bigint: true })
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: false, kept: null }
    return keep(p, `unreadable (${err.code})`)
  }
  if (!expect) return keep(p, 'not written or inspected by this run')
  const pre = readStable(p)
  if (!pre.ok) return keep(p, pre.reason)
  if (!matches(pre, expect)) return keep(p, 'not the inode and bytes recorded')
  const r = path.join(path.dirname(p), `.m-${crypto.randomBytes(8).toString('hex')}`)
  try {
    fs.renameSync(p, r)
  } catch (err) {
    return keep(p, `rename to a random name failed (${err.code})`)
  }
  const post = readStable(r)
  if (!matches(post, expect)) {
    return keep(r, `renamed from ${path.basename(p)}, but not the inode and bytes recorded`)
  }
  let now
  try {
    now = fs.lstatSync(r, { bigint: true })
  } catch (err) {
    return { removed: false, kept: `${r}: vanished before removal (${err.code})` }
  }
  if (
    now.ino !== post.ino ||
    now.size !== post.size ||
    now.mtimeNs !== post.mtimeNs ||
    now.ctimeNs !== post.ctimeNs
  ) {
    return keep(r, 'changed immediately before removal')
  }
  fs.unlinkSync(r)
  return { removed: true }
}
