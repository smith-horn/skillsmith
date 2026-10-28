/**
 * SMI-6531 (A1 step 6b-i): the plan table's building blocks and the words for
 * the three 6b actions, `--abandon`, `--clean-staging` and `--park` (A1 plan
 * §3.9; design `step6b-design.md` § 1, § 5), moved out of
 * `skill-recovery.plan.ts`, which keeps `--apply` and `--undo`.
 *
 * Pure, like the rest of the table: no row removes a tree, and the
 * `Disposition` type has no case for it (UD13).
 *
 * `--park` (6b-i) is offered for class `unreadable` only when all three hold
 * (owner decision on bf-1k0 Major 1):
 *  - OP was `lstat`ed as a directory and listed, so the record file itself
 *    failed (C3: an op dir whose own `lstat` or listing failed is refused);
 *  - OP's `lstat` uid is the effective uid (O3b: else `recovery-other-user`);
 *  - OP is guardable: `treeHash(OP)`, the park guard's own walk and hash, is
 *    `ok`. Otherwise it refuses with zero mutation, naming the walk's failure,
 *    its path and errno, and saying to fix the device or move the op dir out
 *    of `.skillsmith-staging/` by hand (O2's shape). There is no unverified
 *    park. An entry whose own `lstat` failed is refused the same way, naming
 *    it and its errno: the park binds every entry's identity (UD40).
 *
 * `--clean-staging` (6b-ii) is planned in `skill-recovery.plan.clean.ts`.
 * `--abandon` keeps 6a's words here until 6b-iii; `planRecovery` does not
 * perform it yet (`PERFORMED`).
 *
 * @module @skillsmith/core/services/skill-recovery.plan.actions
 */
import path from 'node:path'
import type {
  ActionPlan,
  Disposition,
  PlanStep,
  RecoveryAction,
  RecoveryClass,
  RecoveryRefuseReason,
} from './skill-recovery.types.js'

export const kept = (as: string): Disposition => ({ kind: 'kept', as })
export const INSTALLED: Disposition = { kind: 'installed' }
export const UNTOUCHED: Disposition = { kind: 'untouched' }

export const refuse = (
  action: RecoveryAction,
  reason: RecoveryRefuseReason,
  detail: string
): ActionPlan => ({ offered: false, action, reason, detail })

export const offer = (
  action: RecoveryAction,
  steps: PlanStep[],
  manifest: 'untouched' | 'committed-to-post',
  remaining: string[],
  notes: string[] = []
): ActionPlan => ({ offered: true, action, steps, manifest, remaining, notes })

export const step = (tree: PlanStep['tree'], disposition: Disposition, note: string): PlanStep => ({
  tree,
  disposition,
  note,
})

export const FINISH = 'unlink the metadata files, then rmdir the op dir and sync the staging dir'

/** The actions `planRecovery` performs today; the others are planned but refused before the prompt. */
export const PERFORMED: ReadonlySet<RecoveryAction> = new Set<RecoveryAction>([
  'apply',
  'undo',
  'park',
  'clean-staging',
])

type Unreadable = Extract<RecoveryClass, { kind: 'unreadable' }>

/** The park guard's own words for a walk failure (`treeHashOf` reports `unsupported-entry`/`unreadable`). */
export const GUARD_WORD: Readonly<Record<string, string>> = {
  'unsupported-entry': 'guard-unsupported-type',
  unreadable: 'guard-unreadable',
}

const AT_HAND =
  'fix the device, or move the op dir out of .skillsmith-staging/ by hand, and run the command again'

/** `--park` for an unreadable record (see the module comment). */
export function parkPlan(cls: Unreadable): ActionPlan {
  const o = cls.observed
  if (o === null) {
    return refuse(
      'park',
      'recovery-not-offered',
      `${cls.detail ?? 'the op dir cannot be read'}${cls.errno === undefined ? '' : ` (${cls.errno})`}: ` +
        `the op dir itself could not be read, so there is nothing to guard; ${AT_HAND}`
    )
  }
  if (o.otherUid !== null) {
    return refuse(
      'park',
      'recovery-other-user',
      `the op dir belongs to uid ${o.uid}, not this user: run doctor as that user`
    )
  }
  const h = o.hash
  if (!h.ok) {
    return refuse(
      'park',
      'recovery-not-offered',
      `the op dir cannot be guarded: its guard walk failed (${GUARD_WORD[h.reason] ?? h.reason}) at ` +
        `${h.path}${h.errno === null ? '' : ` (${h.errno})`}, so it is not set aside unverified; ${AT_HAND}`
    )
  }
  // The park binds every entry's identity (UD40): one whose lstat failed cannot be bound.
  const unbound = o.entries.find((e) => !e.stat.ok)
  if (unbound !== undefined && !unbound.stat.ok) {
    return refuse(
      'park',
      'recovery-not-offered',
      `the op dir cannot be guarded: ${path.join(cls.opDir, unbound.name)} could not be inspected ` +
        `(${unbound.stat.errno}), so it is not set aside unverified; ${AT_HAND}`
    )
  }
  const ST = path.dirname(cls.opDir)
  const where = path.join(ST, '.skillsmith-parked', cls.opId, `${cls.opId}-<rnd>`)
  const listed = o.entries.map((e) => `${e.name} (${e.stat.ok ? e.stat.type : e.stat.errno})`)
  return offer(
    'park',
    [step('OP', kept('unreadable-record'), `the whole op dir is set aside at ${where}/`)],
    'untouched',
    ['park the whole op dir, checked against a fresh hash of its contents'],
    [
      `the op dir holds ${listed.join(', ')}: ${h.bytes} bytes of files, guard hash ${h.hash.slice(0, 12)}`,
      'the skill folders are untouched; the manifest is untouched',
      'the parked copy is kept: prune removes it only with --include-kept',
    ]
  )
}

/** What the other actions say of an unreadable record: `--park` when it is offered, else why not. */
export function parkWord(cls: Unreadable): string {
  const p = parkPlan(cls)
  return p.offered ? '--park is offered' : `--park is not offered either (${p.reason}: ${p.detail})`
}

/** The words for `--abandon`, `--clean-staging` and `--park`; null when the class says nothing. */
export function sixBActions(cls: RecoveryClass, action: RecoveryAction): ActionPlan | null {
  switch (cls.kind) {
    case 'empty-op-dir':
      return refuse(
        action,
        'recovery-not-offered',
        "it holds nothing; any doctor action holding this root's lock removes it with one rmdir"
      )
    case 'no-record':
      // 6b-ii: `planAction` plans it in `skill-recovery.plan.clean.ts` (C2) and never gets here.
      return null
    case 'unreadable':
      return action === 'park'
        ? parkPlan(cls)
        : refuse(action, 'recovery-not-offered', `the record cannot be trusted: ${parkWord(cls)}`)
    case 'other-user':
      return refuse(
        action,
        'recovery-other-user',
        `the op dir belongs to uid ${cls.ownerUid ?? 'unknown'}: run doctor as that user`
      )
    case 'moved':
    case 'identity-changed':
    case 'ab':
    case 'anything-else':
      return action === 'abandon'
        ? offer(
            action,
            [
              step('O', kept('abandoned-old'), 'if present'),
              step('N', kept('abandoned-new'), 'if present'),
              step('U', kept('abandoned-undone'), 'if present'),
            ],
            'untouched',
            [FINISH]
          )
        : null
    case 'state':
      return action === 'abandon' || action === 'clean-staging' || action === 'park'
        ? refuse(action, 'recovery-not-offered', 'offered here: --apply or --undo')
        : null
  }
}
