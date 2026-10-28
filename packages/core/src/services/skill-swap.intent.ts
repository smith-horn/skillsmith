/**
 * SMI-6531 (A1 steps 4b, 4c): `park-intent.json`, written into OP before abort
 * cleanup (kind `abort-new`) or step 13 after a cross-device move (kind
 * `move-source`) unlinks `owner.json` (A1 plan §3.3 "Park intent", review
 * round 1 F3).
 *
 * Without it, a crash between the `owner.json` unlink and the park would leave
 * an op dir with no record and no owner, which doctor cannot tell apart from
 * one another writer has just made and not yet given an `owner.json`. With
 * it, `doctor recovery --clean-staging <opId>` (step 6) finishes the intended
 * park without `--unsafe-unverified-owner`, but only when the intent parses,
 * matches this schema, names this op dir's `opId`, and OP's current identity
 * equals the recorded one (`isParkIntentFor`).
 *
 * It is published like the other metadata (`publishJson`): a temp, synced,
 * `link`ed to `park-intent.json` (never replacing an entry there), the temp
 * unlinked after a check that it is the file this run wrote, then OP synced.
 * It stays in OP, so the guard hash of OP covers it and it travels into the
 * parked area with the tree (UD28).
 *
 * @module @skillsmith/core/services/skill-swap.intent
 */
import os from 'node:os'
import { attributionOf } from './skill-swap.attribution.js'
import { hook, opPaths, SwapFault } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { publishJson, recordIdentity } from './skill-swap.staging.js'
import type { ParkIntent, ParkIntentKind } from './skill-swap.types.js'

/**
 * The intent this run writes: OP's identity as `createOp` bound it, and the
 * owner it recorded. A `move-source` intent also names `backupPath`, the
 * verified copy the park's held message names (6a-iii: doctor finishes the
 * park from the intent alone once the record is gone). An `abort-new` intent
 * is schema 2 (6b-ii, O1): it copies `owner.json`'s attribution, so doctor's
 * `--clean-staging` can name the park's client and parked index once
 * `owner.json` is gone. A `move-source` intent stays schema 1: its
 * `backupPath` already names the state root, client and folder.
 */
export function parkIntentOf(
  st: SwapState,
  kind: ParkIntentKind = 'abort-new',
  backupPath?: string
): ParkIntent {
  if (st.op === null) throw new SwapFault('staging-unsafe', 'the park intent needs a bound OP')
  // `owner.json` is written before anything else in OP. An update that
  // published it has `st.owner` set; doctor's `--clean-staging` sets it from
  // the op dir's own `owner.json` when that parses whole. Only a run with
  // neither (no owner.json was ever published or readable) names this process.
  const owner = st.owner ?? {
    pid: process.pid,
    host: os.hostname(),
    uid: process.geteuid?.() ?? -1,
  }
  const base = {
    opId: st.opId,
    owner: { pid: owner.pid, host: owner.host, uid: owner.uid },
    opIdentity: recordIdentity(st.op.identity),
  }
  if (kind === 'abort-new') return { schema: 2, ...base, kind, ...attributionOf(st) }
  if (backupPath === undefined) {
    throw new SwapFault('staging-unsafe', 'a move-source park intent needs the backup path')
  }
  return { schema: 1, ...base, kind, backupPath }
}

/** Publishes `park-intent.json` durably. Kill points: `afterIntentTemp`, `afterIntent`. */
export async function writeParkIntent(
  st: SwapState,
  kind: ParkIntentKind = 'abort-new',
  backupPath?: string
): Promise<void> {
  const intent = parkIntentOf(st, kind, backupPath)
  await publishJson(st, opPaths(st).intent, intent, 'afterIntentTemp')
  await hook(st, 'afterIntent')
}

export { isParkIntentFor } from './skill-swap.intent-schema.js'
