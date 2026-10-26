/**
 * SMI-6531 (A1 step 6a-i): `doctor recovery`'s read-only listing over the
 * discovered skills roots (plan §3.9).
 *
 * For each root: bind R and ST **without making ST** (`bindSkillsRootReadOnly`),
 * list the op dirs and leftover probes, classify each op dir through its own
 * `ClassifierReader`, and attach each action's plan and the digest the re-plan
 * under lock 1 compares (`digestOf(transcript, plan)`). Nothing is created,
 * written, renamed or removed: not in a skills root, not in a staging dir, not
 * in a state root.
 *
 * @module @skillsmith/core/services/skill-recovery.listing
 */
import { getJournalFilePath } from '../journal/path.js'
import { classifyOp } from './skill-recovery.classify.js'
import type { ClassifyContext } from './skill-recovery.classify.js'
import { digestOf } from './skill-recovery.digest.js'
import { listStaging } from './skill-recovery.opdir.js'
import type { ProbeFact } from './skill-recovery.opdir.js'
import { classLabel, plansFor, serializePlan } from './skill-recovery.plan.js'
import { ClassifierReader } from './skill-recovery.reader.js'
import type { ReaderOptions } from './skill-recovery.reader.js'
import type { ActionPlan, RecoveryClass } from './skill-recovery.types.js'
import { bindSkillsRootReadOnly } from './skill-write-lock.js'
import { SkillWriteStop } from './skill-write-lock.types.js'

export interface OpReport {
  opId: string
  opDir: string
  cls: RecoveryClass
  label: string
  /** Every action's plan, in the order of `RECOVERY_ACTIONS`. */
  plans: ActionPlan[]
  /** Over everything the classifier read for this op and its full plan. */
  digest: string
}

export interface RootReport {
  /** The skills root (native real path). */
  root: string
  /** `absent`: no staging dir; `present`: listed; `unsafe`: it could not be bound (see `detail`). */
  staging: 'absent' | 'present' | 'unsafe'
  detail: string | null
  ops: OpReport[]
  /** Leftover clock-gate probes (UD25), by name. */
  probes: ProbeFact[]
  /** Over what the staging listing read, probes included. */
  stagingDigest: string | null
}

export interface ListOptions {
  euid?: number
  journalFile?: string
  acceptIdentity?: boolean
  /** @internal Test seam passed to every reader. */
  reader?: ReaderOptions
}

/** Classifies one op dir with a fresh reader and digests what it read plus its plan. */
export async function reportOp(
  ctx: ClassifyContext,
  opId: string,
  readerOptions: ReaderOptions = {}
): Promise<OpReport> {
  const reader = new ClassifierReader(readerOptions)
  const cls = await classifyOp(reader, ctx, opId)
  return {
    opId,
    opDir: cls.opDir,
    cls,
    label: classLabel(cls),
    plans: plansFor(cls),
    digest: digestOf(reader.transcript(), serializePlan(cls)),
  }
}

/** The op dirs and probes of one skills root. Throws nothing for a root it cannot bind: it says so. */
export async function listRoot(root: string, options: ListOptions = {}): Promise<RootReport> {
  let binding: Awaited<ReturnType<typeof bindSkillsRootReadOnly>>
  try {
    binding = await bindSkillsRootReadOnly(root)
  } catch (err) {
    if (!(err instanceof SkillWriteStop)) throw err
    return { root, staging: 'unsafe', detail: err.detail, ops: [], probes: [], stagingDigest: null }
  }
  if (binding === null) {
    return { root, staging: 'absent', detail: null, ops: [], probes: [], stagingDigest: null }
  }
  const reader = new ClassifierReader(options.reader)
  const view = listStaging(reader, binding.stagingDir)
  if (!view.ok) {
    return {
      root: binding.root,
      staging: 'unsafe',
      detail: `${binding.stagingDir} could not be listed (${view.errno})`,
      ops: [],
      probes: [],
      stagingDigest: null,
    }
  }
  const ctx: ClassifyContext = {
    root: binding.root,
    stagingDir: binding.stagingDir,
    euid: options.euid ?? process.geteuid?.() ?? -1,
    journalFile: options.journalFile ?? getJournalFilePath(),
    ...(options.acceptIdentity === undefined ? {} : { acceptIdentity: options.acceptIdentity }),
  }
  const ops: OpReport[] = []
  for (const opId of view.opIds) ops.push(await reportOp(ctx, opId, options.reader))
  return {
    root: binding.root,
    staging: 'present',
    detail: null,
    ops,
    probes: view.probes,
    stagingDigest: digestOf(reader.transcript(), { probes: view.probes.map((p) => p.name) }),
  }
}

/** `listRoot` for every root, in the order given. */
export async function listRecovery(
  roots: readonly string[],
  options: ListOptions = {}
): Promise<RootReport[]> {
  const reports: RootReport[] = []
  for (const root of roots) reports.push(await listRoot(root, options))
  return reports
}
