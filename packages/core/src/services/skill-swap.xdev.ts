/**
 * SMI-6531 (A1 step 4c): `publishTree` step 4, the verified cross-device move
 * (A1 plan §3.3 "`publishTree`" step 4; UD11, UD14 as revised by UD28; E23h,
 * E32-E35, E38). It runs after the sidecar is published and `rename(src,
 * dest)` failed `EXDEV`, so nothing has moved:
 *
 *  1. **Space first** (`skill-swap.space.ts`): fewer free bytes than the
 *     copy's estimated allocation, or fewer free inodes than its entries,
 *     refuse `state-root-full` naming `FREE_SPACE_REMEDY` (free space by
 *     hand; the prune command is not available yet), before anything is
 *     written. A first-attempt filter only: it does not promise the copy fits
 *     (directory indexes and extent metadata are not counted, GPT-5.6-Sol
 *     round 2).
 *  2. **Copy.** `check`; the copy temp `<area>/.tmp-<basename(dest)>` is made
 *     by the no-follow copy's own plain `mkdir` (an existing entry there is
 *     `backup-unsafe`, untouched), its identity bound and the area synced
 *     before anything is copied into it; the copy syncs every file and
 *     directory. Then the temp is hashed, and `src` hashed again.
 *  3. **A mismatch** keeps the temp as kind `partial-copy` (its own sidecar,
 *     `sourceUnchanged: false`; a rename within the area) and copies once
 *     more into a fresh temp. A second mismatch is kept the same way and stops
 *     `write-failed`. A temp can hold file versions that exist nowhere else,
 *     so no temp is ever removed (E34).
 *  4. **A failed copy** (`ENOSPC` included) keeps whatever temp it made as
 *     `partial-copy` and stops `write-failed`, naming the full device for
 *     `ENOSPC` or `EDQUOT` (its sidecar `partialCause: 'enospc'`; any other
 *     failure is `copy-failed`, a mismatch `mismatch`).
 *     **Any** stop on `ENOSPC` or `EDQUOT`, at any stage of steps 2-5 (the
 *     copy, a partial keep, the sidecar rewrite, the final rename, the area
 *     sync after it), first records the full-device marker (cause, stage,
 *     area, opId, dest; the leftovers are derived from the opId), in this op's
 *     kept `record.json`
 *     (`skill-swap.fullmark.ts`); that kept record is what refuses the next
 *     update until doctor resumes this one. For `ENOSPC`, `sourceUnchanged` is
 *     computed: true when `src` still hashes to its sidecar's `treeHash` and
 *     the kept temp is a subset of `src` (`isTreeSubsetOf`). For any other copy failure it
 *     is false, as for a mismatch. If the keep itself fails (the partial's
 *     sidecar cannot be written on a full device), the temp is left at its
 *     name and the stop says so. A `check` that fails mid-copy stops with no
 *     further mutation: the temp is left at its name for doctor (P2).
 *  5. **Finish.** If the verified hash differs from the sidecar's `treeHash`
 *     (the source changed after it was hashed), the sidecar is rewritten
 *     (`rewriteSidecar`). Then `check`, the fixed name still free (UD38),
 *     `rename(temp, dest)`, sync the area.
 *  6. **The move's last step.** The verified `src` stays in OP
 *     (`st.moveSources`); step 13 parks OP whole (UD28). Nothing is removed.
 *
 * A non-directory `src` (an undo's recreated O) cannot be copied by the tree
 * copy: it stops `write-failed` with the tree still in OP and the record kept.
 *
 * Residual (the ADR-155 empty-directory class, as for the backup's own move):
 * keeping a temp as `partial-copy` is a plain `rename(temp, <opId>.partial-copy…)`
 * after `destFor` found the name free. An empty directory another process
 * creates at that name in between is replaced by it silently; a non-empty one
 * fails the rename, which stops the run. Nothing is lost but that empty
 * directory.
 *
 * Residual (UD11 as revised by UD28): a write through a file opened inside
 * `src` before it left the skill path, landing after the final hash, lands in
 * the parked source, not in `dest`. It is kept, not lost.
 *
 * @module @skillsmith/core/services/skill-swap.xdev
 */
import path from 'node:path'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
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
import type { PartialCause, PublishKind, Sidecar } from './skill-swap.sidecar.js'
import { deviceOf, spaceFirst } from './skill-swap.space.js'
import { markIfFullDevice } from './skill-swap.fullmark.js'
import type { MoveProgress } from './skill-swap.fullmark.js'

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
 * Every entry of `temp` is in `src` with the same content: a file's size and
 * bytes, a link's text, a directory's type: the temp holds no bytes the source
 * does not (plan §3.5 `partial-copy`, `sourceUnchanged`). Shared by this
 * module's partial keep and doctor's P2 keep (`skill-recovery.xdev.ts`). Modes are not compared (a copy
 * killed mid-way can leave a directory at its creation mode); they hold no bytes.
 */
