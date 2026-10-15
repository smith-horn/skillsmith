// SMI-6715 Step 1b (C4 repair, design §6): mount points from
// /proc/self/mountinfo, for the S2b (pre-move) and S9c (post-move) checks.
//
// WHY THIS EXISTS AT ALL. A Linux same-filesystem bind mount reports the SAME
// st_dev as its parent (measured in a privileged node:22-slim container:
// overlayfs bind 85=85, tmpfs-base bind 128=128; a tmpfs mount differs). So
// the per-entry st_dev comparison in the tree walk is blind to A1-bind, and
// only the kernel's mount table can see it. `statfs` is no substitute: Node
// exposes no fsid.
//
// LIMITS, stated rather than implied: mountinfo is a SNAPSHOT of THIS process's
// mount namespace. A mount made after it is read, or in another namespace, is
// invisible (design §2 residual 2).
//
// fs is imported as the DEFAULT export only, and every call looks its method
// up at call time: harness/attacks/c4-fs-boundary.mjs walks every module
// quarantine.mjs imports and fails if that stops holding.

import fs from 'node:fs'
import path from 'node:path'

/** mountinfo escapes space, tab, newline and backslash as a 3-digit octal. */
function unescapeOctal(p) {
  return p.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8)))
}

/**
 * Every mount point (field 5) in a mountinfo text, octal-unescaped. A line with
 * fewer than five fields is skipped, never thrown on.
 */
export function parseMountInfo(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const fields = line.split(' ')
    if (fields.length < 5 || fields[4] === '') continue
    out.push(unescapeOctal(fields[4]))
  }
  return out
}

const atOrUnder = (mp, dir) => {
  if (mp === dir) return true
  const rel = path.relative(dir, mp)
  return rel !== '' && !(rel === '..' || rel.startsWith('..' + path.sep)) && !path.isAbsolute(rel)
}

/** Mount points in `text` equal to `dir` or below it (never a name-prefix sibling). */
export function mountPointsAtOrUnder(dir, text) {
  return parseMountInfo(text).filter((mp) => atOrUnder(mp, dir))
}

/** Whether this platform has a mountinfo check. darwin relies on st_dev (Probe 3). */
export const MOUNTINFO_APPLIES = process.platform === 'linux'

/**
 * Reads /proc/self/mountinfo and returns the mount points at or under `dir`
 * (which must already be a real path). An unreadable table is reported, never
 * read as "no mounts": the caller fails closed on {ok:false}.
 *
 * @returns {{ok:true, points:string[]}|{ok:false, errno:string|null}}
 */
export function readMountPointsAtOrUnder(dir) {
  let text
  try {
    text = fs.readFileSync('/proc/self/mountinfo', 'utf8')
  } catch (err) {
    return { ok: false, errno: err.code ?? null }
  }
  return { ok: true, points: mountPointsAtOrUnder(dir, text) }
}
