/**
 * SMI-6531 (A1 steps 4a, 4c): transaction step 13, the op dir's last step (A1
 * plan §3.3 step 13, "Park intent", `publishTree` step 4's last bullets; UD28,
 * UD29, UD32, UD40).
 *
 * **One device** (`st.moveSources` empty): every tree left OP through
 * `publishTree`'s rename, so OP holds only its metadata. Unlink `record.json`
 * (sync OP), unlink `owner.json`, `rmdir` OP (sync ST). OP holding anything
 * else stops first, with nothing removed (`op-not-empty`).
 *
 * **Across devices**: each verified source is still in OP. `check`; OP must
 * hold exactly those sources and this run's `record.json` and `owner.json`,
 * each with the identity this run bound (UD40; otherwise the same
 * `op-not-empty` / `staging-unsafe` stop with the record kept). Then:
 *
 *  1. `park-intent.json` (kind `move-source`), durably, before `owner.json`
 *     goes, so a crash after it leaves an ownerless op dir doctor can verify;
 *  2. unlink `record.json`, sync OP; unlink `owner.json`;
 *  3. OP holds exactly the sources and the intent (UD40), then the park of OP
 *     from ST (`skill-swap.park-op.ts`, caller `move-source`, kind
 *     `move-source`, `backupPath` the first source's verified copy, which for
 *     an update is the backup).
 *
 * The move is complete before any of this, so from step 2 on nothing is an
 * `incomplete` stop: a park that ends `parked` reports both copies (UD29) and
 * prints them on one line; any other ending (`kept`, `held`, `stopped`, or a
 * stop before the park) adds a `removal-not-done` warning naming OP, the status
 * and reason (and, for `held`, the parked path) and prints one line naming
 * `skillsmith doctor recovery --clean-staging <opId>`, never `skillsmith
 * restore`: the origin is an op dir. OP then holds the sources and a verifying
 * intent, with no record or owner.
 *
 * @module @skillsmith/core/services/skill-swap.finish
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { SkillWriteStop } from './skill-write-lock.types.js'
import { writeParkIntent } from './skill-swap.intent.js'
import {
  check,
  hook,
  messageOf,
  opPaths,
  rethrowLockOrder,
  rmdirChecked,
  SwapFault,
  syncDir,
  unlinkOwned,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { opDiffers, parkOpFromStaging, say } from './skill-swap.park-op.js'
import type { NotDone, ParkOpOutcome } from './skill-swap.park-op.js'
import { cleanStagingHint } from './skill-swap.staging.js'
import { OLD_DIR, OWNER_FILE, PARK_INTENT_FILE, RECORD_FILE } from './skill-swap.types.js'

/** What step 13 adds to the result: the parked op dir, when the park finished. */
export interface Finish {
  extraCopy?: string
}

/** Step 13. Throws a stop (`incomplete` cleanup) only while the record is still kept. */
export async function finishOp(st: SwapState): Promise<Finish> {
  if (st.moveSources.size === 0) {
    await finishEmptyOp(st)
    return {}
  }
  return finishMoveSources(st)
}

/** One device: OP holds only its metadata. */
async function finishEmptyOp(st: SwapState): Promise<void> {
  check(st)
  const meta = new Set([RECORD_FILE, OWNER_FILE])
  const extra = (await fs.promises.readdir(st.opDir)).filter((n) => !meta.has(n)).sort()
  if (extra.length > 0) {
    throw new SwapFault('op-not-empty', `${st.opDir} still holds ${extra.join(', ')}`)
  }
  const { record, owner } = opPaths(st)
  await unlinkOwned(st, record, 'staging-unsafe')
  st.recordRemoved = true
  await syncDir(st, st.opDir)
  await unlinkOwned(st, owner, 'staging-unsafe')
  const left = await fs.promises.readdir(st.opDir)
  if (left.length > 0) {
    throw new SwapFault('op-not-empty', `${st.opDir} gained ${left.sort().join(', ')}`)
  }
  await rmdirChecked(st, st.opDir)
  await syncDir(st, st.binding.stagingDir)
}

