/**
 * SMI-6531 (A1 step 6a-ii): the lock-free half of `doctor recovery --apply
 * <opId>` / `--undo <opId>`: targeting and the plan shown before the prompt
 * (A1 plan §3.9 "Targeting", confirmation contract item 1).
 *
 * `planRecovery(request)` lists each discovered root read-only (no lock, no
 * write: `listRoot`), finds every op dir named `opId`, and:
 *  - none: `recovery-not-offered` ("no operation directory named it");
 *  - more than one (a copied root, E29 6b): `recovery-ambiguous`, naming each,
 *    unless `--root` narrows the search to one root, compared by native real
 *    path, so any spelling of a root selects it and only it;
 *  - one: `planAction(cls, action)`. Its refusals stand, the other-user one
 *    first (Q8: before any lock is requested). Since 6a-iii a plan across
 *    devices, or with a full-device marker, is offered like any other: its
 *    keeps copy and verify, and the finish parks the op dir (UD28).
 *
 * The plan carries the op's digest (`digestOf(transcript, plan)`), which the
 * re-plan under lock 1 must reproduce, and the sweep's candidates: the
 * leftover probes and other empty op dirs this listing saw, by identity.
 *
 * @module @skillsmith/core/services/skill-recovery.target
 */
import fs from 'node:fs'
import path from 'node:path'
import { listRoot } from './skill-recovery.listing.js'
import type { RootReport } from './skill-recovery.listing.js'
import type { ActionPlan, RecoveryRefuseReason } from './skill-recovery.types.js'
import type { SweepEntry } from './skill-recovery.finish.js'
import type {
  PlannedRecovery,
  RecoveryPlanResult,
  RecoveryRefusal,
  RecoveryRequest,
} from './skill-recovery.run.types.js'
import { planAction } from './skill-recovery.plan.js'
import type { RecordIdentity } from './skill-swap.types.js'

const refusal = (
  reason: RecoveryRefuseReason,
  detail: string,
  paths: string[] = []
): RecoveryRefusal => ({ status: 'refused', reason, detail, paths })

