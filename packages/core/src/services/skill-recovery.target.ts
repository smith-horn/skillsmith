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
  for (const root of roots) {
    const r = await listRoot(root, {
      ...(request.euid === undefined ? {} : { euid: request.euid }),
      ...(request.journalFile === undefined ? {} : { journalFile: request.journalFile }),
      ...(request.acceptIdentity === undefined ? {} : { acceptIdentity: request.acceptIdentity }),
      ...(request.reader === undefined ? {} : { reader: request.reader }),
      stateRoots: request.stateRoots ?? [],
    })
    for (const op of r.ops) if (op.opId === request.opId) found.push({ root: r, op })
  }
  if (found.length === 0) {
    const parked = parkedLanding(request.opId, roots)
    if (parked !== null) {
      return refusal(
        'already-parked',
        `${request.opId} has no op dir, and ${parked} exists: it was already set aside, ` +
          'so there is nothing left to do. Doctor took no action and did not verify that copy',
        [parked]
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

/**
 * 6a-iii (owner decision 2026-10-27, report only): the first root whose
 * `ST/.skillsmith-parked/<opId>` is a directory (not followed), or null. Doctor
 * says the op was already set aside and acts on nothing, so nothing here is
 * authenticated: a forged directory reads the same as a real park.
 */
function parkedLanding(opId: string, roots: readonly string[]): string | null {
  for (const r of roots) {
    const landing = path.join(realOf(r), '.skillsmith-staging', '.skillsmith-parked', opId)
    try {
      if (fs.lstatSync(landing).isDirectory()) return landing
    } catch {
      continue
    }
  }
  return null
}
