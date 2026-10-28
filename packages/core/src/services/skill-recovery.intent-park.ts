/**
 * SMI-6531 (A1 steps 6a-iii, 6b-ii; owner decision 2026-10-26): finishing the
 * park of an op dir whose record is gone, from its verifying
 * `park-intent.json` (A1 plan §3.3 "Park intent", "A kill around the op
 * dir's park"; design `step6b-design.md` § 1.2 case (a)).
 *
 * Two intents, two callers:
 *  - **`move-source`**, the state a cross-device finish leaves once it has
 *    written its intent, then is killed: an update after it unlinked
 *    `record.json`, or doctor's own cross-device `--apply`/`--undo` (each
 *    unlinks `record.json` after the intent) or `--clean-staging` (which
 *    never had a record): `--apply` and `--undo` finish it
 *    (6a-iii), and so does `--clean-staging` (6b-ii). The intent's
 *    `backupPath` must be this root's backup area plus `<opId>` or
 *    `<opId>.<kind>[.<k>]` (`intentTarget`), in a state root doctor
 *    discovered or was given; it names the park's client and parked index.
 *  - **`abort-new`** (6b-ii), abort cleanup's: only `--clean-staging`
 *    finishes it. It parks `new/` and the intent, with caller
 *    `abort-cleanup`; the client and the parked index come from O1 (the
 *    attribution `owner.json` and the schema-2 intent carry, validated all or
 *    nothing; else client `none` and the primary state root's index, or none).
 *
 * The op dir is accepted only when the intent verifies for its opId and OP's
 * current identity (`isParkIntentFor`), and its other entries are its sources
 * (`old`, `new`, `undone`), at most `owner.json`, and (6b-ii) the metadata
 * temps the classifier proved this op's (`record.json.tmp`,
 * `park-intent.json.tmp`: a kill inside a metadata publish).
 *
 * Under lock 1, in the uninterrupted finish's order: `check`; OP holds exactly
 * the entries the re-plan saw, each with the identity it saw; the temps, then
 * `owner.json` (if there), are unlinked through `unlinkAdopted` and OP synced;
 * OP holds exactly the sources and the intent; then the park of OP from ST
 * (`parkOpFromStaging`: a fresh guard hash). A park that ends other than
 * `parked` is a `removal-not-done` warning (exit 4, UD32). A stop before the
 * park keeps OP as it was, so the same command resumes it. Nothing is removed
 * but metadata.
 *
 * The `SwapState` built here carries no record: only the fields the park reads
 * (the binding, OP and its identity, the client, the state root's parked
 * index) are real. Its manifest port refuses, since nothing here commits.
 *
 * @module @skillsmith/core/services/skill-recovery.intent-park
 */
import path from 'node:path'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import {
  keepSidecarOf,
  parkClientOf,
  parkIndexOf,
  routeRootOf,
} from './skill-recovery.attribution.js'
import { processOwnerNow, check, hook, SwapFault, syncDir } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { opDiffers, parkOpFromStaging } from './skill-swap.park-op.js'
import type { ParkOpOutcome } from './skill-swap.park-op.js'
import { OWNER_FILE, PARK_INTENT_FILE } from './skill-swap.types.js'
import type { ManifestPort, SwapOptions } from './skill-swap.types.js'
import { adoptMetadata, boundOf, unlinkAdopted } from './skill-recovery.state.js'
import type { Adopted } from './skill-recovery.state.js'
import type { NoRecordIntent, ReadTranscript, RecoveryClass } from './skill-recovery.types.js'
import type { SkillWriteContext } from './skill-write-lock.types.js'

type NoRecord = Extract<RecoveryClass, { kind: 'no-record' }>

const refusingPort: ManifestPort = {
  withManifestLock: () => {
    throw new SwapFault('write-failed', 'a park from its intent never commits the manifest')
  },
}

/** Where the park goes: its client and scope, the state root (its parked index) and the folder name. */
interface Route {
  client: string
  /** The install scope the park names; `none` when no validated attribution backs the client. */
  scope: string
  stateRoot: string
  dirName: string
  backupPath: string | null
}

/**
 * A move-source intent's route is its `backupPath`'s (`target`); an abort-new
 * one's is O1's. The scope has one rule with the client: it is O1's only when
 * O1 validated and names the very park the client names. For a move-source
 * intent that means the attribution's client, state root and folder name all
 * equal `target`'s; otherwise the scope is `none`, never a field of another
 * park's attribution next to this park's client.
 *
 * @internal Exported for its test only; the park scope is not observable from a finished park.
 */