/** The native real path of `p`, or its resolved spelling when it has none. */
function realOf(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/** The bigint `lstat` identity of `p` in the record's string form, or null. */
function identityAt(p: string): RecordIdentity | null {
  try {
    const s = fs.lstatSync(p, { bigint: true })
    return {
      dev: s.dev.toString(),
      ino: s.ino.toString(),
      birthtimeNs: s.birthtimeNs.toString(),
      fmt: (s.mode & 0o170000n).toString(),
    }
  } catch {
    return null
  }
}

/** The leftover probes and other empty op dirs of `r`, by the identity seen now. */
function sweepOf(r: RootReport, target: string): SweepEntry[] {
  const out: SweepEntry[] = []
  for (const p of r.probes) {
    if (p.type === 'dir' && p.identity !== null) out.push({ path: p.path, identity: p.identity })
  }
  for (const op of r.ops) {
    if (op.cls.kind !== 'empty-op-dir' || op.opId === target) continue
    const id = identityAt(op.opDir)
    if (id !== null) out.push({ path: op.opDir, identity: id })
  }
  return out
}

/** The plan offered for an empty target: the op dir goes, nothing else changes. */
function emptyPlan(action: 'apply' | 'undo'): Extract<ActionPlan, { offered: true }> {
  return {
    offered: true,
    action,
    steps: [],
    manifest: 'untouched',
    remaining: ['rmdir the empty op dir and sync the staging dir'],
    notes: ['every tree of this operation is already installed or kept'],
  }
}

/** Targets `request.opId` across the roots and returns the plan, or why it is not offered. */
export async function planRecovery(request: RecoveryRequest): Promise<RecoveryPlanResult> {
  const wanted = request.root === undefined ? null : realOf(request.root)
  const roots = request.roots.filter((r) => wanted === null || realOf(r) === wanted)
  if (wanted !== null && roots.length === 0) {
    return refusal(
      'recovery-not-offered',
      `--root ${request.root} is not a skills root doctor scans`
    )
  }
  const found: Array<{ root: RootReport; op: RootReport['ops'][number] }> = []
  for (const root of roots) {
    const r = await listRoot(root, {
      ...(request.euid === undefined ? {} : { euid: request.euid }),
      ...(request.journalFile === undefined ? {} : { journalFile: request.journalFile }),
      ...(request.acceptIdentity === undefined ? {} : { acceptIdentity: request.acceptIdentity }),
      ...(request.reader === undefined ? {} : { reader: request.reader }),
    })
    for (const op of r.ops) if (op.opId === request.opId) found.push({ root: r, op })
  }
  if (found.length === 0) {
    const parked = parkedTarget(request, roots)
    if (parked !== null) return parked
    return refusal(
      'recovery-not-offered',
      `no operation directory named ${request.opId} is in the scanned skills roots`
    )
  }
  if (found.length > 1) {
    return refusal(
      'recovery-ambiguous',
      `${request.opId} names ${found.length} operation directories; pick one with --root <skills root>`,
      found.map((x) => x.op.opDir)
    )
  }
  const { root, op } = found[0]!
  const base = {
    status: 'planned' as const,
    request,
    root: root.root,
    opDir: op.opDir,
    report: op,
    sweep: sweepOf(root, request.opId),
  }
  if (op.cls.kind === 'empty-op-dir') {
    const id = identityAt(op.opDir)
    if (id === null) return refusal('plan-changed', `${op.opDir} is gone`, [op.opDir])
    const planned: PlannedRecovery = {
      ...base,
      plan: emptyPlan(request.action),
      emptyTarget: { path: op.opDir, identity: id },
      parked: null,
    }
    return planned
  }
  const plan = planAction(op.cls, request.action)
  if (!plan.offered) return refusal(plan.reason, plan.detail, [op.opDir])
  return { ...base, plan, emptyTarget: null, parked: null }
}

/**
 * 6a-iii: no op dir is named `opId`, but exactly one root holds its parked
 * area `ST/.skillsmith-parked/<opId>` (a kill after the park moved OP): the
 * plan is to make that park durable. Another user's area is refused.
 */
function parkedTarget(
  request: RecoveryRequest,
  roots: readonly string[]
): RecoveryPlanResult | null {
  const hits: Array<{ root: string; landing: string; identity: RecordIdentity; uid: number }> = []
  for (const r of roots) {
    const root = realOf(r)
    const landing = path.join(root, '.skillsmith-staging', '.skillsmith-parked', request.opId)
    let s: fs.BigIntStats
    try {
      s = fs.lstatSync(landing, { bigint: true })
    } catch {
      continue
    }
    const identity = identityAt(landing)
    if (s.isDirectory() && identity !== null) {
      hits.push({ root, landing, identity, uid: Number(s.uid) })
    }
  }
  if (hits.length !== 1) return null
  const h = hits[0]!
  const euid = request.euid ?? process.geteuid?.() ?? -1
  if (h.uid !== euid) {
    return refusal(
      'recovery-other-user',
      `${h.landing} belongs to uid ${h.uid}, not this user: run doctor as that user`,
      [h.landing]
    )
  }
  const copies = fs
    .readdirSync(h.landing)
    .filter((n) => !n.endsWith('.json'))
    .sort()
    .map((n) => path.join(h.landing, n))
  return {
    status: 'planned',
    request,
    root: h.root,
    opDir: h.landing,
    report: {
      opId: request.opId,
      opDir: h.landing,
      cls: { kind: 'empty-op-dir', opId: request.opId, opDir: h.landing },
      label: 'already parked',
      plans: [],
      digest: '',
    },
    plan: {
      offered: true,
      action: request.action,
      steps: [],
      manifest: 'untouched',
      remaining: [`sync ${h.landing}, then the staging dir, so the park is durable`],
      notes: ['the op dir was already set aside whole; nothing else is left to do'],
    },
    sweep: [],
    emptyTarget: null,
    parked: { landing: h.landing, identity: h.identity, copies },
  }
}
