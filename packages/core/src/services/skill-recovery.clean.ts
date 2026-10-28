/**
 * SMI-6531 (A1 step 6b-ii): `doctor recovery --clean-staging <opId>` under
 * lock 1, for an op dir with no `record.json` (A1 plan §3.9, PLAN:2018;
 * design `step6b-design.md` § 1.2).
 *
 * The re-plan under lock 1 has already reproduced the confirmed plan's digest
 * (`skill-recovery.exec.ts`), so the class here is the plan's, owner verdict
 * included. Then:
 *
 *  - **(a) a verifying intent**: its park is finished as it says
 *    (`finishFromIntent`, `skill-recovery.intent-park.ts`).
 *  - **(b) no intent**:
 *    1. `noRecordState`: a `SwapState` with no record. Its area and sidecar
 *       fields come from O1 (`keepAreaOf`, `keepSidecarOf`: a validated
 *       attribution, else the client-`none` layout); OP is bound with the
 *       identity the re-plan saw. Its manifest port refuses: nothing commits.
 *    2. Adopt `owner.json` and the provable temps from the re-plan's transcript.
 *    3. `spaceBlock`: a cross-device copy that cannot fit refuses
 *       `state-root-full` with nothing changed.
 *    4. `new/`: a keep abort cleanup started resumes with its own kind
 *       (`keepRole` → `resumeGroup`); otherwise `lstat(new)` must still have
 *       the re-plan's identity (else `staging-unsafe`), then `publishTree(new,
 *       'unrecorded-new')`. A verified keep is already done.
 *    5. One device: `finishNoRecord` (temps, sync, `owner.json` last, sync,
 *       `rmdir`, sync ST). Across devices (the verified `new/` stays in OP,
 *       UD28): OP holds exactly the source and the adopted metadata; a
 *       provable `park-intent.json.tmp` is unlinked; the park intent
 *       (`move-source`, `backupPath` the kept copy) is written durably; the
 *       other temps, then `owner.json`, are unlinked and OP synced; OP holds
 *       exactly the source and the intent; then the park of OP. A kill after
 *       the intent is durable leaves case (a), which the same command finishes.
 *
 * Nothing is removed but metadata and the emptied op dir; every tree is kept
 * through `publishTree` or parked. A park that does not finish is a
 * `removal-not-done` warning (exit 4, UD32).
 *
 * @module @skillsmith/core/services/skill-recovery.clean
 */
import path from 'node:path'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { keepSidecarOf, routeRootOf } from './skill-recovery.attribution.js'
import { finishNoRecord } from './skill-recovery.finish.js'
import { finishFromIntent } from './skill-recovery.intent-park.js'
import { spaceBlock } from './skill-recovery.mark.js'
import { keepRole } from './skill-recovery.resume.js'
import type { KeepContext } from './skill-recovery.resume.js'
import { adoptSidecarsInto } from './skill-recovery.run.js'
import { adoptMetadata, boundOf, unlinkAdopted } from './skill-recovery.state.js'
import type { Adopted } from './skill-recovery.state.js'
import type {
  PlanStep,
  ReadTranscript,
  RecoveryClass,
  TreePosition,
} from './skill-recovery.types.js'
import { writeParkIntent } from './skill-swap.intent.js'
import { check, hook, opPaths, SwapFault, syncDir } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { opDiffers, parkOpFromStaging } from './skill-swap.park-op.js'
import { OWNER_FILE, PARK_INTENT_FILE } from './skill-swap.types.js'
import type { ManifestPort, SwapOptions } from './skill-swap.types.js'
import type { SkillWriteContext } from './skill-write-lock.types.js'

type NoRecord = Extract<RecoveryClass, { kind: 'no-record' }>

const refusingPort: ManifestPort = {
  withManifestLock: () => {
    throw new SwapFault(
      'write-failed',
      'doctor recovery --clean-staging never commits the manifest'
    )
  },
}