export function isTreeSubsetOf(temp: TreeRecord, src: TreeRecord): boolean {
  for (const [rel, e] of temp) {
    const s = src.get(rel)
    if (s === undefined || s.type !== e.type) return false
    if (e.type === 'file' && (s.size !== e.size || (s as typeof e).contentHash !== e.contentHash)) {
      return false
    }
    if (e.type === 'symlink' && (s as typeof e).linkText !== e.linkText) return false
  }
  return true
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
  m: Move,
  partialCause: PartialCause,
  progress: MoveProgress
): Promise<string | null> {
  const now = bindIdentity(temp)
  if (tempId === null || !now.ok || !sameIdentity(tempId, now)) return null
  // Computed only for `ENOSPC` (plan §3.3); a mismatch is `false` by definition.
  // True only when the source still matches its sidecar AND the temp is a
  // subset of it (plan §3.5): an edit made in the temp keeps it false.
  const s = partialCause === 'enospc' ? treeHashOf(m.src) : null
  const t = treeHashOf(temp)
  const sourceUnchanged =
    s !== null &&
    s.ok &&
    m.sidecar.treeHash !== null &&
    s.hash === m.sidecar.treeHash &&
    t.ok &&
    isTreeSubsetOf(t.record, s.record)
  const dest = await destFor(st, 'partial-copy')
  const was = progress.stage
  progress.stage = 'partial-keep'
  await writeSidecar(
    st,
    dest,
    sidecarOf(st, 'partial-copy', t, now, { sourceUnchanged, partialCause })
  )
  await renameChecked(st, temp, dest)
  await syncDir(st, st.areaPath)
  progress.stage = was
  return dest
}

/** Step 4: a copy that failed. Keeps what it can, then throws the stop. */
async function failedCopy(
  st: SwapState,
  m: Move,
  temp: string,
  c: Copied,
  progress: MoveProgress
): Promise<never> {
  const r = c.result
  if (r.ok) throw new Error('unreachable')
  if (r.reason === 'dest-exists') {
    throw new SwapFault('backup-unsafe', `${temp} already exists; it was left untouched`)
  }
  const full = r.errno === 'ENOSPC' || r.errno === 'EDQUOT'
  let kept: string
  let keepErr: unknown = undefined
  try {
    const at = await keepPartial(st, temp, c.tempId, m, full ? 'enospc' : 'copy-failed', progress)
    kept = at === null ? 'no copy temp was made' : `the partial copy is kept at ${at}`
  } catch (err) {
    keepErr = err
    kept = `the partial copy is left at ${temp} (${codeOf(err) ?? 'keep failed'})`
  }
  if (full) {
    throw new SwapFault(
      'write-failed',
      `no space is left on ${deviceOf(st)} (${r.errno} at ${r.path}) while copying ${m.src}; ${kept}`,
      { code: r.errno }
    )
  }
  // The keep's own failure is this stop's cause, so a full device there is
  // seen by `fullDeviceCause` (governance round 4).
  throw new SwapFault(
    'write-failed',
    `the cross-device copy of ${m.src} failed (${r.reason} at ${r.path}${
      r.errno === null ? '' : `, ${r.errno}`
    }); ${kept}`,
    keepErr
  )
}

/** Steps 2-3: copy until the temp equals the source, at most twice. Returns the temp's hash. */
async function copyVerified(
  st: SwapState,
  m: Move,
  temp: string,
  progress: MoveProgress
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const c = await copyToTemp(st, m.src, temp)
    if (!c.result.ok) return failedCopy(st, m, temp, c, progress)
    trace(st, { op: 'copy', path: m.src, dest: temp })
    await hook(st, 'afterBackupCopy')
    const t = treeHashOf(temp)
    const s = treeHashOf(m.src)
    const equal = t.ok && s.ok ? t.hash === s.hash : null
    trace(st, { op: 'compare', path: temp, equal })
    if (equal === true && t.ok) return t.hash
    const kept = await keepPartial(st, temp, c.tempId, m, 'mismatch', progress)
    if (attempt === 2) {
      throw new SwapFault(
        'write-failed',
        `${m.src} changed while it was copied, twice; each copy is kept as partial-copy` +
          (kept === null ? ` (the second left at ${temp})` : ` (the second at ${kept})`)
      )
    }
  }
}

/**
 * `publishTree` step 4 (see the module comment). Throws `SwapFault` or
 * `SkillWriteStop`; a stop on a full device first records the full-device
 * marker in this run's `record.json` (`skill-swap.fullmark.ts`).
 */
export async function moveAcross(st: SwapState, m: Move): Promise<void> {
  await spaceFirst(st, m.src, m.record)
  const temp = path.join(st.areaPath, `.tmp-${path.basename(m.dest)}`)
  const progress: MoveProgress = { stage: 'copy' }
  try {
    await moveVerified(st, m, temp, progress)
  } catch (err) {
    throw await markIfFullDevice(st, err, m.dest, progress)
  }
}

/** Steps 2-6: copy, verify, rewrite the sidecar if needed, rename to `dest`, sync. */
async function moveVerified(
  st: SwapState,
  m: Move,
  temp: string,
  progress: MoveProgress
): Promise<void> {
  const hash = await copyVerified(st, m, temp, progress)
  await hook(st, 'afterBackupVerify')
  if (hash !== m.sidecar.treeHash) {
    const body: Sidecar = { ...m.sidecar, treeHash: hash }
    delete body.treeHashError
    if (m.kind === 'backup' && hash !== st.input.preTree) warnForeignChange(st, m.dest)
    progress.stage = 'sidecar-rewrite'
    await rewriteSidecar(st, m.dest, body)
  }
  check(st)
  if (await present(m.dest)) {
    throw new SwapFault('backup-unsafe', `${m.dest} appeared before the copy was moved there`)
  }
  progress.stage = 'final-rename'
  await renameChecked(st, temp, m.dest)
  st.published = { src: m.src, dest: m.dest, kind: m.kind }
  st.moveSources.set(path.basename(m.src), { identity: m.srcId, dest: m.dest })
  progress.stage = 'final-sync'
  await syncDir(st, st.areaPath)
  await hook(st, 'afterBackupMove')
}
