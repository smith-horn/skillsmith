/**
 * SMI-6531 (A1 step 6a-iii): doctor's resume of a keep across devices (A1 plan
 * §3.3 "Publish sub-states" P1-P4, UD28; design § 5 "[publish] P2 / P3 / P4").
 * Called from `skill-recovery.resume.ts` once the area is bound:
 *
 *  - **P1** whose `rename(src, dest)` fails `EXDEV` (`acrossFor`): the
 *    verified copy of `skill-swap.xdev.ts` (`moveAcross`: the space check
 *    first, then copy, verify, rename the temp to `dest`), with the sidecar the
 *    crashed run published.
 *  - **P2** (`resumeCopyTemp`, a copy temp that is not the source): the temp
 *    is kept as `partial-copy` (sidecar first, then a rename within the area;
 *    `sourceUnchanged` true only when the source still matches its sidecar
 *    and the temp is a subset of it), never removed, then the copy starts again
 *    with the space check (`moveAcross`). A temp can hold the only copy of a
 *    file version, so it is kept even when it looks complete.
 *  - **P3** (the same call, when the temp hashes to the source): the sidecar
 *    is rewritten first if the source changed after it was published (the
 *    cross-device rewrite, the same order as `rewriteSidecar`), then `check`,
 *    the name still free, `rename(temp, dest)`, sync the area.
 *  - **P4** (`resumeCopied`): nothing moves. The source and `dest` must still
 *    hash to the sidecar's tree hash (a source changed after the copy is not
 *    parked: the run stops `changed-since-plan`, and the next plan classifies
 *    it as anything else); the area is synced, so `dest` is durable before the
 *    op dir is parked.
 *
 * Every verified source stays in OP (`st.moveSources`), which the finish parks
 * whole after its metadata is unlinked (UD28, `skill-recovery.park.ts`). A stop
 * on `ENOSPC` or `EDQUOT` here records the full-device marker first, through
 * `markIfFullDevice` (doctor's own record rewrite, `skill-recovery.mark.ts`).
 *
 * @module @skillsmith/core/services/skill-recovery.xdev
 */
import path from 'node:path'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { treeHashOf } from './skill-tree.js'
import type { TreeHashResult } from './skill-tree.js'
import { markIfFullDevice } from './skill-swap.fullmark.js'
import type { MoveProgress } from './skill-swap.fullmark.js'
import { check, hook, renameChecked, SwapFault, syncDir } from './skill-swap.ops.js'
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
import { isTreeSubsetOf, moveAcross } from './skill-swap.xdev.js'
import type { FullDeviceMarker, RecordIdentity } from './skill-swap.types.js'
import { boundOf } from './skill-recovery.state.js'
import type { KeepGroup } from './skill-recovery.types.js'

/** What a cross-device resume needs to know about the keep it continues. */
export interface AcrossKeep {
  group: KeepGroup
  /** The source in OP. */
  src: string
  kind: PublishKind
  /** The identity `<dest>.json` (or the rewrite temp now at its name) names for the source. */
  named: RecordIdentity | null
  /** The tree hash `<dest>.json` holds now. */
  sidecarHash: string | null
  /** The record's full-device marker, if any: a P2 temp it names was kept for `enospc`. */
  marker: FullDeviceMarker | null
  /** Where each `partial-copy` this resume keeps is recorded. */
  partials: string[]
  /**
   * A `partial-copy` keep of this group's copy temp killed after its sidecar
   * and before the rename (`KeepGroup.pendingTemp`): its `dest`, which the
   * resume finishes by the rename instead of keeping the temp a second time.
   */
  pending: string | null
}

/** The sidecar `moveAcross` carries: the source's, with the tree hash `<dest>.json` holds. */
function carried(
  st: SwapState,
  kind: PublishKind,
  h: TreeHashResult,
  id: BoundIdentity,
  treeHash: string | null
): Sidecar {
  const body = sidecarOf(st, kind, h, id)
  body.treeHash = treeHash
  if (treeHash !== null) delete body.treeHashError
  return body
}

/** The source bound now, which must be the tree its sidecar names. */
function boundSource(src: string, named: RecordIdentity | null): BoundIdentity {
  const id = bindIdentity(src)
  if (!id.ok || named === null || !sameIdentity(boundOf(named), id)) {
    throw new SwapFault('backup-unsafe', `${src} is not the tree its sidecar names`)
  }
  return id
}