/** The state a keep of a no-record op dir needs (see the module comment). */
function noRecordState(ctx: SkillWriteContext, cls: NoRecord, options: SwapOptions): SwapState {
  const c = cls.clean
  if (c.area === null) throw new SwapFault('staging-unsafe', 'no state root to keep into')
  const side = keepSidecarOf(c.attribution, cls.opId)
  const stateRoot = routeRootOf(c.attribution) ?? ''
  const opIdentity = boundOf(c.opIdentity)
  const realDir = path.join(ctx.root, side.dirName)
  return {
    input: {
      skillsDir: ctx.root,
      client: side.client,
      scope: side.scope,
      stateRoot,
      manifestPath: path.join(stateRoot, 'manifest.json'),
      manifestKey: side.manifestKey,
      comparedPath: realDir,
      realDir,
      dirName: side.dirName,
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
    areaPath: c.area,
    backupDest: path.join(c.area, cls.opId),
    recordRemoved: true,
    record: null,
    owned: new Map(),
    blockedBy: null,
    phase: 'locked',
    step: 'audit',
  }
}

interface CleanResult {
  st: SwapState
  kept: Array<{ tree: TreePosition; kind: string; path: string }>
  /** Across devices, where the op dir (holding the verified source) was parked. */
  extraCopy: string | null
  /** `state-root-full`: a copy would not fit; nothing changed. */
  full: string | null
}

/** What the run needs from `executeRecovery`'s prologue (lock 1 held, the re-plan matched). */
interface CleanRun {
  ctx: SkillWriteContext
  cls: NoRecord
  transcript: ReadTranscript
  steps: readonly PlanStep[]
  options: SwapOptions
}

/** `--clean-staging` under lock 1 (see the module comment). Throws a stop. */
export async function cleanStaging(a: CleanRun): Promise<CleanResult> {
  const { ctx, cls, transcript } = a
  if (cls.intent !== null) {
    // (a): the intent wins (C2); its park is finished as it says.
    const r = await finishFromIntent(ctx, cls, transcript, a.options)
    const kept =
      cls.intent.kind === 'abort-new' && r.extraCopy !== null
        ? [{ tree: 'OP' as const, kind: 'abort-new', path: r.extraCopy }]
        : []
    return {
      st: r.st,
      kept,
      extraCopy: cls.intent.kind === 'abort-new' ? null : r.extraCopy,
      full: null,
    }
  }
  const c = cls.clean
  const st = noRecordState(ctx, cls, a.options)
  adoptSidecarsInto(st, transcript)
  const adopted: Adopted[] = [
    ...c.temps.map((t) => adoptMetadata(transcript, t)),
    ...(cls.entries.includes(OWNER_FILE)
      ? [adoptMetadata(transcript, path.join(cls.opDir, OWNER_FILE))]
      : []),
  ]
  const k: KeepContext = {
    facts: {
      roles: { O: { kind: 'absent' }, N: c.n, U: { kind: 'absent' } },
      groups: c.groups,
      fullDevice: null,
    },
    transcript,
    partials: [],
  }
  const full = await spaceBlock(st, k.facts, a.steps)
  if (full !== null) return { st, kept: [], extraCopy: null, full }
  const out: CleanResult = { st, kept: [], extraCopy: null, full: null }
  if (c.n.kind === 'source') {
    const newDir = opPaths(st).newDir
    if (c.n.started === null) {
      const now = bindIdentity(newDir)
      if (!now.ok || !sameIdentity(boundOf(c.n.obs.identity), now)) {
        throw new SwapFault(
          'staging-unsafe',
          `${newDir} is not the folder the plan saw; nothing was kept`
        )
      }
    }
    const kind = c.n.started?.kind ?? 'unrecorded-new'
    const dest = await keepRole(st, 'N', kind, k)
    for (const p of k.partials) out.kept.push({ tree: 'N', kind: 'partial-copy', path: p })
    if (dest !== null) out.kept.push({ tree: 'N', kind, path: dest })
  }
  if (st.moveSources.size > 0) out.extraCopy = await finishAcross(st, adopted)
  else await finishNoRecord(st, adopted)
  return out
}

/** The sources in OP, by name, as bound when each was verified. */
const sourcesOf = (st: SwapState): Map<string, BoundIdentity> =>
  new Map([...st.moveSources].map(([n, s]) => [n, s.identity]))

/** The cross-device finish of a no-record op dir (see the module comment). */
async function finishAcross(st: SwapState, adopted: readonly Adopted[]): Promise<string | null> {
  await hook(st, 'beforeMetadataCleanup')
  check(st)
  const expected = sourcesOf(st)
  for (const a of adopted) expected.set(path.basename(a.path), boundOf(a.identity))
  const before = await opDiffers(st, expected)
  if (before !== null) {
    throw new SwapFault(
      before.reason === 'op-not-empty' ? 'op-not-empty' : 'staging-unsafe',
      before.detail ?? `${st.opDir} is not as the plan saw it`
    )
  }
  const intentTmp = adopted.find((x) => path.basename(x.path) === `${PARK_INTENT_FILE}.tmp`)
  if (intentTmp !== undefined) {
    await unlinkAdopted(st, intentTmp)
    await syncDir(st, st.opDir)
  }
  const backupPath = [...st.moveSources.values()][0]!.dest
  await writeParkIntent(st, 'move-source', backupPath)
  const intentId = st.owned.get(opPaths(st).intent)
  if (intentId === undefined)
    throw new SwapFault('staging-unsafe', 'the park needs its intent bound')
  const owner = adopted.find((x) => path.basename(x.path) === OWNER_FILE)
  for (const x of adopted) {
    if (x === intentTmp || x === owner) continue
    await unlinkAdopted(st, x)
  }
  if (owner !== undefined) {
    await unlinkAdopted(st, owner)
    await hook(st, 'afterOwnerUnlink')
  }
  await syncDir(st, st.opDir)
  const parkSet = sourcesOf(st).set(PARK_INTENT_FILE, intentId)
  const differs = await opDiffers(st, parkSet)
  if (differs !== null) {
    st.warnings.push({ code: 'removal-not-done', path: st.opDir, ...differs })
    return null
  }
  const o = await parkOpFromStaging(st, {
    caller: 'move-source',
    kind: 'move-source',
    backupPath,
    expected: parkSet,
  })
  if (o.status === 'parked') return o.parkedPath
  st.warnings.push({ code: 'removal-not-done', path: st.opDir, ...o.notDone })
  return null
}
