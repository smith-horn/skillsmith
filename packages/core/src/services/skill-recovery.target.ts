/**
 * SMI-6531 (A1 step 6a-ii): the lock-free half of `doctor recovery --apply
 * <opId>` / `--undo <opId>`: targeting and the plan shown before the prompt
 * (A1 plan §3.9 "Targeting", confirmation contract item 1).
 *
 * `planRecovery(request)` lists each discovered root read-only (no lock, no
 * write: `listRoot`), finds every op dir named `opId`, and:
 *  - none: `recovery-not-offered` ("no operation directory named it"), except:
 *    a parked area `ST/.skillsmith-parked/<opId>` in a root is `already-parked`
 *    (report only: nothing is acted on, the CLI exits 0), unless a scanned root's
 *    staging is unsafe (unreadable): that root may hold the op, so it is
 *    `recovery-ambiguous`, naming the unsafe roots and the parked paths;
 *  - an op dir in one root and a parked copy in another: `recovery-ambiguous`;
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
  if (!opIdOk(request.opId)) {
    return refusal(
      'recovery-not-offered',
      `${JSON.stringify(request.opId)} is not an operation id (one path component)`
    )
  }
  const wanted = request.root === undefined ? null : realOf(request.root)
  const roots = request.roots.filter((r) => wanted === null || realOf(r) === wanted)
  if (wanted !== null && roots.length === 0) {
    return refusal(
      'recovery-not-offered',
      `--root ${request.root} is not a skills root doctor scans`
    )
  }
  const found: Array<{ root: RootReport; op: RootReport['ops'][number] }> = []
  const reports: RootReport[] = []
  for (const root of roots) {
    const r = await listRoot(root, {
      ...(request.euid === undefined ? {} : { euid: request.euid }),
      ...(request.journalFile === undefined ? {} : { journalFile: request.journalFile }),
      ...(request.acceptIdentity === undefined ? {} : { acceptIdentity: request.acceptIdentity }),
      ...(request.reader === undefined ? {} : { reader: request.reader }),
      stateRoots: request.stateRoots ?? [],
    })
    reports.push(r)
    for (const op of r.ops) if (op.opId === request.opId) found.push({ root: r, op })
  }
  // The listing hides a parked copy in a root that also holds the op dir, so
  // every hit here is in a root with no op dir of this opId.
  const parked = reports.flatMap((r) => r.parked.filter((p) => p.opId === request.opId))
  const where = parked.map((h) => h.path)
  if (found.length > 0 && parked.length > 0) {
    return refusal(
      'recovery-ambiguous',
      `${request.opId} names an operation directory and a copy already set aside in another ` +
        'root; pick one with --root <skills root>',
      [...found.map((x) => x.op.opDir), ...where]
    )
  }
  if (found.length === 0) {
    const unsafe = reports.filter((r) => r.staging === 'unsafe')
    if (parked.length > 0 && unsafe.length > 0) {
      // A root whose staging could not be read may hold this very op dir, so
      // "already set aside" cannot be concluded from the other roots.
      return refusal(
        'recovery-ambiguous',
        `${request.opId} has no op dir in the roots that could be read, and ${where.join(', ')} ` +
          `${where.length === 1 ? 'exists' : 'exist'}, but ${unsafe.map((r) => r.root).join(', ')} ` +
          (unsafe.length === 1
            ? 'could not be read (its staging is unsafe), so it may hold the operation: ' +
              'fix that root, or pick one with --root <skills root>'
            : 'could not be read (their staging is unsafe), so they may hold the operation: ' +
              'fix those roots, or pick one with --root <skills root>'),
        [...unsafe.map((r) => r.root), ...where]
      )
    }
    if (parked.length > 0) {
      return refusal(
        'already-parked',
        `${request.opId} has no op dir, and ${where.join(', ')} ` +
          `${where.length === 1 ? 'exists' : 'exist'}: it was already set aside. ` +
          'Doctor takes no action: it neither verifies nor syncs that copy',
        where
      )
    }
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
    }
    return planned
  }
  const plan = planAction(op.cls, request.action)
  if (!plan.offered) return refusal(plan.reason, plan.detail, [op.opDir])
  return { ...base, plan, emptyTarget: null }
}

/** The opId is one path component (governance S2): checked before any path is joined or read. */
function opIdOk(opId: string): boolean {
  return (
    opId !== '' &&
    opId !== '.' &&
    opId !== '..' &&
    !opId.includes('/') &&
    !opId.includes('\\') &&
    !opId.includes('\0') &&
    path.basename(opId) === opId
  )
}
