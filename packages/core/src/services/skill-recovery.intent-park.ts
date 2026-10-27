/**
 * SMI-6531 (A1 step 6a-iii, owner decision 2026-10-26): `--apply` and
 * `--undo` finish the park of an op dir whose record is already gone, the
 * state a cross-device finish leaves when it is killed after it unlinked
 * `record.json` (A1 plan §3.3 "Park intent", "A kill around the op dir's park").
 *
 * The op dir is accepted only with a `park-intent.json` that verifies for its
 * opId and OP's current identity (`isParkIntentFor`, the check
 * `--clean-staging` uses), of kind `move-source`, whose `backupPath` is this
 * root's backup area plus the opId, and whose other entries are tree
 * directories (`old`, `new`, `undone`) and at most `owner.json`
 * (`skill-recovery.opdir.ts`, `noRecordIntent`). The plan, the prompt, the
 * other-user refusal (owner.json's uid, else the intent's) and the re-plan
 * digest under lock 1 are the same as for any other plan.
 *
 * Under lock 1, in the uninterrupted finish's order: `check`; OP holds exactly
 * the entries the re-plan saw, each with the identity it saw; `owner.json` (if
 * there) is unlinked through `unlinkAdopted` and OP synced; OP holds exactly
 * the sources and the intent; then the park of OP from ST
 * (`parkOpFromStaging`: a fresh guard hash, caller and kind `move-source`,
 * `backupPath` from the intent). A park that ends other than `parked` is a
 * `removal-not-done` warning (exit 4, UD32). A stop before the park keeps OP
 * as it was, so the same command resumes it. Nothing is removed but
 * `owner.json`.
 *
 * The `SwapState` built here carries no record: only the fields the park reads
 * (the binding, OP and its identity, the client, the state root's parked
 * index) are real. Its manifest port refuses, since nothing here commits.
 *
 * @module @skillsmith/core/services/skill-recovery.intent-park
 */
import path from 'node:path'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { check, hook, SwapFault, syncDir } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { opDiffers, parkOpFromStaging } from './skill-swap.park-op.js'
import { OWNER_FILE, PARK_INTENT_FILE } from './skill-swap.types.js'
import type { ManifestPort, SwapOptions } from './skill-swap.types.js'
import { adoptMetadata, boundOf, unlinkAdopted } from './skill-recovery.state.js'
import type { NoRecordIntent, ReadTranscript, RecoveryClass } from './skill-recovery.types.js'
import type { SkillWriteContext } from './skill-write-lock.types.js'

type NoRecord = Extract<RecoveryClass, { kind: 'no-record' }>

const refusingPort: ManifestPort = {
  withManifestLock: () => {
    throw new SwapFault('write-failed', 'a park from its intent never commits the manifest')
  },
}

/** The state the park of a no-record op dir needs (see the module comment). */
function intentState(
  ctx: SkillWriteContext,
  cls: NoRecord,
  i: NoRecordIntent,
  options: SwapOptions
): SwapState {
  const t = i.target!
  const backupPath = i.backupPath!
  const opIdentity = boundOf(opIdentityOf(cls, i))
  const realDir = path.join(ctx.root, t.dirName)
  return {
    input: {
      skillsDir: ctx.root,
      client: t.client,
      scope: 'user',
      stateRoot: t.stateRoot,
      manifestPath: path.join(t.stateRoot, 'manifest.json'),
      manifestKey: t.dirName,
      comparedPath: realDir,
      realDir,
      dirName: t.dirName,
      oldIdentity: opIdentity,
      preTree: '',
      writeSet: [],
      preEntry: null,
      postEntry: null,
      manifest: refusingPort,
    },
    options,
    opId: cls.opId,
    binding: ctx,
    warnings: [],
    opDir: cls.opDir,
    ctx,
    opCreated: false,
    op: { path: cls.opDir, identity: opIdentity },
    area: null,
    buildIdentity: null,
    published: null,
    moveSources: new Map(
      i.sources.map((s) => [s.name, { identity: boundOf(s.identity), dest: backupPath }])
    ),
    owner: null,
    newIdentity: null,
    postTree: null,
    postRecord: null,
    stateRootReal: t.stateRoot,
    areaPath: path.dirname(backupPath),
    backupDest: backupPath,
    recordRemoved: true,
    record: null,
    owned: new Map(),
    blockedBy: null,
    phase: 'locked',
    step: 'audit',
  }
}

/** OP's identity, as the intent names it (the classifier required it to be OP's current one). */
function opIdentityOf(cls: NoRecord, i: NoRecordIntent) {
  const id = i.opIdentity
  if (id === null) throw new SwapFault('staging-unsafe', `${cls.opDir} has no verified identity`)
  return id
}

export interface IntentParkResult {
  st: SwapState
  /** The parked path, or null when the park did not finish (the warning says why). */
  extraCopy: string | null
}

/** Finishes the park of a no-record op dir from its intent, under lock 1. Throws a stop before the park. */
export async function finishFromIntent(
  ctx: SkillWriteContext,
  cls: NoRecord,
  transcript: ReadTranscript,
  options: SwapOptions
): Promise<IntentParkResult> {
  const i = cls.intent
  if (i === null || i.blocked !== null) {
    throw new SwapFault('staging-unsafe', `${cls.opDir} has no park intent that verifies`)
  }
  const st = intentState(ctx, cls, i, options)
  await hook(st, 'beforeMetadataCleanup')
  check(st)
  const owner = cls.entries.includes(OWNER_FILE)
    ? adoptMetadata(transcript, path.join(cls.opDir, OWNER_FILE))
    : null
  const intent = adoptMetadata(transcript, i.path)
  const parkSet = new Map<string, BoundIdentity>(
    i.sources.map((s) => [s.name, boundOf(s.identity)])
  )
  parkSet.set(PARK_INTENT_FILE, boundOf(intent.identity))
  const seen = new Map(parkSet)
  if (owner !== null) seen.set(OWNER_FILE, boundOf(owner.identity))
  const before = await opDiffers(st, seen)
  if (before !== null) {
    throw new SwapFault(
      before.reason === 'op-not-empty' ? 'op-not-empty' : 'staging-unsafe',
      before.detail ?? `${cls.opDir} is not as the plan saw it`
    )
  }
  if (owner !== null) {
    await unlinkAdopted(st, owner)
    await hook(st, 'afterOwnerUnlink')
    await syncDir(st, cls.opDir)
  }
  const differs = await opDiffers(st, parkSet)
  if (differs !== null) {
    st.warnings.push({ code: 'removal-not-done', path: cls.opDir, ...differs })
    return { st, extraCopy: null }
  }
  const o = await parkOpFromStaging(st, {
    caller: 'move-source',
    kind: 'move-source',
    backupPath: i.backupPath!,
    expected: parkSet,
  })
  if (o.status === 'parked') return { st, extraCopy: o.parkedPath }
  st.warnings.push({ code: 'removal-not-done', path: cls.opDir, ...o.notDone })
  return { st, extraCopy: null }
}
