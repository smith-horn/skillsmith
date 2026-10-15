// SMI-7123 Wave 5 (design §1.1, §3.1): the stable read and the strict sidecar schema.
//
// fs is imported as the DEFAULT export only, and every call looks its method
// up at call time, so the harness interposer sees every call.

import fs from 'node:fs'
import path from 'node:path'

const HASH = /^[0-9a-f]{64}$/
const isHash = (v) => typeof v === 'string' && HASH.test(v)

/**
 * The stable read (§3.1): open with O_NOFOLLOW, require the descriptor's inode
 * to be the one lstat names, read everything, fstat again, and require size,
 * mtimeNs and ctimeNs unchanged. A same-size write between the two reads
 * changes ctime (ns resolution, Probe 1) and is reported, never returned as data.
 *
 * `afterRead` is a test seam (T3): called after the read, before the second fstat.
 *
 * @returns {{ok:true, bytes:Buffer, dev:bigint, ino:bigint, size:bigint, mode:bigint,
 *            mtimeNs:bigint, ctimeNs:bigint}
 *          |{ok:false, reason:string, errno:string|null}}
 */
export function readStable(p, { afterRead } = {}) {
  let ls
  try {
    ls = fs.lstatSync(p, { bigint: true })
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: err.code ?? null }
  }
  if (!ls.isFile()) return { ok: false, reason: 'not-a-file', errno: null }
  let fd
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: err.code ?? null }
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
    return { ok: false, reason: 'unreadable', errno: err.code ?? null }
  } finally {
    fs.closeSync(fd)
  }
}

const BASE_KEYS = [
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
const SHAPE_KEYS = {
  U: BASE_KEYS,
  Q: [...BASE_KEYS, 'postMoveVerified', 'postMoveTreeHash'],
  H: [...BASE_KEYS, 'hold', 'reason', 'heldPath', 'guardHash', 'postMoveTreeHash'],
}
const HELD_REASONS = new Set(['changed-during-move', 'mount-appeared-during-move'])
const sameKeys = (obj, keys) => {
  const have = Object.keys(obj).sort().join('\0')
  return have === [...keys].sort().join('\0')
}

/**
 * Exactly one key set per shape, no extras, nothing missing (§1.1). Anything
 * else is `schema-invalid`, which classifies as unverified.
 *
 * @returns {{ok:true, shape:'U'|'Q'|'H', sidecar:object}|{ok:false, reason:string, detail:string}}
 */
export function parseSidecarStrict(bytes, { copyPath, opDirName }) {
  const bad = (detail) => ({ ok: false, reason: 'schema-invalid', detail })
  let s
  try {
    s = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes))
  } catch {
    return { ok: false, reason: 'unparseable', detail: 'sidecar is not JSON' }
  }
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return bad('not a JSON object')
  if (Object.getPrototypeOf(s) !== Object.prototype) return bad('not a plain object')

  let shape = null
  for (const [k, keys] of Object.entries(SHAPE_KEYS)) {
    if (sameKeys(s, keys)) shape = k
  }
  if (shape === null) {
    return bad(`key set matches no shape: ${Object.keys(s).sort().join(',')}`)
  }

  // Field rules shared by every shape.
  if (s.opId !== opDirName) return bad(`opId ${JSON.stringify(s.opId)} is not the op dir name`)
  if (typeof s.originPath !== 'string' || !path.isAbsolute(s.originPath)) {
    return bad('originPath is not an absolute path')
  }
  const copyName = path.basename(copyPath)
  const want = new RegExp(`^${escapeRe(path.basename(s.originPath))}-[0-9a-f]{8}$`)
  if (!want.test(copyName)) return bad('originPath basename plus -<8 hex> is not the copy name')
  if (!Number.isSafeInteger(s.bytes) || s.bytes < 0)
    return bad('bytes is not a non-negative safe integer')
  if (typeof s.createdAt !== 'string' || !roundTrips(s.createdAt)) {
    return bad('createdAt does not round-trip through Date')
  }
  for (const k of ['kind', 'client', 'skillsmithVersion']) {
    if (typeof s[k] !== 'string') return bad(`${k} is not a string`)
  }
  if (s.rootKey !== null && typeof s.rootKey !== 'string')
    return bad('rootKey is not a string or null')

  if (shape === 'U') {
    if (s.treeHash !== null) return bad('U: treeHash must be null')
  } else if (shape === 'Q') {
    if (s.postMoveVerified !== true) return bad('Q: postMoveVerified must be true')
    if (!isHash(s.treeHash) || !isHash(s.postMoveTreeHash)) return bad('Q: a hash is malformed')
    if (s.treeHash !== s.postMoveTreeHash) return bad('Q: treeHash differs from postMoveTreeHash')
  } else {
    if (s.hold !== true) return bad('H: hold must be true')
    if (!HELD_REASONS.has(s.reason)) return bad(`H: reason ${JSON.stringify(s.reason)} unknown`)
    if (s.heldPath !== copyPath) return bad('H: heldPath is not the copy path')
    if (!isHash(s.treeHash) || !isHash(s.guardHash)) return bad('H: a hash is malformed')
    if (s.postMoveTreeHash !== null && !isHash(s.postMoveTreeHash)) {
      return bad('H: postMoveTreeHash is neither a hash nor null')
    }
  }
  return { ok: true, shape, sidecar: s }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function roundTrips(v) {
  const d = new Date(v)
  return !Number.isNaN(d.getTime()) && d.toISOString() === v
}
