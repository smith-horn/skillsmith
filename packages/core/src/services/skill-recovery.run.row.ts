/**
 * SMI-6531 (A1 step 8-i-a-2): what a row's `--apply` / `--undo` shares, for
 * an update's rows (`skill-recovery.run.ts`) and a fresh install's
 * (`skill-recovery.run.install.ts`): the row's context, the keep of a role as
 * the confirmed plan says, the commit when it is the first mutation, the claim
 * the re-plan saw, and what a tree must still be when `installAt` publishes it.
 *
 * @module @skillsmith/core/services/skill-recovery.run.row
 */
import { keepRole } from './skill-recovery.resume.js'
import type { KeepContext, SourceExpect } from './skill-recovery.resume.js'
import type { RecoveryDone, RecoveryRunOptions } from './skill-recovery.run.types.js'
import type { OpFacts, PlanStep, RecoveryClass, Role } from './skill-recovery.types.js'
import { commit } from './skill-swap.commit.js'
import { hook, SwapFault } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'

export type RowClass = Extract<RecoveryClass, { kind: 'state' }>

/** A row being run: its state, class, confirmed steps, keep context and result. */
export interface Row {
  st: SwapState
  cls: RowClass
  steps: readonly PlanStep[]
  k: KeepContext
  out: RecoveryDone
  opts: RecoveryRunOptions
  journalFile: string
}

/** The kind the confirmed plan keeps `tree` as. */
export function kindIn(steps: readonly PlanStep[], tree: PlanStep['tree']): string | null {
  const s = steps.find((x) => x.tree === tree)
  return s !== undefined && s.disposition.kind === 'kept' ? s.disposition.as : null
}

/** Keeps `tree` (a role) as the plan says, recording where. */
export async function keep(row: Row, tree: Role): Promise<void> {
  const kind = kindIn(row.steps, tree) ?? (tree === 'O' ? 'backup' : null)
  if (kind === null) return
  const before = row.k.partials.length
  const dest = await keepRole(row.st, tree, kind, row.k)
  // A cross-device resume keeps a copy temp that was not the source (P2) before it copies again.
  for (const p of row.k.partials.slice(before)) {
    row.out.kept.push({ tree, kind: 'partial-copy', path: p })
  }
  if (dest === null) return
  row.out.kept.push({ tree, kind, path: dest })
  if (kind === 'conflict') row.st.warnings.push({ code: 'conflict-kept', path: dest })
}

/** The commit when nothing has moved yet: a CAS miss is the plan having changed. */
export async function commitFirst(row: Row): Promise<'plan-changed' | null> {
  if ((await commit(row.st)) === 'cas-failed') return 'plan-changed'
  row.out.manifest = 'committed'
  await hook(row.st, 'afterCommit')
  return null
}

/** The claim at T the re-plan saw, when T is one. */
export const claimOf = (f: OpFacts) => (f.tState === 'claim' && f.t.present ? f.t.identity : null)

/**
 * What `role`'s source must still be when `installAt` publishes it: the
 * identity this run checks it by (the record's, or the accepted one) and the
 * tree hash the confirmed plan observed for it. Equal to the recorded hash
 * wherever the plan installs a tree it checked against the record (S1 and
 * FI0/FI1 `--apply` refuse otherwise); an old folder the user edited before
 * the plan is put back as the plan showed it, not refused.
 */
export function expectOf(st: SwapState, f: OpFacts, role: 'O' | 'N'): SourceExpect {
  const res = f.roles[role]
  if (res.kind !== 'source') {
    throw new SwapFault('staging-unsafe', `${role} is not a folder in the op dir to install`)
  }
  const identity = role === 'O' ? st.input.oldIdentity : st.newIdentity
  if (identity === null) throw new SwapFault('staging-unsafe', 'the new folder has no identity')
  return { identity, hash: res.obs.hash }
}
