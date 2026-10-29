/**
 * SMI-6531 (A1 step 6b-iii): `doctor recovery --abandon <opId>` under lock 1
 * (A1 plan §3.9, PLAN:2022; design `step6b-design.md` § 1.3, O4).
 *
 * The re-plan under lock 1 has already reproduced the confirmed plan's digest
 * (`skill-recovery.exec.ts`), so the class is the plan's: a verified record
 * that no normal recovery action can act on (moved, identity-changed, AB,
 * anything else with a record, or post-keep S2′). Then:
 *
 *  1. `abandonState`, the third recorded constructor beside `recoveryState`
 *     and `newState`: OP is `ST/<opId>` (the command's argument, the op dir's
 *     own name) bound with the identity the re-plan saw, not the record's
 *     (with that, the first `check` of an `op-dir-identity` op would fail).
 *     The area is keyed by the scanned root R (`backupAreaPath` over R,
 *     PLAN:1069), and the backup's path is that area joined with the
 *     argument, never `record.backupDest` (for a moved op that is the other
 *     root's area: keeping there would make the original op classify AB). The
 *     manifest port refuses: abandon never commits. `self` is this process,
 *     `owner` null, as `recoveryState` has them.
 *  2. Adopt the metadata (`adoptAll`, `skill-recovery.adopt.ts`).
 *  3. Before **any** mutation (the backup area's `mkdir` included):
 *     `preMutationBlocks`, the same two refusals `--apply`/`--undo` run, each
 *     with nothing changed.
 *  4. For each of O, N and U still in OP: a keep that had started resumes
 *     with its own kind (`keepRole` → `resumeGroup`, PLAN:1536); any other
 *     source must still have the re-plan's identity (else `staging-unsafe`,
 *     the record kept), then `publishTree(src, 'abandoned-old|new|undone')`
 *     (each such sidecar records OP's identity, O4).
 *  5. Each orphan copy temp of this op (no sidecar) is kept as `partial-copy`,
 *     before step 4's keeps (so a fresh keep's copy temp name is free).
 *  6. The finish: on one device `finishRecovered` (the metadata, `record.json`
 *     last, `rmdir`); across devices, where each verified source stayed in OP,
 *     `finishRecoveredAcross` (the `move-source` intent, the record last, the
 *     park of OP, UD28).
 *
 * A kill anywhere resumes with the same command: before the first sidecar the
 * class is unchanged; after it the op is AB; across devices after the
 * record goes, the op dir has no record and a verifying `move-source` intent
 * naming this op dir, which `--abandon`, `--apply` and `--undo` finish (UD54).
 * Nothing is removed but metadata and the emptied op dir; T, the manifest, the
 * journal and every other op dir and backup are untouched.
 *
 * @module @skillsmith/core/services/skill-recovery.abandon
 */
import fs from 'node:fs'
import path from 'node:path'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import { adoptAll, adoptInto, listedNames, preMutationBlocks } from './skill-recovery.adopt.js'
import { finishRecovered, sweepRoot } from './skill-recovery.finish.js'
import { finishRecoveredAcross } from './skill-recovery.park.js'
import { isOrphanCopyTemp } from './skill-recovery.plan.abandon.js'
import { ROLE_DIR } from './skill-recovery.pstate.js'
import { keepRole } from './skill-recovery.resume.js'
import type { KeepContext } from './skill-recovery.resume.js'
import { refused } from './skill-recovery.run.js'
import type {
  PlannedRecovery,
  RecoveryDone,
  RecoveryRunOptions,
  RecoveryRunResult,
} from './skill-recovery.run.types.js'
import { boundOf } from './skill-recovery.state.js'
import type {
  OpFacts,
  PlanStep,
  ReadTranscript,
  RecoveryClass,
  Role,
} from './skill-recovery.types.js'
import { keepOrphanCopyTemp } from './skill-recovery.xdev.js'
import { backupAreaPath } from './skill-swap.area.js'
import { describe } from './skill-swap.abort.js'
import { opPaths, processOwnerNow, rethrowLockOrder, SwapFault } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { ensureBackupArea } from './skill-swap.publish.js'
import type { ManifestPort, RecordIdentity, SwapOptions, SwapRecord } from './skill-swap.types.js'
import type { SkillsRootBinding, SkillWriteContext } from './skill-write-lock.types.js'

