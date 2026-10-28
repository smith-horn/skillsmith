/**
 * SMI-6531 (A1 step 6a-iii): doctor's two full-device duties (A1 plan §3.3
 * "A record with `fullDevice`", T-F1 "Space block"; design § 0, UD42).
 *
 * **Its own marker rewrite** (`rewriteMarkerAdopted`). When doctor's own
 * cross-device copy stops on `ENOSPC` or `EDQUOT`, `markIfFullDevice` records
 * the marker in `record.json` through `st.rewriteMarker`. Doctor did not write
 * that record, so the transaction's rewrite (which needs this run's binding)
 * does not apply: the new record is sealed with the marker, written to
 * `record.json.tmp` and synced, `record.json` must still be the adopted file
 * (identity and bytes), the temp is renamed over it (the one exception to the
 * metadata link rule, as in `skill-swap.fullmark.ts`), and OP is synced. A
 * `record.json.tmp` the re-plan adopted is unlinked first, and OP synced, so
 * the temp's name is free. A failure leaves the original stop standing, with
 * the note `markIfFullDevice` adds.
 *
 * **The space block** (`spaceBlock`). Under lock 1, after the re-plan and
 * before the first mutation, each tree the plan keeps that still has to be
 * copied across devices (a source with no keep, or one at P0, P1 or a rewrite
 * state without a copy temp) is measured against the free bytes and inodes of
 * the area's device, with the same estimate as `publishTree`'s space check.
 * Too little refuses `state-root-full` naming `FREE_SPACE_REMEDY` (free space
 * by hand; the prune command is not available yet), with nothing changed. A
 * P2 copy temp is not measured here: it is kept as `partial-copy` first, then
 * the copy's own space check runs, so the user can remove it by hand. Like that
 * check, it is a first-attempt filter.
 *
 * **The intent block** (`intentBlock`). At the same point, when any tree the
 * plan keeps is on another device than the area (so the finish will write a
 * park intent), the intent that finish would write is put through the
 * reader's acceptance first (`intentPrecheck`, `skill-swap.intent.ts`). One the
 * reader would refuse (a state root so deep the intent reaches `INTENT_CAP`)
 * refuses `staging-unsafe` with nothing changed, instead of stopping after the
 * keeps at the intent's write.
 *
 * @module @skillsmith/core/services/skill-recovery.mark
 */
import fs from 'node:fs'
import path from 'node:path'
import { messageOf, renameChecked, SwapFault, syncDir, writeNewFile } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { intentPrecheck } from './skill-swap.intent.js'
import {
  bytesNeeded,
  crossesDevices,
  FREE_SPACE_REMEDY,
  inodesNeeded,
  nearestDevice,
  shapeOf,
} from './skill-swap.space.js'
import { sealRecord } from './skill-swap.staging.js'
import type { FullDeviceMarker, SwapRecord } from './skill-swap.types.js'
import { ROLE_DIR } from './skill-recovery.pstate.js'
import { assertAdopted, unlinkAdopted } from './skill-recovery.state.js'
import type { Adopted } from './skill-recovery.state.js'
import type { OpFacts, PlanStep } from './skill-recovery.types.js'

/** Records `marker` in the adopted `record.json` (see the module comment). */
export async function rewriteMarkerAdopted(
  st: SwapState,
  record: Adopted,
  tmp: Adopted | null,
  marker: FullDeviceMarker
): Promise<void> {
  if (st.record === null || st.recordRemoved) {
    throw new SwapFault('staging-unsafe', 'this run holds no record.json to mark')
  }
  const final = record.path
  const temp = `${final}.tmp`
  if (tmp !== null && fs.existsSync(tmp.path)) {
    await unlinkAdopted(st, tmp)
    await syncDir(st, st.opDir)
  }
  const { recordSha256: _old, ...rest } = st.record
  const body: Omit<SwapRecord, 'recordSha256'> = { ...rest, fullDevice: marker }
  const sealed = sealRecord(body, st.binding.root, st.opId)
  await writeNewFile(st, temp, sealed.bytes, 0o600)
  assertAdopted(record)
  await renameChecked(st, temp, final)
  st.owned.set(final, st.owned.get(temp)!)
  st.owned.delete(temp)
  st.record = sealed.record
  try {
    await syncDir(st, st.opDir)
  } catch (err) {
    throw new SwapFault('marker-unsynced', messageOf(err), err)
  }
}

