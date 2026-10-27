/**
 * SMI-6531 (A1 step 4c, rounds 1-3): the space check that runs first in a
 * cross-device `publishTree` (A1 plan §3.3 `publishTree` step 4, "Space
 * first"; E35). It refuses `state-root-full`, naming `FREE_SPACE_REMEDY`
 * (free space by hand; the prune command is not available yet), before
 * anything is written.
 *
 * What stops a retry from piling up full-device copies is not here: a
 * full-device stop keeps this op's `record.json` and marks it with the cause,
 * stage, area, opId and dest (`skill-swap.fullmark.ts`, rounds 3-4; the
 * leftovers are derived from the opId), so step 3's record scan
 * refuses the next update of this skill until doctor resumes it. Round 2's
 * area scan, which recognised leftovers by name, is deleted (a complete copy
 * renamed to `<area>/<opId>` whose area sync then failed escaped it).
 *
 * **The estimate** is a first-attempt filter only. It does not promise the
 * copy fits: directory indexes, extent and other allocation metadata are not
 * counted (GPT-5.6-Sol round 2), so a copy that passes it can still end
 * `ENOSPC`. It estimates what the copy will ALLOCATE, not the tree's logical
 * bytes (a tree of 200 one-byte files counts 200 bytes and allocates 819,200
 * on tmpfs, governance round 1):
 *
 *  - every file and symlink rounded up to the filesystem's block size
 *    (`statfs` `bsize`), at least one block each;
 *  - one block per directory, the root included;
 *  - `SIDECAR_BLOCKS` for the metadata the move may still write (a sidecar
 *    rewrite's temp and a partial copy's sidecar);
 *  - plus the plan's 64 KiB margin.
 *
 * It also checks inodes: `statfs` `ffree` must be at least the entry count plus
 * the sidecars and `INODE_MARGIN`. A filesystem that reports no inode table at
 * all (`files` of 0, as btrfs does) has no inode limit to check, so that check
 * is skipped there; the block check still runs.
 *
 * The estimate covers one copy. A copy that mismatches is kept and redone
 * once (plan §3.3), and the second copy can need the space again; if it runs
 * out it ends `ENOSPC`, kept as an `enospc` partial, named in the marker.
 *
 * @module @skillsmith/core/services/skill-swap.space
 */
import fs from 'node:fs'
import path from 'node:path'
import type { TreeRecord } from '../install/tree-hash.js'
import { codeOf, SwapFault } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { FREE_SPACE_REMEDY } from './skill-swap.types.js'

/** The margin the space check adds (plan §3.3). */
export const SPACE_MARGIN_BYTES = 64 * 1024
/** Blocks (and inodes) reserved for metadata the move may still write. */
export const SIDECAR_BLOCKS = 2n
/** Inodes beyond the tree's entries and the sidecars. */
export const INODE_MARGIN = 16n

/** The remedy a `state-root-full` stop names (defined fs-free in `skill-swap.types.ts`). */
export { FREE_SPACE_REMEDY }

/** What the copy creates: each file's and symlink's size, and the directory count. */
export interface TreeShape {
  sizes: bigint[]
  dirs: bigint
}

/** The shape from the sidecar's tree record, or (when it could not hash) an `lstat` walk. */
export function shapeOf(src: string, record: TreeRecord | null): TreeShape {
  const shape: TreeShape = { sizes: [], dirs: 0n }
  if (record !== null) {
    for (const e of record.values()) {
      if (e.type === 'dir') shape.dirs++
      else shape.sizes.push(e.size)
    }
    return shape
  }
  const walk = (p: string): void => {
    const s = fs.lstatSync(p, { bigint: true })
    if (s.isDirectory()) {
      shape.dirs++
      for (const n of fs.readdirSync(p)) walk(path.join(p, n))
    } else if (s.isFile() || s.isSymbolicLink()) shape.sizes.push(s.size)
  }
  try {
    walk(src)
  } catch (err) {
    throw new SwapFault(
      'write-failed',
      `${src} could not be measured for the space check (${codeOf(err) ?? 'unknown'})`,
      err
    )
  }
  return shape
}

/** Bytes the copy is estimated to allocate at block size `bsize`, the margin included. */
export function bytesNeeded(shape: TreeShape, bsize: bigint): bigint {
  const b = bsize > 0n ? bsize : 1n
  let blocks = shape.dirs + SIDECAR_BLOCKS
  for (const size of shape.sizes) {
    const n = (size + b - 1n) / b
    blocks += n > 0n ? n : 1n
  }
  return blocks * b + BigInt(SPACE_MARGIN_BYTES)
}

/** Inodes the copy is estimated to use. */
export const inodesNeeded = (shape: TreeShape): bigint =>
  BigInt(shape.sizes.length) + shape.dirs + SIDECAR_BLOCKS + INODE_MARGIN

/** The device holding the area, as its bound identity names it. */
export const deviceOf = (st: SwapState): string => {
  const last = st.area?.[st.area.length - 1]
  return last === undefined ? st.areaPath : `${st.areaPath} (device ${last.identity.dev})`
}

/** Refuses `state-root-full` when the area lacks the blocks or the inodes for the copy. */
export async function spaceFirst(st: SwapState, src: string, record: TreeRecord | null) {
  const shape = shapeOf(src, record)
  let s: fs.BigIntStatsFs
  try {
    s = await fs.promises.statfs(st.areaPath, { bigint: true })
  } catch (err) {
    throw new SwapFault(
      'write-failed',
      `the free space at ${st.areaPath} could not be measured (${codeOf(err) ?? 'unknown'})`,
      err
    )
  }
  const free = s.bavail * s.bsize
  const need = bytesNeeded(shape, s.bsize)
  // Facts and the free-space remedy only. `publishTree` reaches this check from
  // six callers (the update's backup, the update's undo, abort cleanup, and
  // doctor's resume, run and cross-device moves), and what to run afterwards
  // differs for each, so any next step written here would be wrong for some of
  // them. Each caller's own result line names its next action.
  const next = FREE_SPACE_REMEDY
  if (free < need) {
    throw new SwapFault(
      'state-root-full',
      `${deviceOf(st)} has ${free} bytes free and the backup of ${src} needs about ${need} ` +
        `(${shape.sizes.length} files and links, ${shape.dirs} directories, ${s.bsize}-byte blocks); ${next}`
    )
  }
  const inodes = inodesNeeded(shape)
  if (s.files > 0n && s.ffree < inodes) {
    throw new SwapFault(
      'state-root-full',
      `${deviceOf(st)} has ${s.ffree} inodes free and the backup of ${src} needs ${inodes}; ${next}`
    )
  }
}