/** The classes `--abandon` acts on with a record: everything but a no-record intent or an empty op dir. */
export type AbandonClass = Extract<
  RecoveryClass,
  { kind: 'moved' | 'identity-changed' | 'ab' | 'anything-else' | 'state' }
>

const refusingPort: ManifestPort = {
  withManifestLock: () => {
    throw new SwapFault('write-failed', 'doctor recovery --abandon never commits the manifest')
  },
}

export interface AbandonStateInput {
  record: SwapRecord
  /** The command's argument: the op dir's own name, which the keeps and the intent are named for. */
  opId: string
  /** OP's identity as the re-plan saw it. */
  opIdentity: RecordIdentity
  binding: SkillsRootBinding
  ctx: SkillWriteContext
  options: SwapOptions
}

/** The state `--abandon` keeps with (see the module comment, step 1). */
export function abandonState(i: AbandonStateInput): SwapState {
  const rec = i.record
  const t = rec.target
  const stateRoot = path.dirname(t.manifestPath)
  let stateRootReal: string
  try {
    stateRootReal = fs.realpathSync.native(stateRoot)
  } catch {
    stateRootReal = path.resolve(stateRoot)
  }
  const R = i.binding.root
  const opDir = path.join(i.binding.stagingDir, i.opId)
  const areaPath = backupAreaPath(stateRootReal, t.client, R, t.dirName)
  const realDir = path.join(R, t.dirName)
  return {
    input: {
      skillsDir: R,
      client: t.client,
      scope: t.scope,
      stateRoot,
      manifestPath: t.manifestPath,
      manifestKey: t.manifestKey,
      comparedPath: realDir,
      realDir,
      dirName: t.dirName,
      oldIdentity: boundOf(rec.oldIdentity),
      preTree: rec.preTree,
      writeSet: [],
      preEntry: rec.preEntry,
      postEntry: rec.postEntry,
      manifest: refusingPort,
    },
    options: i.options,
    opId: i.opId,
    binding: i.binding,
    warnings: [],
    opDir,
    ctx: i.ctx,
    opCreated: false,
    op: { path: opDir, identity: boundOf(i.opIdentity) },
    area: null,
    buildIdentity: null,
    published: null,
    moveSources: new Map(),
    owner: null,
    self: processOwnerNow(),
    newIdentity: boundOf(rec.newIdentity),
    postTree: rec.postTree,
    postRecord: null,
    stateRootReal,
    areaPath,
    // The R-keyed area joined with the argument: what `intentPrecheck` bounds and a resumed backup keep publishes to.
    backupDest: path.join(areaPath, i.opId),
    recordRemoved: false,
    record: rec,
    owned: new Map(),
    blockedBy: null,
    phase: 'locked',
    step: 'audit',
  }
}

/** The facts of an abandon class (`planAction` offered it, so the record verified). */
function factsOf(cls: AbandonClass): OpFacts {
  const f = 'facts' in cls ? cls.facts : null
  if (f === null) throw new SwapFault('staging-unsafe', `${cls.opDir} has no verified record`)
  return f
}

/** The kind the confirmed plan keeps `role` as. */
function kindIn(steps: readonly PlanStep[], role: Role): string | null {
  const s = steps.find((x) => x.tree === role)
  return s !== undefined && s.disposition.kind === 'kept' ? s.disposition.as : null
}

/**
 * Each source in `roles` that no keep has started must still be the folder the
 * plan saw (its identity), else `staging-unsafe`. Run for every role before the
 * first mutation, so a source swapped after the re-plan stops with nothing
 * changed (the orphan copy temps are kept before the roles).
 */
