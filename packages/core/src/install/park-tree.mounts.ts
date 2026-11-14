/**
 * SMI-6531 (A1 step 3a): mount points from `/proc/self/mountinfo`, for the
 * pre-move and post-move mount checks (ADR-166 D-10 item 5). Ported from the
 * SMI-6676 spike's `quarantine.mounts.mjs`.
 *
 * A Linux same-filesystem bind mount reports its parent's `st_dev`, so the
 * walk's per-entry `st_dev` comparison cannot see it; only the kernel's mount
 * table can. mountinfo is a snapshot of this process's mount namespace: a mount
 * made after it is read, or in another namespace, is not seen (documented
 * residual, ADR-166 D-10 item 5).
 *
 * @module @skillsmith/core/install/park-tree.mounts
 */
import fs from 'node:fs'
import path from 'node:path'
import { errCode } from './park-result.js'

/** mountinfo escapes space, tab, newline and backslash as a 3-digit octal. */
function unescapeOctal(p: string): string {
  return p.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(Number.parseInt(o, 8)))
}

/** Every mount point (field 5), octal-unescaped. A short line is skipped, never thrown on. */
export function parseMountInfo(text: string): string[] {
  const out: string[] = []
  for (const line of String(text).split('\n')) {
    const fields = line.split(' ')
    if (fields.length < 5 || fields[4] === '') continue
    out.push(unescapeOctal(fields[4] as string))
  }
  return out
}

/** `mp` is `dir` or below it. A child named `..foo` is below; a sibling `..escape` is not. */
function atOrUnder(mp: string, dir: string): boolean {
  if (mp === dir) return true
  const rel = path.relative(dir, mp)
  return rel !== '' && !(rel === '..' || rel.startsWith('..' + path.sep)) && !path.isAbsolute(rel)
}

/** Mount points in `text` equal to `dir` or below it (never a name-prefix sibling). */
export function mountPointsAtOrUnder(dir: string, text: string): string[] {
  return parseMountInfo(text).filter((mp) => atOrUnder(mp, dir))
}

/** Whether this platform has a mountinfo check. Elsewhere only `st_dev` is compared. */
export const MOUNTINFO_APPLIES = process.platform === 'linux'

export type MountPointsResult = { ok: true; points: string[] } | { ok: false; errno: string | null }

/**
 * Mount points at or under `dir` (already a real path). An unreadable table is
 * reported, never read as "no mounts": the caller fails closed on `ok: false`.
 */
export function readMountPointsAtOrUnder(dir: string): MountPointsResult {
  let text: string
  try {
    text = fs.readFileSync('/proc/self/mountinfo', 'utf8')
  } catch (err) {
    return { ok: false, errno: errCode(err) }
  }
  return { ok: true, points: mountPointsAtOrUnder(dir, text) }
}

/** Why a copy root is judged mounted. */
export type MountVerdictReason = 'realpath-failed' | 'mountinfo-unreadable' | 'mount-point'

/** The verdict on one copy root: not mounted, or mounted and why (fail closed). */
export type MountVerdict =
  | { mounted: false }
  | {
      mounted: true
      reason: MountVerdictReason
      detail: string
      /** The mount points at or under the root's real path (empty unless `mount-point`). */
      points: string[]
      /** The root's real path, when it could be resolved. */
      real: string | null
    }

/**
 * The one mount verdict for a copy root, shared by the classifier and the
 * walker's re-check so they cannot disagree.
 *
 * A symlink is never a mount point: mounting on a symlink path follows it and
 * mounts on the target, and the walker unlinks a link without following it. So
 * a symlink root is "not mounted" with no realpath call; its parent directory
 * is checked by the listers. Any other root: its real path, then the mount
 * points at or under it. A path that cannot be resolved is mounted
 * (`realpath-failed`), and an unreadable table is mounted
 * (`mountinfo-unreadable`): never offered. No mountinfo on this platform is
 * "not mounted".
 */
export function mountVerdictAt(abs: string): MountVerdict {
  if (!MOUNTINFO_APPLIES) return { mounted: false }
  let real: string
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return { mounted: false }
    real = fs.realpathSync(abs)
  } catch (err) {
    return {
      mounted: true,
      reason: 'realpath-failed',
      detail: `realpath failed (${errCode(err)}); mounts cannot be checked`,
      points: [],
      real: null,
    }
  }
  const m = readMountPointsAtOrUnder(real)
  if (!m.ok) {
    return {
      mounted: true,
      reason: 'mountinfo-unreadable',
      detail: `mountinfo unreadable (${m.errno}); a bind mount cannot be ruled out`,
      points: [],
      real,
    }
  }
  if (m.points.length === 0) return { mounted: false }
  return {
    mounted: true,
    reason: 'mount-point',
    detail: `mount point ${m.points[0]}`,
    points: m.points,
    real,
  }
}
