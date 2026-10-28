/**
 * SMI-6531 (A1 step 6b-i): `doctor recovery --park <opId>` under lock 1, the
 * only remedy for `recovery-record-unreadable`, which blocks every write in a
 * skills root (A1 plan §3.9, PLAN:2019; design `step6b-design.md` § 1.1).
 *
 * The re-plan under lock 1 has already reproduced the confirmed plan's digest
 * (`skill-recovery.exec.ts`), so the class here is the plan's: an `unreadable`
 * record in an op dir that was listed, owned by this user, and guardable
 * (`treeHash(OP)` was `ok`). Then:
 *
 *  1. `parkState`: a `SwapState` with no record, like `intentState` in
 *     `skill-recovery.intent-park.ts`. OP is bound with the identity the
 *     re-plan saw; the client and the parked-index path come from O1
 *     (`resolveAttribution`: a validated attribution, else client `none` and
 *     the primary state root's index, or no index line at all). Its manifest
 *     port refuses: a park never commits.
 *  2. `expected`: every entry of OP with the identity the re-plan's `lstat`
 *     saw. An entry whose `lstat` failed there cannot be bound, so it stops
 *     `staging-unsafe` before anything happens.
 *  3. `parkOpFromStaging` with caller `doctor-park`, kind
 *     `unreadable-record`: `check`, the clock gate (its probes in ST), the
 *     guard hash and bind, `opDiffers`, `check`, the park, the landing sync
 *     and ST's sync.
 *
 * Nothing is unlinked first, so no park intent is needed (the intent exists
 * for callers that unlink `owner.json` before parking, PLAN:1173-1177).
 * Nothing is removed: OP leaves ST only by the park's rename.
 *
 * Outcomes (UD32, PLAN:2019): `parked` is done (the root accepts writes
 * again, unless another unreadable record exists); `kept` or `stopped` (OP
 * stayed, including a hash failure between the check and the park, which the
 * gate reports as `bind-failed` and the port's own walk as `guard-unreadable`
 * or `guard-unsupported-type`, C13; and a mount inside OP, `kept/
 * mount-inside-tree`, C14) and `held` (OP moved but is held at its parked
 * path) are a `removal-not-done` warning, which the CLI exits 4 for.
 *
 * @module @skillsmith/core/services/skill-recovery.park-unreadable
 */
import path from 'node:path'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { parkClientOf, parkIndexOf, resolveAttribution } from './skill-recovery.attribution.js'
import type { Attribution } from './skill-recovery.attribution.js'
import { boundOf } from './skill-recovery.state.js'
import type { RecoveryClass } from './skill-recovery.types.js'
import { SwapFault } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { parkOpFromStaging } from './skill-swap.park-op.js'
import type { ManifestPort, SwapOptions } from './skill-swap.types.js'
import type { SkillWriteContext } from './skill-write-lock.types.js'

type Unreadable = Extract<RecoveryClass, { kind: 'unreadable' }>

const refusingPort: ManifestPort = {
  withManifestLock: () => {
    throw new SwapFault('write-failed', 'doctor recovery --park never commits the manifest')
  },
}

/** The state the park of an unreadable record's op dir needs (see the module comment). */
function parkState(
  ctx: SkillWriteContext,
  cls: Unreadable,
  attribution: Attribution,
  options: SwapOptions
): SwapState {
  const o = cls.observed
  if (o === null) throw new SwapFault('staging-unsafe', `${cls.opDir} was not observed`)
  const opIdentity = boundOf(o.identity)
  const stateRoot =
    attribution.kind === 'attributed' ? attribution.stateRoot : (attribution.primary ?? '')
  const dirName = attribution.kind === 'attributed' ? attribution.dirName : cls.opId
  const realDir = path.join(ctx.root, dirName)
  return {
    input: {
      skillsDir: ctx.root,
      client: parkClientOf(attribution),
      // Client, scope, state root and folder all come from the one `attribution`: O1's when it
      // validated, else the client-`none` layout's (`none`); never fields from two sources.
      scope: attribution.kind === 'attributed' ? attribution.scope : 'none',
      stateRoot,
      manifestPath: path.join(stateRoot, 'manifest.json'),
      manifestKey: dirName,
      comparedPath: realDir,
      realDir,
      dirName,
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
    moveSources: new Map(),
    owner: null,
    newIdentity: null,
    postTree: null,
    postRecord: null,
    stateRootReal: stateRoot,
    areaPath: '',
    backupDest: '',
    recordRemoved: false,
    record: null,
    owned: new Map(),
    blockedBy: null,
    phase: 'locked',
    step: 'audit',
  }
}

/** Every entry of OP with the identity the re-plan's `lstat` saw. */
function expectedOf(cls: Unreadable): Map<string, BoundIdentity> {
  const out = new Map<string, BoundIdentity>()
  for (const e of cls.observed?.entries ?? []) {
    if (!e.stat.ok) {
      throw new SwapFault(
        'staging-unsafe',
        `${path.join(cls.opDir, e.name)} could not be inspected (${e.stat.errno})`
      )
    }
    out.set(e.name, boundOf(e.stat.identity))
  }
  return out
}

export interface UnreadableParkResult {
  st: SwapState
  /** Where OP was parked; null when the park did not finish (a `removal-not-done` warning says why). */
  parkedPath: string | null
}

/**
 * `--park` under lock 1, after the re-plan matched. Throws a stop, or a hook's
 * throw, which can come after the park's rename: the caller observes whether
 * OP is still at its origin (`skill-recovery.exec.ts`, `parkStopped`).
 */
export async function parkUnreadable(
  ctx: SkillWriteContext,
  cls: Unreadable,
  stateRoots: readonly string[],
  options: SwapOptions
): Promise<UnreadableParkResult> {
  if (cls.observed === null || !cls.observed.hash.ok || cls.observed.otherUid !== null) {
    throw new SwapFault('staging-unsafe', `${cls.opDir} is not an op dir --park can guard`)
  }
  const attribution = resolveAttribution({ owner: cls.observed.owner, stateRoots })
  const st = parkState(ctx, cls, attribution, options)
  const expected = expectedOf(cls)
  const o = await parkOpFromStaging(st, {
    caller: 'doctor-park',
    kind: 'unreadable-record',
    expected,
    indexPath: parkIndexOf(attribution),
  })
  if (o.status === 'parked') return { st, parkedPath: o.parkedPath }
  st.warnings.push({ code: 'removal-not-done', path: cls.opDir, ...o.notDone })
  return { st, parkedPath: null }
}
