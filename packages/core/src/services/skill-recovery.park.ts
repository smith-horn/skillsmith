/**
 * SMI-6531 (A1 step 6a-iii): the end of a doctor action whose keeps went
 * across devices (A1 plan §3.3 "Recovery invariant", UD28, UD32, UD40; design
 * § 4 "`finishRecovered`", § 5 "[finish] cross-device", § 7, Q3).
 *
 * Each cross-device keep left its verified source in OP (`st.moveSources`), so
 * OP is parked whole instead of removed. Under lock 1, in this order:
 *
 *  1. `check`; OP holds exactly the sources (with the identities bound when
 *     they were verified) and the adopted metadata (UD40's rule; anything else
 *     stops `op-not-empty` or `staging-unsafe` with the record kept);
 *  2. the park intent (kind `move-source`) is made durable: a provable
 *     `park-intent.json.tmp` an earlier run left is unlinked, then the intent
 *     an earlier run published is reused, or a new one is published (temp
 *     synced, linked, temp unlinked, OP synced);
 *  3. the other metadata (`owner.json`, an adopted `record.json.tmp`) is
 *     unlinked, each through `unlinkAdopted`, then OP synced;
 *  4. `record.json` last (§7), then OP synced. A kill before this leaves an op
 *     the same command classifies and finishes (the intent is reused). A kill
 *     after it leaves OP with its sources and a verifying intent and no
 *     record: `doctor recovery --clean-staging <opId>` finishes that park (6b);
 *  5. OP must hold exactly the sources and the intent, then the park of OP
 *     from ST (`parkOpFromStaging`, caller and kind `move-source`, `backupPath`
 *     the first kept copy's path, design Q3).
 *
 * Once `record.json` is unlinked nothing is a stop: the keeps are complete and
 * no record is left to name. A park that ends other than `parked` (`kept`,
 * `held`, `stopped`, or any failure after the unlink) adds a
 * `removal-not-done` warning naming OP, its status and reason, and the command
 * exits 4 (UD32). Nothing here removes a tree.
 *
 * @module @skillsmith/core/services/skill-recovery.park
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { afterRecord } from './skill-swap.finish.js'
import { writeParkIntent } from './skill-swap.intent.js'
import { check, hook, opPaths, SwapFault, syncDir } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { opDiffers, parkOpFromStaging } from './skill-swap.park-op.js'
import type { ParkOpOutcome } from './skill-swap.park-op.js'
import { OWNER_FILE, PARK_INTENT_FILE, RECORD_FILE } from './skill-swap.types.js'
import { boundOf, unlinkAdopted } from './skill-recovery.state.js'
import type { Adopted } from './skill-recovery.state.js'

const name = (a: Adopted): string => path.basename(a.path)

/** The sources in OP, by name, as bound when each was verified. */
function sources(st: SwapState): Map<string, BoundIdentity> {
  return new Map([...st.moveSources].map(([n, s]) => [n, s.identity]))
}

/**
 * The cross-device finish (see the module comment). `adopted` is every
 * metadata file the re-plan adopted, `record.json` included; `intent` is a
 * verifying `park-intent.json` an earlier run published, or null. Returns the
 * parked path, or null when the park did not finish (then the warning says
 * why). Throws a stop only while `record.json` is kept.
 */
export async function finishRecoveredAcross(
  st: SwapState,
  adopted: readonly Adopted[],
  intent: Adopted | null
): Promise<string | null> {
  await hook(st, 'beforeMetadataCleanup')
  check(st)
  const record = adopted.find((a) => name(a) === RECORD_FILE)
  if (record === undefined) throw new SwapFault('staging-unsafe', 'record.json is not adopted')
  const names = await fs.promises.readdir(st.opDir)
  const held = adopted.filter((a) => names.includes(name(a)))
  const expected = sources(st)
  for (const a of held) expected.set(name(a), boundOf(a.identity))
  if (intent !== null) expected.set(PARK_INTENT_FILE, boundOf(intent.identity))
  const before = await opDiffers(st, expected)
  if (before !== null) {
    throw new SwapFault(
      before.reason === 'op-not-empty' ? 'op-not-empty' : 'staging-unsafe',
      before.detail ?? `${st.opDir} is not as the plan saw it`
    )
  }
  const intentTmp = held.find((a) => name(a) === `${PARK_INTENT_FILE}.tmp`) ?? null
  if (intentTmp !== null) {
    await unlinkAdopted(st, intentTmp)
    await syncDir(st, st.opDir)
  }
  const backupPath = [...st.moveSources.values()][0]!.dest
  let intentId: BoundIdentity
  if (intent !== null) {
    intentId = boundOf(intent.identity)
  } else {
    await writeParkIntent(st, 'move-source', backupPath)
    const id = st.owned.get(opPaths(st).intent)
    if (id === undefined) throw new SwapFault('staging-unsafe', 'the park needs its intent bound')
    intentId = id
  }
  for (const a of held) {
    if (a === record || a === intentTmp) continue
    await unlinkAdopted(st, a)
    if (name(a) === OWNER_FILE) await hook(st, 'afterOwnerUnlink')
  }
  await syncDir(st, st.opDir)
  await unlinkAdopted(st, record)
  st.recordRemoved = true
  let outcome: ParkOpOutcome | null = null
  const n = await afterRecord(async () => {
    await hook(st, 'afterRecordUnlink')
    await syncDir(st, st.opDir)
    await hook(st, 'afterRecoveredOpSync')
    const parkSet = sources(st).set(PARK_INTENT_FILE, intentId)
    const differs = await opDiffers(st, parkSet)
    if (differs !== null) return differs
    outcome = await parkOpFromStaging(st, {
      caller: 'move-source',
      kind: 'move-source',
      backupPath,
      expected: parkSet,
    })
    return null
  })
  const o: ParkOpOutcome = n === null ? outcome! : { status: 'not-done', notDone: n }
  if (o.status === 'parked') return o.parkedPath
  st.warnings.push({ code: 'removal-not-done', path: st.opDir, ...o.notDone })
  return null
}
