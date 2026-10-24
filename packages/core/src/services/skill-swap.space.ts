/**
 * SMI-6531 (A1 step 4c, rounds 1-2): the space checks that run first in a
 * cross-device `publishTree` (A1 plan §3.3 `publishTree` step 4, "Space
 * first"; E35). Each refuses `state-root-full`, naming
 * `skillsmith doctor backups --prune`, before anything is written.
 *
 * **The hard rule** (`refuseAfterFullDevice`, round 2, owner decision): if
 * the backup area (`<client>/<rootKey>/<dirName>`, holding every update's
 * backup of this folder, whatever its opId) already holds a copy a full
 * device left behind, refuse without copying. That is a `partial-copy` whose
 * sidecar records `partialCause: 'enospc'`, or whose sidecar is missing,
 * unreadable or names no cause (counted conservatively as `enospc`), or a
 * `.tmp-` copy temp (left at its name when the device was too full to write
 * the partial's own sidecar, or by a crash; either way an unfinished copy).
 * A `mismatch` partial (a concurrent write, not space) or a `copy-failed` one
 * does not block. This is what bounds E35's ratchet: at most one full-device
 * copy per area, however wrong the estimate below is.
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
 * out it ends `ENOSPC`, kept as an `enospc` partial, which the hard rule then
 * counts.
 *
 * @module @skillsmith/core/services/skill-swap.space
 */
import fs from 'node:fs'
import path from 'node:path'
import type { TreeRecord } from '../install/tree-hash.js'
import { codeOf, SwapFault } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'

/** The margin the space check adds (plan §3.3). */
export const SPACE_MARGIN_BYTES = 64 * 1024
/** Blocks (and inodes) reserved for metadata the move may still write. */
export const SIDECAR_BLOCKS = 2n
/** Inodes beyond the tree's entries and the sidecars. */
export const INODE_MARGIN = 16n

/** The command a `state-root-full` stop names. */
export const PRUNE_COMMAND = 'skillsmith doctor backups --prune'

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
  const next = `run \`${PRUNE_COMMAND}\` to free space, then finish the update with doctor`
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

/** True when a kept partial's sidecar says the copy was not stopped by space. */
async function notFromSpace(sidecarPath: string): Promise<boolean> {
  try {
    const v = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8')) as {
      partialCause?: unknown
    }
    return v.partialCause === 'mismatch' || v.partialCause === 'copy-failed'
  } catch {
    // Missing or unreadable: counted as a full device (the conservative side).
    return false
  }
}

/**
 * The hard rule (see the module comment): refuses `state-root-full` when the
 * area already holds a copy a full device left, whatever update made it.
 */
export async function refuseAfterFullDevice(st: SwapState): Promise<void> {
  let names: string[]
  try {
    names = (await fs.promises.readdir(st.areaPath)).sort()
  } catch (err) {
    throw new SwapFault(
      'write-failed',
      `the backup area ${st.areaPath} could not be listed (${codeOf(err) ?? 'unknown'})`,
      err
    )
  }
  for (const n of names) {
    if (n.endsWith('.json') || n.endsWith('.json.tmp')) continue
    const temp = n.startsWith('.tmp-')
    if (!temp && !n.includes('.partial-copy')) continue
    if (!temp && (await notFromSpace(path.join(st.areaPath, `${n}.json`)))) continue
    throw new SwapFault(
      'state-root-full',
      `${st.areaPath} already holds ${path.join(st.areaPath, n)}, ` +
        (temp ? 'an unfinished copy' : 'a partial copy a full device left') +
        `, so no further copy is made there; run \`${PRUNE_COMMAND}\` to free space, then finish the update with doctor`
    )
  }
}
