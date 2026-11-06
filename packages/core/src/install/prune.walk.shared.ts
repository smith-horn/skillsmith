/**
 * SMI-6531 (A1 step 6c-i): helpers shared by the prune walker modules
 * (`prune.walk.ts`, `prune.walk.verify.ts`), ported from the SMI-6676 spike's
 * `prune.walk.shared.mjs`. fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.walk.shared
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { errCode } from './park-result.js'
import type { ParkStatus } from './park-result.js'
import { MOUNTINFO_APPLIES, readMountPointsAtOrUnder } from './park-tree.mounts.js'
import { opDirOwnerModeProblem } from './park-tree.perms.js'

/** The inventory key of the staged sidecar (no tree entry can be named with a NUL). */
export const SIDECAR_KEY = '\0sidecar'
/** Prune's own names inside a `.prune-*` staging directory. */
export const META: ReadonlySet<string> = new Set([
  'intent.json',
  'intent.json.tmp',
  'deleting',
  'sidecar.json',
  'misplaced.json',
])
/** A random name the delete walk (`.d-`) or metadata removal (`.m-`) uses. */
export const RANDOM_NAME_RE = /^\.[dm]-[0-9a-f]{16}$/

/** A fresh random name the delete walk renames an entry to before its unlink. */
export const rand = (): string => `.d-${crypto.randomBytes(8).toString('hex')}`

/** A delete-walk stop, carried to the walker's result. */
export class Stop extends Error {
  readonly status: ParkStatus
  readonly reason: string
  readonly detail: string | null
  readonly extra: Record<string, unknown>
  errno?: string | null
  constructor(
    status: ParkStatus,
    reason: string,
    detail: string | null = null,
    extra: Record<string, unknown> = {}
  ) {
    super(`${status}/${reason}`)
    this.status = status
    this.reason = reason
    this.detail = detail
    this.extra = extra
  }
}

export type EntryType = 'dir' | 'file' | 'symlink' | 'other'

/** One verified entry: what the delete walk re-checks before touching it. */
export interface InventoryRow {
  dev: bigint
  ino: bigint
  birthtimeNs: bigint | null
  type: EntryType
  mode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export type Inventory = Map<string, InventoryRow>

type StatLike = Pick<
  BigIntStats,
  | 'dev'
  | 'ino'
  | 'birthtimeNs'
  | 'mode'
  | 'size'
  | 'mtimeNs'
  | 'ctimeNs'
  | 'isDirectory'
  | 'isFile'
  | 'isSymbolicLink'
>

export const typeOf = (s: StatLike): EntryType =>
  s.isDirectory() ? 'dir' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'other'

export const rowOf = (s: StatLike): InventoryRow => ({
  dev: s.dev,
  ino: s.ino,
  birthtimeNs: s.birthtimeNs,
  type: typeOf(s),
  mode: s.mode,
  size: s.size,
  mtimeNs: s.mtimeNs,
  ctimeNs: s.ctimeNs,
})

/** A directory with the identity `w` recorded (dev, ino, birthtime). */
export const sameDirId = (
  w: Pick<InventoryRow, 'type' | 'dev' | 'ino' | 'birthtimeNs'> | undefined,
  s: StatLike
): boolean =>
  w !== undefined &&
  w.type === 'dir' &&
  s.isDirectory() &&
  w.dev === s.dev &&
  w.ino === s.ino &&
  w.birthtimeNs === s.birthtimeNs

/** A non-directory still as recorded after a rename (a rename changes ctime). */
export const sameLeafPost = (w: InventoryRow | undefined, s: StatLike): boolean =>
  w !== undefined &&
  w.type !== 'dir' &&
  w.dev === s.dev &&
  w.ino === s.ino &&
  w.type === typeOf(s) &&
  w.mode === s.mode &&
  w.size === s.size &&
  w.mtimeNs === s.mtimeNs

/** A non-directory still as recorded before its rename, ctime included. */
export const sameLeafPre = (w: InventoryRow | undefined, s: StatLike): boolean =>
  sameLeafPost(w, s) && w !== undefined && w.ctimeNs === s.ctimeNs

/** Linux: a mountinfo point at or under `abs` (its real path). Fails closed on an unreadable table. */
export function mountFinding(abs: string): string | null {
  if (!MOUNTINFO_APPLIES) return null
  let real: string
  try {
    real = fs.realpathSync(abs)
  } catch (err) {
    return `realpath failed (${errCode(err)})`
  }
  const m = readMountPointsAtOrUnder(real)
  if (!m.ok) return `mountinfo unreadable (${m.errno}); a bind mount cannot be ruled out`
  return m.points.length > 0 ? `mount point ${m.points[0]}` : null
}

/**
 * Why a `.prune-*` staging directory may not be used, or null: a directory,
 * owned by us and private (the park's one owner/mode definition,
 * `opDirOwnerModeProblem`), on the device `dev`.
 */
export function stagingProblem(sd: BigIntStats, dev: bigint): string | null {
  if (sd.isSymbolicLink() || !sd.isDirectory()) return 'not a directory'
  const om = opDirOwnerModeProblem(sd)
  if (om !== null) return om.replace('op directory', 'staging directory')
  return sd.dev !== dev ? 'on another device' : null
}

/** The name of a staging directory the walker makes: `.prune-<16 hex>`. */
export const PRUNE_DIR_RE = /^\.prune-[0-9a-f]{16}$/

/**
 * Why a resumed run may not use the staging directory `S` a crashed run left,
 * or null. Exactly these, in order: `S` is named `.prune-<16 hex>`; it sits
 * directly in `stagingRoot` (by path); it can be lstat'd; it is a directory,
 * not a symlink; it is owned by us and private (`opDirOwnerModeProblem`, as a
 * fresh `S` is); it is on the device `dev` (the copy's, as a fresh `S` is);
 * and it is on the same device as `stagingRoot` itself, which a fresh `S`
 * made by mkdir there is by construction (F3: a mount or a symlinked staging
 * root fails this).
 */
export function resumeStagingProblem(S: string, stagingRoot: string, dev: bigint): string | null {
  if (!PRUNE_DIR_RE.test(path.basename(S))) return 'not named .prune-<16 hex>'
  if (path.dirname(S) !== stagingRoot) return `not directly in ${stagingRoot}`
  let sd: BigIntStats
  let rootDev: bigint
  try {
    sd = fs.lstatSync(S, { bigint: true })
    rootDev = fs.lstatSync(stagingRoot, { bigint: true }).dev
  } catch (err) {
    return `unreadable (${errCode(err)})`
  }
  const bad = stagingProblem(sd, dev)
  if (bad !== null) return bad
  return sd.dev !== rootDev ? 'on another device than its staging root' : null
}

/**
 * The only rename any prune module makes: refuses when `to` already exists,
 * so no rename ever replaces an entry (Node has no RENAME_NOREPLACE; the lstat
 * leaves a one-syscall window, inside the 0700 staging directory or toward a
 * fresh random name, the R-swap class of ADR-166 D-11). Throws like rename(2):
 * an existing `to` is `EEXIST`.
 */
export function renameNoReplace(from: string, to: string): void {
  try {
    fs.lstatSync(to)
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      fs.renameSync(from, to)
      return
    }
    throw err
  }
  throw Object.assign(new Error(`EEXIST: ${to} already exists; not renamed onto`), {
    code: 'EEXIST',
  })
}