/**
 * What the space block reads: the roles, and T when the plan keeps it (a
 * no-record op dir, 6b-ii `--clean-staging`, has no T and keeps none).
 */
type SpaceFacts = Pick<OpFacts, 'roles'> & Partial<Pick<OpFacts, 't' | 'tPath'>>

/** The trees the plan keeps from a source, by path, each with whether its copy already started (P2-P4). */
function keptSources(
  st: SwapState,
  f: SpaceFacts,
  steps: readonly PlanStep[]
): Array<{ src: string; copied: boolean }> {
  const out: Array<{ src: string; copied: boolean }> = []
  for (const s of steps) {
    if (s.disposition.kind !== 'kept') continue
    if (s.tree === 'T') {
      if (f.t?.present === true && f.tPath !== undefined) out.push({ src: f.tPath, copied: false })
      continue
    }
    // `OP` (6b-i) is `--park`'s whole op dir: a rename within ST, never a copy.
    if (s.tree === 'OP') continue
    const res = f.roles[s.tree]
    if (res.kind !== 'source') continue
    const g = res.started
    const copied = g !== null && (g.copyTmp.present || g.dest.present)
    out.push({ src: path.join(st.opDir, ROLE_DIR[s.tree]), copied })
  }
  return out
}

/** The trees the plan keeps that still need a cross-device copy, by path. */
const toCopy = (st: SwapState, f: SpaceFacts, steps: readonly PlanStep[]): string[] =>
  keptSources(st, f, steps)
    .filter((k) => !k.copied)
    .map((k) => k.src)

/**
 * `staging-unsafe`'s detail when a keep the plan makes will cross devices and
 * the `move-source` intent the finish would then write is one the reader
 * would refuse; else null (see the module comment). Run before the first
 * mutation, beside `spaceBlock`.
 */
export function intentBlock(
  st: SwapState,
  f: SpaceFacts,
  steps: readonly PlanStep[]
): string | null {
  const across = keptSources(st, f, steps).some((k) => crossesDevices(k.src, st.areaPath))
  return across ? intentPrecheck(st, 'move-source') : null
}

/** `state-root-full` naming the free-space remedy when a copy the plan needs cannot fit; else null. */
export async function spaceBlock(
  st: SwapState,
  f: SpaceFacts,
  steps: readonly PlanStep[]
): Promise<string | null> {
  const area = nearestDevice(st.areaPath)
  if (area === null) return null
  for (const src of toCopy(st, f, steps)) {
    let dev: bigint
    try {
      dev = fs.lstatSync(src, { bigint: true }).dev
    } catch {
      continue
    }
    if (dev === area.dev) continue
    let shape: ReturnType<typeof shapeOf>
    let s: fs.BigIntStatsFs
    try {
      shape = shapeOf(src, null)
      s = await fs.promises.statfs(area.at, { bigint: true })
    } catch {
      // Unmeasurable here: the copy's own space check still runs.
      continue
    }
    const free = s.bavail * s.bsize
    const need = bytesNeeded(shape, s.bsize)
    const inodes = inodesNeeded(shape)
    // "Run this command again" is true only here: this check refuses before any
    // mutation and is reached only by `doctor recovery --apply`, `--undo` and
    // (6b-ii) `--clean-staging` (C10), so the same command can simply be rerun
    // once space is freed.
    const next = `${FREE_SPACE_REMEDY}, then run this command again`
    if (free < need) {
      return `${area.at} has ${free} bytes free and the backup of ${src} needs about ${need}; nothing was changed; ${next}`
    }
    if (s.files > 0n && s.ffree < inodes) {
      return `${area.at} has ${s.ffree} inodes free and the backup of ${src} needs ${inodes}; nothing was changed; ${next}`
    }
  }
  return null
}
