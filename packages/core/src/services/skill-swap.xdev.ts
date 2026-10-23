/**
 * SMI-6531 (A1 step 4c): `publishTree` step 4, the verified cross-device move
 * (A1 plan §3.3 "`publishTree`" step 4; UD11, UD14 as revised by UD28; E23h,
 * E32-E35, E38). It runs after the sidecar is published and `rename(src,
 * dest)` failed `EXDEV`, so nothing has moved:
 *
 *  1. **Space first.** `statfs` the area. Free bytes below the tree's bytes
 *     plus 64 KiB stop with `state-root-full`, naming
 *     `skillsmith doctor backups --prune`, before anything is written (E35:
 *     without it each retry on a full disk kept one more partial copy).
 *  2. **Copy.** `check`; the copy temp `<area>/.tmp-<basename(dest)>` is made
 *     by the no-follow copy's own plain `mkdir` (an existing entry there is
 *     `backup-unsafe`, untouched), its identity bound and the area synced
 *     before anything is copied into it; the copy syncs every file and
 *     directory. Then the temp is hashed, and `src` hashed again.
 *  3. **A mismatch** keeps the temp as kind `partial-copy` (its own sidecar,
 *     `sourceUnchanged` recorded; a rename within the area) and copies once
 *     more into a fresh temp. A second mismatch is kept the same way and stops
 *     `write-failed`. A temp can hold file versions that exist nowhere else,
 *     so no temp is ever removed (E34).
 *  4. **A failed copy** (`ENOSPC` included) keeps whatever temp it made as
 *     `partial-copy` and stops `write-failed`, naming the full device for
 *     `ENOSPC`. A `check` that fails mid-copy stops with no further mutation:
 *     the temp is left at its name for doctor (P2).
 *  5. **Finish.** If the verified hash differs from the sidecar's `treeHash`
 *     (the source changed after it was hashed), the sidecar is rewritten
 *     (`rewriteSidecar`). Then `check`, the fixed name still free (UD38),
 *     `rename(temp, dest)`, sync the area.
 *  6. **The move's last step.** The verified `src` stays in OP
 *     (`st.moveSources`); step 13 parks OP whole (UD28). Nothing is removed.
 *
 * `sourceUnchanged` is true when `src` hashes, at the moment of the keep, to
 * the treeHash its sidecar holds: for a mismatch that is false whenever the
 * source changed after the sidecar hashed it, which is the case the plan
 * names. A non-directory `src` (an undo's recreated O) cannot be copied by the
 * tree copy: it stops `write-failed` with the tree still in OP and the record
 * kept.
 *
 * Residual (UD11 as revised by UD28): a write through a file opened inside
 * `src` before it left the skill path, landing after the final hash, lands in
 * the parked source, not in `dest`. It is kept, not lost.
 *
 * @module @skillsmith/core/services/skill-swap.xdev
 */
import fs from 'node:fs'
import path from 'node:path'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { treeBytes } from '../install/park-tree.postmove.js'
import type { TreeRecord } from '../install/tree-hash.js'
import { copyTreeNoFollow, treeHashOf } from './skill-tree.js'
import type { CopyResult } from './skill-tree.js'
import { check, codeOf, hook, renameChecked, SwapFault, syncDir, trace } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import {
  destFor,
  present,
  rewriteSidecar,
  sidecarOf,
  warnForeignChange,
  writeSidecar,
} from './skill-swap.sidecar.js'
import type { PublishKind, Sidecar } from './skill-swap.sidecar.js'

/** The margin the space check adds to the tree's bytes (plan §3.3). */
export const SPACE_MARGIN_BYTES = 64 * 1024

/** The command a `state-root-full` stop names. */
export const PRUNE_COMMAND = 'skillsmith doctor backups --prune'

/** One cross-device move: the tree, its fixed `dest`, and the sidecar already published there. */
export interface Move {
  src: string
  dest: string
  kind: PublishKind
  sidecar: Sidecar
  srcId: BoundIdentity
  /** `src`'s tree record from the sidecar's hash, or null when it could not be hashed. */
  record: TreeRecord | null
}

/** The tree's bytes: file and symlink sizes, as the parked sidecar counts them. */
function bytesOf(m: Move): bigint {
  if (m.record === null) {
    try {
      return BigInt(treeBytes(m.src))
    } catch {
      return 0n
    }
  }
  let n = 0n
  for (const e of m.record.values()) if (e.type !== 'dir') n += e.size
  return n
}

/** The device holding the area, as its bound identity names it. */
const deviceOf = (st: SwapState): string => {
  const last = st.area?.[st.area.length - 1]
  return last === undefined ? st.areaPath : `${st.areaPath} (device ${last.identity.dev})`
}

/** Step 1: refuse before anything is written when the area lacks the room. */
async function spaceFirst(st: SwapState, m: Move): Promise<void> {
  let free: bigint
  try {
    const s = await fs.promises.statfs(st.areaPath, { bigint: true })
    free = s.bavail * s.bsize
  } catch (err) {
    throw new SwapFault(
      'write-failed',
      `the free space at ${st.areaPath} could not be measured (${codeOf(err) ?? 'unknown'})`,
      err
    )
  }
  const need = bytesOf(m) + BigInt(SPACE_MARGIN_BYTES)
  if (free < need) {
    throw new SwapFault(
      'state-root-full',
      `${deviceOf(st)} has ${free} bytes free and the backup of ${m.src} needs ${need}; ` +
        `run \`${PRUNE_COMMAND}\` to free space, then finish the update with doctor`
    )
  }
}

