/**
 * SMI-6531 (A1 step 4c review rounds 3-4, owner decisions): the full-device
 * marker. When a cross-device move (`skill-swap.xdev.ts`) stops on `ENOSPC` or
 * `EDQUOT` at any point (the copy, a partial keep, the sidecar rewrite, the
 * final rename, or the area sync after it), this run's own `record.json`
 * records `fullDevice: { cause, stage, area, opId, dest }`. Doctor's resume
 * (step 6) reads it. The record is in OP, on the skills root's device, not the
 * full one, and it is kept by every stop that can reach here (step 12's
 * publish, the undo's keeps, abort cleanup's keeps after step 6's record), so
 * the next update of this skill is refused by step 3's record scan
 * (implementation-order step 5) until doctor finishes it.
 *
 * **Leftovers are derived, not listed** (round 4). The marker names no paths
 * beyond `dest`: whatever the move left is every entry of `area` that
 * `isFullDeviceLeftover(name, opId)` matches, read when the record is read.
 * Round 3 listed the paths at stop time, which missed a partial's sidecar and
 * recorded a failed lookup as an empty list (GPT-5.6-Sol round 4).
 *
 * **The rewrite.** `record.json` already exists, so the metadata publish's
 * `link` (which refuses an existing name) cannot replace it, and an unlink
 * then link would leave a moment with no `record.json` at all, the one state a
 * swapped op must never have. So: the new record is written to
 * `record.json.tmp` and synced; `record.json` is checked to still be the file
 * this run linked there (identity); the temp is renamed over it, which never
 * leaves the name empty; OP is synced. This rename-over is the one exception
 * to the metadata link rule (owner decision, round 3). A swap of `record.json`
 * between the identity check and the rename is the §3.0 item 9 residual (Node
 * has no `renameat2`).
 *
 * Two states it can leave beside a `record.json` (doctor's, step 6):
 *  - the identity check finds `record.json` replaced: nothing is renamed and
 *    the temp is left, the only copy of this run's record, marker included;
 *  - a crash or failure after the temp's sync and before the rename: a
 *    verifying `record.json` (without the marker) beside a different-inode
 *    `record.json.tmp` that carries it.
 *
 * If the marker cannot be written, the original stop still stands: its detail
 * gains a sentence saying the marker was not recorded, why, and the `dest` it
 * would have named. A failed build's keep (abort cleanup step 5) always takes
 * this branch: no `postTree`, so no record was ever written. That sentence
 * names the move's `dest`, from which `isFullDeviceLeftover` derives what it
 * left; nothing else records it (round 5). If the rename
 * over `record.json` succeeded and only OP's sync failed, it says the marker
 * was recorded but may not survive a power loss.
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
import type { PublishKind } from './skill-swap.sidecar.js'
import { sealRecord } from './skill-swap.staging.js'
import type { FullDeviceMarker, FullDeviceStage, SwapRecord } from './skill-swap.types.js'

/** What one cross-device move has done so far, for the marker. */
export interface MoveProgress {
  stage: FullDeviceStage
}

/**
 * The kinds `destFor` can name in the area (`<opId>.<kind>`); the backup is
 * `<opId>` itself. `satisfies` makes a new `PublishKind` a compile error here
 * until it is listed, so the predicate cannot silently miss its leftovers.
 */
const KEPT_KIND_TABLE = {
  undone: true,
  conflict: true,
  'failed-build': true,
  'edited-new': true,
  'unrecorded-new': true,
  'partial-copy': true,
} satisfies Record<Exclude<PublishKind, 'backup'>, true>
const KEPT_KINDS: ReadonlySet<string> = new Set(Object.keys(KEPT_KIND_TABLE))

/** True when `b` is a tree name a move makes: `<opId>`, or `<opId>.<kind>` with an optional `.<k>`. */
function isBase(b: string, opId: string): boolean {
  if (b === opId) return true
  if (!b.startsWith(`${opId}.`)) return false
  const parts = b.slice(opId.length + 1).split('.')
  if (parts.length > 2 || !KEPT_KINDS.has(parts[0]!)) return false
  return parts.length === 1 || /^[1-9][0-9]*$/.test(parts[1]!)
}