/** The verified source stays in OP; the finish parks it with OP (UD28). */
function register(st: SwapState, src: string, id: BoundIdentity, dest: string, kind: string) {
  st.published = { src, dest, kind }
  st.moveSources.set(path.basename(src), { identity: id, dest })
}

/** P1 across devices: `moveAcross` from the published sidecar, run when the move's rename fails `EXDEV`. */
export function acrossFor(
  st: SwapState,
  a: { src: string; dest: string; kind: PublishKind; id: BoundIdentity; sidecarHash: string },
  h: Extract<TreeHashResult, { ok: true }>
): () => Promise<void> {
  return () =>
    moveAcross(st, {
      src: a.src,
      dest: a.dest,
      kind: a.kind,
      sidecar: carried(st, a.kind, h, a.id, a.sidecarHash),
      srcId: a.id,
      record: h.record,
    })
}

/** P4: the copy is at `dest` and the source still in OP. Verify both, sync the area, register. */
export async function resumeCopied(st: SwapState, k: AcrossKeep): Promise<string> {
  const { group: g, src } = k
  const id = boundSource(src, k.named)
  const s = treeHashOf(src)
  const d = treeHashOf(g.destPath)
  const want = k.sidecarHash
  if (!s.ok || !d.ok || want === null || s.hash !== want || d.hash !== want) {
    throw new SwapFault(
      'changed-since-plan',
      `${src} and its copy at ${g.destPath} no longer both hash to the sidecar's tree hash; ` +
        'nothing was parked. Run the command again to see the new plan'
    )
  }
  // An earlier run renamed `dest` into place; it is durable before OP is parked.
  await syncDir(st, st.areaPath)
  register(st, src, id, g.destPath, k.kind)
  return g.destPath
}

/** P2 or P3 (or a rewrite state beside a copy temp): finish the copy temp, or keep it and copy again. */
export async function resumeCopyTemp(st: SwapState, k: AcrossKeep): Promise<string> {
  const g = k.group
  const temp = path.join(st.areaPath, `.tmp-${g.base}`)
  const planned = g.copyTmp.present ? g.copyTmp.identity : null
  const tempId = bindIdentity(temp)
  if (planned === null || !tempId.ok || !sameIdentity(boundOf(planned), tempId)) {
    throw new SwapFault(
      'backup-unsafe',
      `${temp} is not the copy temp the plan observed; it was left untouched`
    )
  }
  const id = boundSource(k.src, k.named)
  const th = treeHashOf(temp)
  const sh = treeHashOf(k.src)
  if (th.ok && sh.ok && th.hash === sh.hash) return finishCopy(st, k, temp, id, sh)
  await keepPartial(st, k, temp, tempId, th, sh)
  await hook(st, 'afterPartialKeep')
  await moveAcross(st, {
    src: k.src,
    dest: g.destPath,
    kind: k.kind,
    sidecar: carried(st, k.kind, sh, id, k.sidecarHash),
    srcId: id,
    record: sh.ok ? sh.record : null,
  })
  return g.destPath
}

/** P3: the temp is the source. Rewrite the sidecar if the source changed, then rename the temp to `dest`. */
async function finishCopy(
  st: SwapState,
  k: AcrossKeep,
  temp: string,
  id: BoundIdentity,
  sh: Extract<TreeHashResult, { ok: true }>
): Promise<string> {
  const dest = k.group.destPath
  const progress: MoveProgress = { stage: 'sidecar-rewrite' }
  try {
    if (k.kind === 'backup' && sh.hash !== st.input.preTree) warnForeignChange(st, dest)
    if (sh.hash !== k.sidecarHash) {
      await rewriteSidecar(st, dest, carried(st, k.kind, sh, id, sh.hash))
    }
    check(st)
    if (await present(dest)) {
      throw new SwapFault('backup-unsafe', `${dest} appeared before the copy was moved there`)
    }
    progress.stage = 'final-rename'
    await renameChecked(st, temp, dest)
    register(st, k.src, id, dest, k.kind)
    progress.stage = 'final-sync'
    await syncDir(st, st.areaPath)
    await hook(st, 'afterBackupMove')
  } catch (err) {
    throw await markIfFullDevice(st, err, dest, progress)
  }
  return dest
}

