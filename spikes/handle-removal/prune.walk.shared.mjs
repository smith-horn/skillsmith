// SMI-7123 Wave 5: helpers shared by the prune walker modules (prune.walk.mjs,
// prune.walk.verify.mjs). Split out of prune.walk.mjs for the
// file-length limit; moved verbatim. fs is the DEFAULT export, looked up at call time.

import fs from 'node:fs'
import crypto from 'node:crypto'
import { MOUNTINFO_APPLIES, readMountPointsAtOrUnder } from './quarantine.mounts.mjs'

const SIDECAR_KEY = '\0sidecar'
const META = new Set(['intent.json', 'deleting', 'sidecar.json', 'misplaced.json'])
const rand = () => `.d-${crypto.randomBytes(8).toString('hex')}`

class Stop extends Error {
  constructor(status, reason, detail = null, extra = {}) {
    super(`${status}/${reason}`)
    Object.assign(this, { status, reason, detail, extra })
  }
}

const typeOf = (s) =>
  s.isDirectory() ? 'dir' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'other'
const rowOf = (s) => ({
  dev: s.dev,
  ino: s.ino,
  birthtimeNs: s.birthtimeNs,
  type: typeOf(s),
  mode: s.mode,
  size: s.size,
  mtimeNs: s.mtimeNs,
  ctimeNs: s.ctimeNs,
})
const sameDirId = (w, s) =>
  w &&
  w.type === 'dir' &&
  s.isDirectory() &&
  w.dev === s.dev &&
  w.ino === s.ino &&
  w.birthtimeNs === s.birthtimeNs
const sameLeafPost = (w, s) =>
  w &&
  w.type !== 'dir' &&
  w.dev === s.dev &&
  w.ino === s.ino &&
  w.type === typeOf(s) &&
  w.mode === s.mode &&
  w.size === s.size &&
  w.mtimeNs === s.mtimeNs
const sameLeafPre = (w, s) => sameLeafPost(w, s) && w.ctimeNs === s.ctimeNs

/** Linux: mountinfo points at or under abs (real path). {ok:false} fails closed. */
function mountFinding(abs) {
  if (!MOUNTINFO_APPLIES) return null
  let real
  try {
    real = fs.realpathSync(abs)
  } catch (err) {
    return `realpath failed (${err.code})`
  }
  const m = readMountPointsAtOrUnder(real)
  if (!m.ok) return `mountinfo unreadable (${m.errno}); a bind mount cannot be ruled out`
  return m.points.length > 0 ? `mount point ${m.points[0]}` : null
}

export {
  SIDECAR_KEY,
  META,
  rand,
  Stop,
  typeOf,
  rowOf,
  sameDirId,
  sameLeafPost,
  sameLeafPre,
  mountFinding,
}