/**
 * True when `name`, an entry of a backup area, is one a cross-device move of
 * operation `opId` makes there (round 5: the producers' grammar, exactly):
 *  - a tree, `base`: `<opId>` (the backup) or `<opId>.<kind>`, with
 *    `destFor`'s `.<k>` suffix (`k` a positive integer, no leading zero) when
 *    the name was taken;
 *  - its copy temp, `.tmp-` + `base`;
 *  - its sidecar, `base` + `.json`, and the sidecar's temp, `base` + `.json.tmp`.
 * Never `.tmp-` with a `.json` suffix (no producer makes one), never another
 * opId's name (a prefix-sharing one included), and nothing for an empty opId.
 * Pure: no fs. A name says nothing about ownership: doctor binds and rechecks
 * each entry's identity, and never unlinks a `.json.tmp` it cannot prove is
 * this op's metadata.
 */
export function isFullDeviceLeftover(name: string, opId: string): boolean {
  if (opId.length === 0) return false
  if (name.startsWith('.tmp-')) return isBase(name.slice('.tmp-'.length), opId)
  if (name.endsWith('.json.tmp')) return isBase(name.slice(0, -'.json.tmp'.length), opId)
  if (name.endsWith('.json')) return isBase(name.slice(0, -'.json'.length), opId)
  return isBase(name, opId)
}

/** `ENOSPC` or `EDQUOT` from a failure, its cause, or its cause's cause; else null. */
export function fullDeviceCause(err: unknown): 'ENOSPC' | 'EDQUOT' | null {
  // Depth 3: a stop (0) whose cause is a keep's failure (1) whose cause is a
  // directory sync's errno (2): a copy that failed for another reason, then a
  // partial keep whose area sync filled the device (xdev's `failedCopy`).
  for (let e: unknown = err, i = 0; e !== undefined && e !== null && i < 3; i++) {
    const c = codeOf(e)
    if (c === 'ENOSPC' || c === 'EDQUOT') return c
    e = (e as { cause?: unknown }).cause
  }
  return null
}

/** Rewrites this run's `record.json` with `marker` (see the module comment). */
async function rewriteRecord(st: SwapState, marker: FullDeviceMarker): Promise<void> {
  const final = opPaths(st).record
  const bound = st.owned.get(final)
  if (st.record === null || st.recordRemoved || bound === undefined) {
    throw new SwapFault('staging-unsafe', 'this run holds no record.json to mark')
  }
  const { recordSha256: _old, ...rest } = st.record
  const body: Omit<SwapRecord, 'recordSha256'> = { ...rest, fullDevice: marker }
  // The same seal as step 5: the bytes written are a record the scan accepts.
  const { bytes, record } = sealRecord(body, st.binding.root, st.opId)
  const tmp = `${final}.tmp`
  await writeNewFile(st, tmp, bytes, 0o600)
  const now = await lstatOrNull(final)
  if (now === null || !sameIdentity(bound, identityOf(now))) {
    throw new SwapFault('staging-unsafe', `${final} is not the record this run wrote`)
  }
  await renameChecked(st, tmp, final)
  st.owned.set(final, st.owned.get(tmp)!)
  st.owned.delete(tmp)
  st.record = record
  try {
    await syncDir(st, st.opDir)
  } catch (err) {
    throw new SwapFault('marker-unsynced', messageOf(err), err)
  }
}

/**
 * The stop to throw for `err`, a failure of the move into `dest`. A
 * full-device stop is marked in the record first; any other failure is
 * returned unchanged.
 */
export async function markIfFullDevice(
  st: SwapState,
  err: unknown,
  dest: string,
  progress: MoveProgress
): Promise<unknown> {
  const cause = fullDeviceCause(err)
  if (cause === null) return err
  const marker: FullDeviceMarker = {
    cause,
    stage: progress.stage,
    area: path.dirname(dest),
    opId: st.opId,
    dest,
  }
  try {
    await rewriteRecord(st, marker)
    return err
  } catch (markErr) {
    const why = markErr instanceof SwapFault ? markErr.detail : messageOf(markErr)
    const note =
      markErr instanceof SwapFault && markErr.reason === 'marker-unsynced'
        ? `; the full-device marker was recorded in record.json, but ${st.opDir} could not be synced (${why}), so it may not survive a power loss`
        : `; the full-device marker was not recorded in record.json (${why}); it would have named ${dest}`
    if (err instanceof SwapFault) return new SwapFault(err.reason, `${err.detail}${note}`, err)
    return new SwapFault('write-failed', `${messageOf(err)}${note}`, err)
  }
}