/** The sources in OP, by name, with the identities bound for their sidecars. */
function sourcesExpected(st: SwapState): Map<string, BoundIdentity> {
  return new Map([...st.moveSources].map(([name, s]) => [name, s.identity]))
}

/** Adds this run's own metadata in OP to `into`, by name, as bound when it was created. */
function withOwned(st: SwapState, into: Map<string, BoundIdentity>, files: string[]) {
  for (const f of files) {
    const id = st.owned.get(f)
    if (id !== undefined) into.set(path.basename(f), id)
  }
  return into
}

/** Across devices: the intent, the metadata unlinks, then the park of OP. */
async function finishMoveSources(st: SwapState): Promise<Finish> {
  check(st)
  const p = opPaths(st)
  const before = await opDiffers(st, withOwned(st, sourcesExpected(st), [p.record, p.owner]))
  if (before !== null) {
    throw new SwapFault(
      before.reason === 'op-not-empty' ? 'op-not-empty' : 'staging-unsafe',
      before.detail ?? `${st.opDir} is not as this update left it`
    )
  }
  await writeParkIntent(st, 'move-source')
  await unlinkOwned(st, p.record, 'staging-unsafe')
  st.recordRemoved = true
  await syncDir(st, st.opDir)
  await hook(st, 'afterRecordUnlink')
  const backupPath = [...st.moveSources.values()][0]!.dest
  let outcome: ParkOpOutcome
  try {
    await unlinkOwned(st, p.owner, 'staging-unsafe')
    await hook(st, 'afterOwnerUnlink')
    const expected = withOwned(st, sourcesExpected(st), [p.intent])
    if (!expected.has(PARK_INTENT_FILE)) {
      throw new SwapFault('staging-unsafe', 'the park needs its intent bound')
    }
    const differs = await opDiffers(st, expected)
    outcome =
      differs !== null
        ? { status: 'not-done', notDone: differs }
        : await parkOpFromStaging(st, {
            caller: 'move-source',
            kind: 'move-source',
            backupPath,
            expected,
          })
  } catch (err) {
    rethrowLockOrder(err)
    const reason =
      err instanceof SwapFault ? err.reason : err instanceof SkillWriteStop ? err.code : 'stopped'
    const detail =
      err instanceof SwapFault
        ? err.detail
        : err instanceof SkillWriteStop
          ? err.detail
          : messageOf(err)
    outcome = { status: 'not-done', notDone: { status: 'stopped', reason, detail } }
  }
  return report(st, outcome, backupPath)
}

/** True for an update's step 13: the one source is the old folder, and its copy the backup. */
const isBackup = (st: SwapState): boolean =>
  st.moveSources.size === 1 && st.moveSources.has(OLD_DIR)

/** What the extra copy is a copy of, for the one line. */
const copyOf = (st: SwapState): string =>
  isBackup(st)
    ? 'the old folder'
    : `${[...st.moveSources.keys()].sort().join(' and ')} from ${st.opDir}`

/** The result's `extraCopy`, or the `removal-not-done` warning, with one line either way. */
function report(st: SwapState, o: ParkOpOutcome, backupPath: string): Finish {
  const kept = isBackup(st) ? 'backup' : 'kept copy'
  if (o.status === 'parked') {
    say(
      st,
      `${isBackup(st) ? 'Update' : 'Undo'} complete: ${kept} at ${backupPath}; ` +
        `an extra copy of ${copyOf(st)} was moved aside at ${o.parkedPath}.`
    )
    return { extraCopy: o.parkedPath }
  }
  const n: NotDone = o.notDone
  st.warnings.push({ code: 'removal-not-done', path: st.opDir, ...n })
  const errno = n.errno === undefined ? '' : ` (${n.errno})`
  const where = n.parkedPath === undefined ? '' : `; it is now at ${n.parkedPath}`
  const next =
    n.status === 'held'
      ? 'it may have changed while it was set aside'
      : `run \`${cleanStagingHint(st.opId)}\``
  say(
    st,
    `The ${kept} at ${backupPath} is complete, but Skillsmith did not set aside ` +
      `the extra copy of ${copyOf(st)} at ${st.opDir}: ${n.status}/${n.reason}${errno}${where}; ${next}.`
  )
  return {}
}