/** P2: keeps the copy temp as `partial-copy` (its own sidecar, then a rename within the area). */
async function keepPartial(
  st: SwapState,
  k: AcrossKeep,
  temp: string,
  tempId: BoundIdentity,
  th: TreeHashResult,
  sh: TreeHashResult
): Promise<void> {
  if (k.pending !== null) {
    await finishPendingPartial(st, temp, tempId, k.pending, k.partials)
    return
  }
  // Plan §3.5 `partial-copy`: true only when the source still matches its sidecar and the
  // temp holds no bytes the source does not (every entry of the temp's tree is the source's).
  const sourceUnchanged =
    sh.ok &&
    k.sidecarHash !== null &&
    sh.hash === k.sidecarHash &&
    th.ok &&
    isTreeSubsetOf(th.record, sh.record)
  const partialCause: PartialCause =
    k.marker !== null && k.marker.dest === k.group.destPath
      ? 'enospc'
      : th.ok
        ? 'mismatch'
        : 'copy-failed'
  await keepTempAsPartial(st, temp, tempId, th, { sourceUnchanged, partialCause }, k)
}

/** Keeps `temp` as `partial-copy`: its own sidecar first, then a rename within the area, then the area synced. */
async function keepTempAsPartial(
  st: SwapState,
  temp: string,
  tempId: BoundIdentity,
  th: TreeHashResult,
  why: Pick<Sidecar, 'sourceUnchanged' | 'partialCause'>,
  k: Pick<AcrossKeep, 'partials'> & { group: Pick<KeepGroup, 'destPath'> }
): Promise<void> {
  const progress: MoveProgress = { stage: 'partial-keep' }
  try {
    const dest = await destFor(st, 'partial-copy')
    check(st)
    const now = bindIdentity(temp)
    if (!now.ok || !sameIdentity(tempId, now)) {
      throw new SwapFault('backup-unsafe', `${temp} changed before it was kept; left untouched`)
    }
    await writeSidecar(st, dest, sidecarOf(st, 'partial-copy', th, now, why))
    await renameChecked(st, temp, dest)
    await syncDir(st, st.areaPath)
    k.partials.push(dest)
  } catch (err) {
    throw await markIfFullDevice(st, err, k.group.destPath, progress)
  }
}

/**
 * The rest of a `partial-copy` keep killed after its sidecar was published
 * (`KeepGroup.pendingTemp`): the temp must still be the tree the sidecar
 * names (`tempId`, checked against it by the classifier) and `dest` free;
 * then the rename and the area sync. Nothing is written a second time.
 */
export async function finishPendingPartial(
  st: SwapState,
  temp: string,
  tempId: BoundIdentity,
  dest: string,
  partials: string[]
): Promise<string> {
  check(st)
  const now = bindIdentity(temp)
  if (!now.ok || !sameIdentity(tempId, now)) {
    throw new SwapFault('backup-unsafe', `${temp} changed before it was kept; left untouched`)
  }
  if (await present(dest)) {
    throw new SwapFault('backup-unsafe', `${dest} already exists; it was left untouched`)
  }
  await renameChecked(st, temp, dest)
  await syncDir(st, st.areaPath)
  partials.push(dest)
  return dest
}

/**
 * 6b-iii (`--abandon`): a copy temp of this op with no sidecar (an orphan, a
 * copy that never published) is kept as `partial-copy`, never removed: its
 * own identity and hash in its sidecar, `sourceUnchanged` false (there is no
 * sidecar to compare a source with) and `partialCause` `copy-failed`. The
 * temp must still be the one the plan observed. Returns where it was kept.
 * The area must be bound first.
 */
export async function keepOrphanCopyTemp(
  st: SwapState,
  group: KeepGroup,
  partials: string[],
  /** Its `partial-copy` sidecar is already published here (`pendingTemp`): only the rename is left. */
  pendingDest: string | null = null
): Promise<string> {
  const temp = path.join(st.areaPath, `.tmp-${group.base}`)
  const planned = group.copyTmp.present ? group.copyTmp.identity : null
  if (planned === null) {
    throw new SwapFault('backup-unsafe', `${temp} was not observed by the plan; left untouched`)
  }
  // The pending finish checks the temp against the plan's identity itself (the sidecar's).
  if (pendingDest !== null) {
    return finishPendingPartial(st, temp, boundOf(planned), pendingDest, partials)
  }
  const tempId = bindIdentity(temp)
  if (!tempId.ok || !sameIdentity(boundOf(planned), tempId)) {
    throw new SwapFault(
      'backup-unsafe',
      `${temp} is not the copy temp the plan observed; it was left untouched`
    )
  }
  const why = { sourceUnchanged: false, partialCause: 'copy-failed' } as const
  await keepTempAsPartial(st, temp, tempId, treeHashOf(temp), why, { partials, group })
  return partials[partials.length - 1]!
}