interface Copied {
  result: CopyResult
  /** The temp this run's `mkdir` made, once bound; null when it made none. */
  tempId: BoundIdentity | null
}

/** Step 2's copy. A `check` or area-sync failure inside it rejects (the temp stays). */
async function copyToTemp(st: SwapState, src: string, temp: string): Promise<Copied> {
  let tempId: BoundIdentity | null = null
  check(st)
  const result = await copyTreeNoFollow(src, temp, {
    afterRootMade: async () => {
      const made = bindIdentity(temp)
      if (!made.ok) throw new SwapFault('backup-unsafe', `${temp} vanished after its mkdir`)
      tempId = made
      trace(st, { op: 'mkdir', path: temp })
      await syncDir(st, st.areaPath)
    },
    afterEntry: (rel) => {
      st.options.duringBackupCopy?.(rel)
      check(st)
    },
  })
  return { result, tempId }
}

/**
 * Keeps this run's temp as `partial-copy` (sidecar first, then a rename within
 * the area). Returns where it went, or null when the temp is not the one this
 * run made (then nothing is touched).
 */
async function keepPartial(
  st: SwapState,
  temp: string,
  tempId: BoundIdentity | null,
  m: Move
): Promise<string | null> {
  const now = bindIdentity(temp)
  if (tempId === null || !now.ok || !sameIdentity(tempId, now)) return null
  const s = treeHashOf(m.src)
  const sourceUnchanged = s.ok && m.sidecar.treeHash !== null && s.hash === m.sidecar.treeHash
  const dest = await destFor(st, 'partial-copy')
  await writeSidecar(
    st,
    dest,
    sidecarOf(st, 'partial-copy', treeHashOf(temp), now, { sourceUnchanged })
  )
  await renameChecked(st, temp, dest)
  await syncDir(st, st.areaPath)
  return dest
}

/** Step 4: a copy that failed. Keeps what it can, then throws the stop. */
async function failedCopy(st: SwapState, m: Move, temp: string, c: Copied): Promise<never> {
  const r = c.result
  if (r.ok) throw new Error('unreachable')
  if (r.reason === 'dest-exists') {
    throw new SwapFault('backup-unsafe', `${temp} already exists; it was left untouched`)
  }
  let kept: string
  try {
    const at = await keepPartial(st, temp, c.tempId, m)
    kept = at === null ? 'no copy temp was made' : `the partial copy is kept at ${at}`
  } catch (err) {
    kept = `the partial copy is left at ${temp} (${codeOf(err) ?? 'keep failed'})`
  }
  if (r.errno === 'ENOSPC') {
    throw new SwapFault(
      'write-failed',
      `no space is left on ${deviceOf(st)} (ENOSPC at ${r.path}) while copying ${m.src}; ${kept}`
    )
  }
  throw new SwapFault(
    'write-failed',
    `the cross-device copy of ${m.src} failed (${r.reason} at ${r.path}${
      r.errno === null ? '' : `, ${r.errno}`
    }); ${kept}`
  )
}

/** Steps 2-3: copy until the temp equals the source, at most twice. Returns the temp's hash. */
async function copyVerified(st: SwapState, m: Move, temp: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const c = await copyToTemp(st, m.src, temp)
    if (!c.result.ok) return failedCopy(st, m, temp, c)
    trace(st, { op: 'copy', path: m.src, dest: temp })
    await hook(st, 'afterBackupCopy')
    const t = treeHashOf(temp)
    const s = treeHashOf(m.src)
    const equal = t.ok && s.ok ? t.hash === s.hash : null
    trace(st, { op: 'compare', path: temp, equal })
    if (equal === true && t.ok) return t.hash
    const kept = await keepPartial(st, temp, c.tempId, m)
    if (attempt === 2) {
      throw new SwapFault(
        'write-failed',
        `${m.src} changed while it was copied, twice; each copy is kept as partial-copy` +
          (kept === null ? ` (the second left at ${temp})` : ` (the second at ${kept})`)
      )
    }
  }
}

/** `publishTree` step 4 (see the module comment). Throws `SwapFault` or `SkillWriteStop`. */
export async function moveAcross(st: SwapState, m: Move): Promise<void> {
  await spaceFirst(st, m)
  const temp = path.join(st.areaPath, `.tmp-${path.basename(m.dest)}`)
  const hash = await copyVerified(st, m, temp)
  await hook(st, 'afterBackupVerify')
  if (hash !== m.sidecar.treeHash) {
    const body: Sidecar = { ...m.sidecar, treeHash: hash }
    delete body.treeHashError
    if (m.kind === 'backup' && hash !== st.input.preTree) warnForeignChange(st, m.dest)
    await rewriteSidecar(st, m.dest, body)
  }
  check(st)
  if (await present(m.dest)) {
    throw new SwapFault('backup-unsafe', `${m.dest} appeared before the copy was moved there`)
  }
  await renameChecked(st, temp, m.dest)
  st.published = { src: m.src, dest: m.dest, kind: m.kind }
  st.moveSources.set(path.basename(m.src), { identity: m.srcId, dest: m.dest })
  await syncDir(st, st.areaPath)
  await hook(st, 'afterBackupMove')
}