function assertSourcesAsPlanned(st: SwapState, f: OpFacts, roles: readonly Role[]): void {
  for (const role of roles) {
    const res = f.roles[role]
    if (res.kind !== 'source' || res.started !== null) continue
    const src = path.join(st.opDir, ROLE_DIR[role])
    const now = bindIdentity(src)
    if (!now.ok || !sameIdentity(boundOf(res.obs.identity), now)) {
      throw new SwapFault(
        'staging-unsafe',
        `${src} is not the folder the plan saw; it was not kept`
      )
    }
  }
}

/** Keeps one role still in OP as the plan says (step 4), recording where. */
async function keepOne(
  st: SwapState,
  f: OpFacts,
  role: Role,
  steps: readonly PlanStep[],
  k: KeepContext,
  out: RecoveryDone
): Promise<void> {
  const res = f.roles[role]
  const kind = kindIn(steps, role)
  if (res.kind !== 'source' || kind === null) return
  // Checked once before any mutation (`assertSourcesAsPlanned`), and again here, nearest the keep.
  assertSourcesAsPlanned(st, f, [role])
  const before = k.partials.length
  const dest = await keepRole(st, role, kind, k)
  for (const p of k.partials.slice(before))
    out.kept.push({ tree: role, kind: 'partial-copy', path: p })
  if (dest !== null) out.kept.push({ tree: role, kind, path: dest })
}

/** What `runAbandon` needs from `executeRecovery`'s prologue (lock 1 held, the re-plan matched). */
export interface AbandonRun {
  planned: PlannedRecovery
  opts: RecoveryRunOptions
  ctx: SkillWriteContext
  cls: AbandonClass
  transcript: ReadTranscript
  out: RecoveryDone
}

/** `--abandon` under lock 1 (see the module comment). Called by `executeRecovery`. */
export async function runAbandon(a: AbandonRun): Promise<RecoveryRunResult> {
  const { planned, opts, ctx, cls, transcript, out } = a
  const steps = planned.plan.steps
  let st: SwapState | null = null
  try {
    // Inside the try: a class with no verified record is a stop, not a throw.
    const f = factsOf(cls)
    const s = abandonState({
      record: f.record,
      opId: cls.opId,
      opIdentity: f.opIdentity,
      binding: ctx,
      ctx,
      options: opts.swap ?? {},
    })
    st = s
    out.warnings = s.warnings
    const k: KeepContext = { facts: f, transcript, partials: [] }
    const adopted = adoptAll(f, listedNames(transcript, f.opDir), transcript)
    adoptInto(s, transcript, adopted)
    const blocked = await preMutationBlocks(s, f, steps, adopted)
    if (blocked !== null) return refused(blocked.reason, blocked.detail, planned.opDir)
    assertSourcesAsPlanned(s, f, ['O', 'N', 'U'])
    // Orphan copy temps first: one at `.tmp-<base>` would otherwise collide with
    // the cross-device copy temp of a fresh keep named `<base>` (`taken` sees no temp).
    for (const g of f.groups.filter(isOrphanCopyTemp)) {
      if (s.area === null) await ensureBackupArea(s)
      const pending = f.groups.find((p) => p.pendingTemp === g.base)?.destPath ?? null
      const at = await keepOrphanCopyTemp(s, g, k.partials, pending)
      // A copy temp of a kind that names no role is the op's, not a role's.
      out.kept.push({ tree: g.role ?? 'OP', kind: 'partial-copy', path: at })
    }
    for (const role of ['O', 'N', 'U'] as const) await keepOne(s, f, role, steps, k, out)
    if (s.moveSources.size > 0) {
      out.extraCopy = await finishRecoveredAcross(s, adopted.files, adopted.intent)
    } else {
      await finishRecovered(s, [...adopted.files, ...(adopted.intent ? [adopted.intent] : [])])
    }
  } catch (err) {
    rethrowLockOrder(err)
    const d = describe(err)
    const done: SwapState | null = st
    return {
      status: 'stopped',
      opId: cls.opId,
      reason: d.reason,
      detail: d.detail,
      recordPath: done === null || done.recordRemoved ? null : opPaths(done).record,
      warnings: done === null ? [] : done.warnings,
    }
  }
  out.swept = await sweepRoot(ctx, planned.sweep, opts.swap?.trace)
  return out
}
