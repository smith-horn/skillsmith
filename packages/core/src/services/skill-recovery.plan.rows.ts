/**
 * SMI-6531 (A1 step 8-i-a-2): what the plans of an update's rows
 * (`skill-recovery.plan.ts`) and a fresh install's rows
 * (`skill-recovery.plan.install.ts`) both state: the kind a staged or
 * set-aside tree is kept as, the keeps a crashed run left to resume, and the
 * offer of a row with its finish (`skill-recovery.plan.finish.ts`).
 *
 * Pure: no filesystem access.
 *
 * @module @skillsmith/core/services/skill-recovery.plan.rows
 */
import { offer } from './skill-recovery.plan.actions.js'
import { finishLines, keepsSource } from './skill-recovery.plan.finish.js'
import { pendingOf } from './skill-recovery.pending.js'
import type {
  ActionPlan,
  ManifestEffect,
  OpFacts,
  PlanStep,
  RecoveryAction,
} from './skill-recovery.types.js'

/** The kind a staged or set-aside tree is kept as: a started keep's own kind, else by its hash. */
export function keptKindOf(
  role: 'N' | 'U',
  f: OpFacts,
  matches: 'unused-new' | 'undone',
  differs: 'edited-new' | 'conflict'
): string {
  const res = f.roles[role]
  if (res.kind === 'kept') return res.keep.kind
  if (res.kind === 'source' && res.started !== null) return res.started.kind
  // A staged tree that cannot be hashed is kept as `unrecorded-new` (PLAN:1400-1402).
  if (res.kind === 'source' && role === 'N' && res.obs.hash === null) return 'unrecorded-new'
  if (res.kind === 'source') return res.obs.hash === f.record.postTree ? matches : differs
  return differs
}

/** What is left of any keep that began: resumed from its sub-state before anything else. */
export function resumes(f: OpFacts): string[] {
  return f.groups
    .filter((g) => g.state !== null && g.state !== 'P5')
    .map((g) => {
      const pending = pendingOf(f, g)
      const tail =
        pending === null ? '' : `, finishing its copy temp's partial-copy keep as ${pending}`
      return `resume the keep of ${g.base} from ${g.state}${tail}`
    })
}

/** `offer` for a row: what is left, then the finish its executor takes (`skill-recovery.plan.finish.ts`). */
export function rowOffer(
  f: OpFacts,
  action: RecoveryAction,
  steps: PlanStep[],
  manifest: ManifestEffect,
  before: string[],
  notes: string[] = []
): ActionPlan {
  return offer(
    action,
    steps,
    manifest,
    [...before, ...finishLines(f, keepsSource(f, steps))],
    notes
  )
}
