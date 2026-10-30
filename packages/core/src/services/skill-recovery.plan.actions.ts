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
 * `--clean-staging` (6b-ii) is planned in `skill-recovery.plan.clean.ts`, and
 * `--abandon` (6b-iii) in `skill-recovery.plan.abandon.ts`. Every action is
 * performed (`executeRecovery`).
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

/** Every action, in the order the listing shows them (and a refusal's hint names them). */
export const RECOVERY_ACTIONS: readonly RecoveryAction[] = [
  'apply',
  'undo',
  'abandon',
  'clean-staging',
  'park',
]

/** An action `--accept-identity` may be given with. */
export type IdentityWaivedAction = Extract<RecoveryAction, 'apply' | 'undo'>

/**
 * The actions `--accept-identity` applies to (A1 plan §3.9: it is given with
 * `--apply` or `--undo`). The one table both sides read: the CLI refuses the
 * flag with any other action before discovery, `planRecovery` and
 * `executeRecovery` refuse such a request (no waiver is made for it), and the
 * refusal hint's identity clause (`skill-recovery.plan.hint.ts`) names the
 * flag only for these.
 */
export const ACCEPT_IDENTITY_ACTIONS: readonly IdentityWaivedAction[] = ['apply', 'undo']

/** Whether `--accept-identity` applies to `action` (`ACCEPT_IDENTITY_ACTIONS`). */
export const acceptsIdentity = (action: RecoveryAction): boolean =>
  (ACCEPT_IDENTITY_ACTIONS as readonly RecoveryAction[]).includes(action)

/** Why `--accept-identity` is refused with `action`, in the words every core refusal of it shares. */
export function acceptIdentityRefused(action: RecoveryAction): string {
  const allowed = ACCEPT_IDENTITY_ACTIONS.map((a) => `--${a}`).join(' or ')
  return `--accept-identity applies only with ${allowed}, not --${action}`
}

/** The key only this module holds, so no object literal elsewhere is a waiver. */
const WAIVER: unique symbol = Symbol('IdentityWaiver')

/**
 * `--accept-identity` as a value the classifier reads: identity is waived and
 * each present tree must hash to its role's recorded hash. Only
 * `identityWaiverFor` makes one, and only for an action in
 * `ACCEPT_IDENTITY_ACTIONS`, so no listing or action outside them can carry
 * it. It is not exported from the package.
 */
export interface IdentityWaiver {
  readonly action: IdentityWaivedAction
  readonly [WAIVER]: true
}

/** The waiver for `action`, or null when `--accept-identity` does not apply to it. */
export function identityWaiverFor(action: RecoveryAction): IdentityWaiver | null {
  const taken = ACCEPT_IDENTITY_ACTIONS.find((a) => a === action)
  return taken === undefined ? null : Object.freeze({ action: taken, [WAIVER]: true as const })
}

/** Whether `w` is a waiver `identityWaiverFor` made (a forged object without the key is not). */
export const waives = (w: IdentityWaiver | null | undefined): boolean =>
  w !== null && w !== undefined && w[WAIVER] === true

/** Why `--clean-staging` or `--park` refuses an op dir whose record verified: what each acts on. */
const RECORD_VERIFIES: Readonly<Record<'clean-staging' | 'park', string>> = {
  'clean-staging': 'its record verifies; --clean-staging acts only on an op dir with no record',
  park: 'its record verifies; --park acts only on an unreadable record',
}

/** `RECORD_VERIFIES` for `action`, naming only that action (any other: that its record verifies). */
export const recordVerifies = (action: RecoveryAction): string =>
  action === 'clean-staging' || action === 'park' ? RECORD_VERIFIES[action] : 'its record verifies'

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

/**
 * How an op dir with no `record.json` and a verifying `move-source` park intent
 * came to be: the one wording every place that says it shares (the plan text in
 * `skill-recovery.plan.ts` and `.plan.clean.ts`, and the CLI's listing), so the
 * origins cannot be named differently in two places. Three finishes write that
 * intent and then lose their record: an update after it removed its record,
 * and doctor's own cross-device `--apply`/`--undo` (which unlinks `record.json`
 * after the intent) and `--clean-staging` (which never had one).
 */
export const MOVE_SOURCE_NO_RECORD_ORIGIN =
  'a finish that had written its move-source intent (an update after its record was removed, or a cross-device --apply, --undo or --clean-staging by doctor)'

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

/**
 * The words for `--clean-staging` and `--park` (and an empty op dir's for
 * every action); null when the class says nothing. `--abandon` is planned
 * before this is reached (`skill-recovery.plan.abandon.ts`). No refusal here
 * names another action: which ones are offered is the hint `planAction` adds
 * (`skill-recovery.plan.hint.ts`).
 */
export function sixBActions(cls: RecoveryClass, action: RecoveryAction): ActionPlan | null {
  switch (cls.kind) {
    case 'empty-op-dir':
      return refuse(
        action,
        'recovery-not-offered',
        "nothing to act on; the next doctor action holding this root's lock removes it with one rmdir"
      )
    case 'no-record':
      // 6b-ii: `planAction` plans it in `skill-recovery.plan.clean.ts` (C2) and never gets here.
      return null
    case 'unreadable':
      return action === 'park'
        ? parkPlan(cls)
        : refuse(action, 'recovery-not-offered', 'the record cannot be trusted')
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
      return null
    case 'state':
      return action === 'clean-staging' || action === 'park'
        ? refuse(action, 'recovery-not-offered', recordVerifies(action))
        : null
  }
}
