/**
 * SMI-6531 (A1 step 4c review round 3, owner decision): the full-device
 * marker. When a cross-device move (`skill-swap.xdev.ts`) stops on `ENOSPC` or
 * `EDQUOT` at any point (the copy, a partial keep, the sidecar rewrite, the
 * final rename, or the area sync after it), this run's own `record.json`
 * records the cause, the stage and the exact leftovers on the full device.
 * Doctor's resume (step 6) reads it. The record is in OP, on the skills root's
 * device, not the full one, and it is kept by every stop that can reach here
 * (step 12's publish, the undo's keeps, abort cleanup's keeps after step 6's
 * record), so the next update of this skill is refused by step 3's record scan
 * (implementation-order step 5) until doctor finishes it.
 *
 * Replaced the round-2 area-scan cap (UD42 as first decided), which matched
 * names only: a complete copy renamed to `<area>/<opId>` whose area sync then
 * failed escaped it (GPT-5.6-Sol round 3), and it named a prune that cannot
 * see copy temps (governance round 3).
 *
 * **The rewrite.** `record.json` already exists, so the metadata publish's
 * `link` (which refuses an existing name) cannot replace it, and an unlink
 * then link would leave a moment with no `record.json` at all, the one state a
 * swapped op must never have. So: the new record is written to
 * `record.json.tmp` and synced; `record.json` is checked to still be the file
 * this run linked there (identity); the temp is renamed over it, which never
 * leaves the name empty; OP is synced. A crash before the rename leaves the
 * old record (valid, without the marker) beside the temp, and step 3 reads
 * only `record.json`. A swap of `record.json` between the identity check and
 * the rename is the §3.0 item 9 residual (Node has no `renameat2`). This
 * rename-over is the one exception to the metadata link rule (owner decision,
 * round 3). If the identity check finds `record.json` replaced, nothing is
 * renamed and the temp is left: it is then the only copy of this run's record,
 * marker included, so it is evidence for doctor, not metadata to unlink.
 *
 * If the marker cannot be written (no record this run owns, or the rewrite
 * fails), the original stop still stands: its detail gains a sentence saying
 * the marker was not recorded and why. Nothing else changes.
 *
 * @module @skillsmith/core/services/skill-swap.fullmark
 */
import path from 'node:path'
import { identityOf, sameIdentity } from '../install/park-tree.identity.js'
import {
  codeOf,
  lstatOrNull,
  messageOf,
  opPaths,
  renameChecked,
  SwapFault,
  syncDir,
  writeNewFile,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { present } from './skill-swap.sidecar.js'
import { computeRecordSha256 } from './skill-swap.staging.js'
import type {
  FullDeviceLeftover,
  FullDeviceMarker,
  FullDeviceStage,
  SwapRecord,
} from './skill-swap.types.js'

/** What one cross-device move has done so far, for the marker. */
export interface MoveProgress {
  stage: FullDeviceStage
  /** Every copy temp this move kept as `partial-copy`. */
  partials: Array<{ path: string; sourceUnchanged: boolean }>
}

/** `ENOSPC` or `EDQUOT` from a failure, its cause, or its cause's cause; else null. */
export function fullDeviceCause(err: unknown): 'ENOSPC' | 'EDQUOT' | null {
  for (let e: unknown = err, i = 0; e !== undefined && e !== null && i < 3; i++) {
    const c = codeOf(e)
    if (c === 'ENOSPC' || c === 'EDQUOT') return c
    e = (e as { cause?: unknown }).cause
  }
  return null
}

/** The leftovers on the full device, as they are now. */
async function leftoversOf(
  st: SwapState,
  temp: string,
  dest: string,
  progress: MoveProgress
): Promise<FullDeviceLeftover[]> {
  const out: FullDeviceLeftover[] = []
  if (await present(temp)) out.push({ kind: 'copy-temp', path: temp })
  for (const p of progress.partials) {
    if (await present(p.path)) out.push({ kind: 'partial-copy', ...p })
  }
  if (st.published?.dest === dest && (await present(dest))) out.push({ kind: 'backup', path: dest })
  if (await present(`${dest}.json.tmp`)) {
    out.push({ kind: 'sidecar-temp', path: `${dest}.json.tmp` })
  }
  return out
}

/** Rewrites this run's `record.json` with `marker` (see the module comment). */
async function rewriteRecord(st: SwapState, marker: FullDeviceMarker): Promise<void> {
  const final = opPaths(st).record
  const bound = st.owned.get(final)
  if (st.record === null || st.recordRemoved || bound === undefined) {
    throw new SwapFault('staging-unsafe', 'this run holds no record.json to mark')
  }
  const { recordSha256: _old, ...rest } = st.record
  void _old
  const body: Omit<SwapRecord, 'recordSha256'> = { ...rest, fullDevice: marker }
  const record: SwapRecord = { ...body, recordSha256: computeRecordSha256(body) }
  const tmp = `${final}.tmp`
  await writeNewFile(st, tmp, Buffer.from(JSON.stringify(record, null, 2) + '\n'), 0o600)
  const now = await lstatOrNull(final)
  if (now === null || !sameIdentity(bound, identityOf(now))) {
    throw new SwapFault('staging-unsafe', `${final} is not the record this run wrote`)
  }
  await renameChecked(st, tmp, final)
  st.owned.set(final, st.owned.get(tmp)!)
  st.owned.delete(tmp)
  st.record = record
  await syncDir(st, st.opDir)
}

/**
 * The stop to throw for `err`, a failure of the move into `dest` through
 * `temp`. A full-device stop is marked in the record first; any other failure
 * is returned unchanged.
 */
export async function markIfFullDevice(
  st: SwapState,
  err: unknown,
  temp: string,
  dest: string,
  progress: MoveProgress
): Promise<unknown> {
  const cause = fullDeviceCause(err)
  if (cause === null) return err
  const marker: FullDeviceMarker = {
    cause,
    stage: progress.stage,
    area: path.dirname(dest),
    leftovers: await leftoversOf(st, temp, dest, progress).catch(() => []),
  }
  try {
    await rewriteRecord(st, marker)
    return err
  } catch (markErr) {
    const why = markErr instanceof SwapFault ? markErr.detail : messageOf(markErr)
    const note = `; the full-device marker was not recorded in record.json (${why})`
    if (err instanceof SwapFault) return new SwapFault(err.reason, `${err.detail}${note}`, err)
    return new SwapFault('write-failed', `${messageOf(err)}${note}`, err)
  }
}