export function routeOf(cls: NoRecord, i: NoRecordIntent): Route {
  const a = cls.clean.attribution
  if (i.kind === 'move-source') {
    const t = i.target!
    const agrees =
      a.kind === 'attributed' &&
      a.client === t.client &&
      a.stateRoot === t.stateRoot &&
      a.dirName === t.dirName
    return {
      client: t.client,
      scope: agrees ? a.scope : 'none',
      stateRoot: t.stateRoot,
      dirName: t.dirName,
      backupPath: i.backupPath!,
    }
  }
  return {
    client: parkClientOf(a),
    scope: keepSidecarOf(a, cls.opId).scope,
    stateRoot: routeRootOf(a) ?? '',
    dirName: a.kind === 'attributed' ? a.dirName : cls.opId,
    backupPath: null,
  }
}

/** The state the park of a no-record op dir needs (see the module comment). */
function intentState(
  ctx: SkillWriteContext,
  cls: NoRecord,
  i: NoRecordIntent,
  r: Route,
  options: SwapOptions
): SwapState {
  const opIdentity = boundOf(opIdentityOf(cls, i))
  const realDir = path.join(ctx.root, r.dirName)
  return {
    input: {
      skillsDir: ctx.root,
      client: r.client,
      // `routeOf`'s scope: O1's only when O1 backs the client named above, else `none`.
      scope: r.scope,
      stateRoot: r.stateRoot,
      manifestPath: path.join(r.stateRoot, 'manifest.json'),
      manifestKey: r.dirName,
      comparedPath: realDir,
      realDir,
      dirName: r.dirName,
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
    moveSources:
      r.backupPath === null
        ? new Map()
        : new Map(
            i.sources.map((s) => [s.name, { identity: boundOf(s.identity), dest: r.backupPath! }])
          ),
    owner: null,
    self: processOwnerNow(),
    newIdentity: null,
    postTree: null,
    postRecord: null,
    stateRootReal: r.stateRoot,
    areaPath: r.backupPath === null ? '' : path.dirname(r.backupPath),
    backupDest: r.backupPath ?? '',
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

/** Why the intent's park cannot be finished by this caller, or null. */
function blockedFor(cls: NoRecord, i: NoRecordIntent): string | null {
  // abort-new: `--clean-staging`'s own check (`intentBlocked`); move-source: `--apply`/`--undo`'s.
  return i.kind === 'abort-new' ? cls.clean.intentBlocked : i.blocked
}

/** Finishes the park of a no-record op dir from its intent, under lock 1. Throws a stop before the park. */
export async function finishFromIntent(
  ctx: SkillWriteContext,
  cls: NoRecord,
  transcript: ReadTranscript,
  options: SwapOptions
): Promise<IntentParkResult> {
  const i = cls.intent
  if (i === null || !i.valid || blockedFor(cls, i) !== null) {
    throw new SwapFault('staging-unsafe', `${cls.opDir} has no park intent that verifies`)
  }
  const route = routeOf(cls, i)
  const st = intentState(ctx, cls, i, route, options)
  await hook(st, 'beforeMetadataCleanup')
  check(st)
  const owner = cls.entries.includes(OWNER_FILE)
    ? adoptMetadata(transcript, path.join(cls.opDir, OWNER_FILE))
    : null
  const temps: Adopted[] = cls.clean.temps.map((t) => adoptMetadata(transcript, t))
  const intent = adoptMetadata(transcript, i.path)
  const parkSet = new Map<string, BoundIdentity>(
    i.sources.map((s) => [s.name, boundOf(s.identity)])
  )
  parkSet.set(PARK_INTENT_FILE, boundOf(intent.identity))
  const seen = new Map(parkSet)
  for (const a of [...temps, ...(owner === null ? [] : [owner])]) {
    seen.set(path.basename(a.path), boundOf(a.identity))
  }
  const before = await opDiffers(st, seen)
  if (before !== null) {
    throw new SwapFault(
      before.reason === 'op-not-empty' ? 'op-not-empty' : 'staging-unsafe',
      before.detail ?? `${cls.opDir} is not as the plan saw it`
    )
  }
  for (const t of temps) await unlinkAdopted(st, t)
  if (owner !== null) {
    await unlinkAdopted(st, owner)
    await hook(st, 'afterOwnerUnlink')
  }
  if (owner !== null || temps.length > 0) await syncDir(st, cls.opDir)
  const differs = await opDiffers(st, parkSet)
  if (differs !== null) {
    st.warnings.push({ code: 'removal-not-done', path: cls.opDir, ...differs })
    return { st, extraCopy: null }
  }
  const o: ParkOpOutcome =
    route.backupPath === null
      ? await parkOpFromStaging(st, {
          caller: 'abort-cleanup',
          kind: 'abort-new',
          expected: parkSet,
          indexPath: parkIndexOf(cls.clean.attribution),
        })
      : await parkOpFromStaging(st, {
          caller: 'move-source',
          kind: 'move-source',
          backupPath: route.backupPath,
          expected: parkSet,
        })
  if (o.status === 'parked') return { st, extraCopy: o.parkedPath }
  st.warnings.push({ code: 'removal-not-done', path: cls.opDir, ...o.notDone })
  return { st, extraCopy: null }
}
