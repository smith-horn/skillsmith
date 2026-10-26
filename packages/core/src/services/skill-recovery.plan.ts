/**
 * SMI-6531 (A1 step 6a-i): what each doctor action would do to each class
 * (plan §3.3 "Dispositions", the post-keep table, §3.9 targeting; design § 3).
 *
 * `planAction(cls, action)` is pure: a table from a classification to an
 * `ActionPlan`, a list of steps whose dispositions are `installed`, `kept as
 * <kind>` or `untouched`, and nothing else. No row removes a tree (UD13); the
 * `Disposition` type has no case for it. 6a-i only lists these plans: nothing
 * performs an action yet.
 *
 * `--apply` and `--undo` are offered for the §3.3 rows and their post-keep
 * forms; every other class gets its own words (`recovery-moved`,
 * `recovery-identity-changed`, `recovery-conflict`, `recovery-other-user`,
 * `recovery-not-offered`). `--abandon`, `--clean-staging` and `--park` are
 * 6b's: here they say whether they would be offered.
 *
 * @module @skillsmith/core/services/skill-recovery.plan
 */
import { canonicalJson } from './skill-recovery.digest.js'
import type {
  ActionPlan,
  Disposition,
  OpFacts,
  PlanStep,
  RecoveryAction,
  RecoveryClass,
  RecoveryRefuseReason,
  RowState,
} from './skill-recovery.types.js'

export const RECOVERY_ACTIONS: readonly RecoveryAction[] = [
  'apply',
  'undo',
  'abandon',
  'clean-staging',
  'park',
]

const ROW_LABEL: Record<RowState, string> = {
  S0: 'S0 not swapped',
  S1: 'S1 between renames',
  S2: 'S2 swapped',
  S2prime: "S2' swapped, manifest changed",
  S2x: 'S2x live folder removed or replaced',
  S3: 'S3 committed',
  UN1: 'UN1 undo, set aside',
  UN2: 'UN2 undo, restored',
}

/** A short name for the class, for lists and JSON. */
export function classLabel(cls: RecoveryClass): string {
  switch (cls.kind) {
    case 'state':
      return cls.postKeep ? `${ROW_LABEL[cls.state]} (after its keep)` : ROW_LABEL[cls.state]
    case 'unreadable':
      return `unreadable record (${cls.why})`
    case 'moved':
      return `moved (${cls.why})`
    case 'ab':
      return 'AB abandon started'
    case 'anything-else':
      return 'anything else'
    default:
      return cls.kind
  }
}

const kept = (as: string): Disposition => ({ kind: 'kept', as })
const INSTALLED: Disposition = { kind: 'installed' }
const UNTOUCHED: Disposition = { kind: 'untouched' }

const refuse = (
  action: RecoveryAction,
  reason: RecoveryRefuseReason,
  detail: string
): ActionPlan => ({ offered: false, action, reason, detail })

const offer = (
  action: RecoveryAction,
  steps: PlanStep[],
  manifest: 'untouched' | 'committed-to-post',
  remaining: string[],
  notes: string[] = []
): ActionPlan => ({ offered: true, action, steps, manifest, remaining, notes })

const step = (tree: PlanStep['tree'], disposition: Disposition, note: string): PlanStep => ({
  tree,
  disposition,
  note,
})

/** The kind a staged or set-aside tree is kept as: a started keep's own kind, else by its hash. */
function keptKindOf(
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
function resumes(f: OpFacts): string[] {
  return f.groups
    .filter((g) => g.state !== null && g.state !== 'P5')
    .map((g) => `resume the keep of ${g.base} from ${g.state}`)
}

const FINISH = 'unlink the metadata files, then rmdir the op dir and sync the staging dir'

/** Notes every row of the plan states: where the old folder is kept, and what a cross-device keep needs. */
function commonNotes(f: OpFacts): string[] {
  const notes = [`the old folder is kept at ${f.record.backupDest}`]
  if (f.groups.some((g) => g.crossDevice) || f.fullDevice !== null) {
    notes.push('part of the keep is across devices: that resume is not available yet')
  }
  return notes
}

/**
 * The uid of whoever started the update, when it is not the effective uid and
 * the class says whose it is (a record's, or `owner.json`'s). Doctor acts only
 * on updates the current user started (Q8), so this is checked before any
 * class-specific handling.
 */
function foreignUid(cls: RecoveryClass): number | null {
  switch (cls.kind) {
    case 'state':
    case 'identity-changed':
    case 'ab':
      return cls.facts.otherUid
    case 'anything-else':
      return cls.facts === null ? null : cls.facts.otherUid
    case 'moved':
    case 'no-record':
      return cls.otherUid
    default:
      return null
  }
}

/** `--apply` and `--undo` for a §3.3 row; null when the row says nothing about this action. */
function rowPlan(
  cls: Extract<RecoveryClass, { kind: 'state' }>,
  action: 'apply' | 'undo'
): ActionPlan {
  const f = cls.facts
  const { state, postKeep } = cls
  const fixed = commonNotes(f)
  const nKind = keptKindOf('N', f, 'unused-new', 'edited-new')
  const uKind = keptKindOf('U', f, 'undone', 'conflict')
  const tKind = f.t.present && f.t.hash === f.record.postTree ? 'undone' : 'conflict'
  const oNote = postKeep ? 'already kept as backup' : 'kept as backup'
  const manual = 'restore it from the backup by hand'

  switch (state) {
    case 'S0':
      return offer(
        action,
        [
          step('T', UNTOUCHED, 'the skill folder was never swapped'),
          step('N', kept(nKind), `the staged copy is kept as ${nKind}`),
        ],
        'untouched',
        [...resumes(f), FINISH],
        ['`--apply` and `--undo` are the same here: nothing was swapped']
      )
    case 'S1':
      if (action === 'apply') {
        if (f.nHashesToPost === false) {
          return refuse(
            'apply',
            'recovery-conflict',
            'the new folder no longer hashes to what was built: --undo is offered'
          )
        }
        return offer(
          'apply',
          [
            step('N', INSTALLED, 'claim the skill path and rename the new folder over it'),
            step('O', kept('backup'), oNote),
          ],
          'committed-to-post',
          [
            'claim the skill path and rename the new folder over it',
            'commit the manifest entry (lock 3)',
            'append the audit record',
            'keep the old folder as backup',
            ...resumes(f),
            FINISH,
          ],
          fixed
        )
      }
      return offer(
        'undo',
        [
          step('O', INSTALLED, 'claim the skill path and rename the old folder over it'),
          step('N', kept(nKind), `the staged copy is kept as ${nKind}`),
        ],
        'untouched',
        ['claim the skill path and rename the old folder over it', ...resumes(f), FINISH]
      )
    case 'S2':
    case 'S2prime':
    case 'S2x':
      return swappedPlan(cls, action, { oNote, tKind, manual, fixed })
    case 'S3':
      if (action === 'undo') {
        return refuse('undo', 'recovery-not-offered', `the update is complete: ${manual}`)
      }
      return offer(
        'apply',
        [step('T', UNTOUCHED, 'the new folder stays'), step('O', kept('backup'), oNote)],
        'untouched',
        [
          f.journal !== null && f.journal.present
            ? 'the audit record is already in the journal'
            : 'append the audit record (none carries this opId)',
          ...(postKeep ? [] : ['keep the old folder as backup']),
          ...resumes(f),
          FINISH,
        ],
        fixed
      )
    case 'UN1':
    case 'UN2':
      return offer(
        action,
        [
          ...(state === 'UN1'
            ? [step('O', INSTALLED, 'claim the skill path and rename the old folder over it')]
            : [step('T', UNTOUCHED, 'the old folder is back')]),
          step('U', kept(uKind), `the set-aside folder is kept as ${uKind}`),
        ],
        'untouched',
        [
          ...(state === 'UN1' ? ['claim the skill path and rename the old folder over it'] : []),
          ...resumes(f),
          FINISH,
        ],
        ['`--apply` and `--undo` are the same here: they finish the undo']
      )
  }
}

/** S2, S2' and S2x: the swap completed (or the live folder is gone). */
function swappedPlan(
  cls: Extract<RecoveryClass, { kind: 'state' }>,
  action: 'apply' | 'undo',
  w: { oNote: string; tKind: string; manual: string; fixed: string[] }
): ActionPlan {
  const f = cls.facts
  if (action === 'apply') {
    if (cls.state === 'S2') {
      const changed = f.t.present && f.t.hash !== f.record.postTree
      return offer(
        'apply',
        [step('T', UNTOUCHED, 'the new folder stays'), step('O', kept('backup'), w.oNote)],
        'committed-to-post',
        [
          'commit the manifest entry (lock 3)',
          'append the audit record',
          ...(cls.postKeep ? [] : ['keep the old folder as backup']),
          ...resumes(f),
          FINISH,
        ],
        [
          ...w.fixed,
          ...(changed
            ? ['the live folder changed since the update: committed with live-folder-changed']
            : []),
        ]
      )
    }
    return refuse(
      'apply',
      'recovery-conflict',
      cls.state === 'S2prime'
        ? 'the manifest entry is neither the planned nor the updated one'
        : 'the live folder was removed or replaced: --undo is offered'
    )
  }
  if (cls.postKeep) {
    return refuse(
      'undo',
      'recovery-not-offered',
      `the old folder is already in the backup area: ${w.manual}`
    )
  }
  return offer(
    'undo',
    [
      step('O', INSTALLED, 'the old folder goes back to the skill path'),
      ...(f.t.present
        ? [
            step(
              'T',
              kept(w.tKind),
              `the folder at the skill path is set aside and kept as ${w.tKind}`
            ),
          ]
        : []),
    ],
    'untouched',
    [
      ...(f.t.present ? ['set the folder at the skill path aside'] : []),
      'claim the skill path and rename the old folder over it',
      ...resumes(f),
      FINISH,
    ]
  )
}

/** The words for `--abandon`, `--clean-staging` and `--park`, which 6b performs. */
function otherActions(cls: RecoveryClass, action: RecoveryAction): ActionPlan | null {
  const only = (word: string): ActionPlan =>
    refuse(action, 'recovery-not-offered', `offered here: ${word}`)
  switch (cls.kind) {
    case 'empty-op-dir':
      return refuse(
        action,
        'recovery-not-offered',
        "it holds nothing; any doctor action holding this root's lock removes it with one rmdir"
      )
    case 'no-record':
      return action === 'clean-staging'
        ? offer(
            action,
            [
              step('O', kept('unrecorded-new'), 'kept if present'),
              step('N', kept('unrecorded-new'), 'kept if present'),
            ],
            'untouched',
            [FINISH]
          )
        : only('--clean-staging')
    case 'unreadable':
      return action === 'park'
        ? offer(action, [], 'untouched', ['park the whole op dir'])
        : only('--park')
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

/** What `action` would do to `cls`: the steps and where each tree ends, or why it is not offered. */
export function planAction(cls: RecoveryClass, action: RecoveryAction): ActionPlan {
  const uid = foreignUid(cls)
  if (uid !== null) {
    return refuse(
      action,
      'recovery-other-user',
      `the update was started by uid ${uid}, not this user: run doctor as that user`
    )
  }
  if (action === 'apply' || action === 'undo') {
    if (cls.kind === 'state') return rowPlan(cls, action)
    if (cls.kind === 'moved') {
      return refuse(
        action,
        'recovery-moved',
        'the root or op dir is not the one the record was written for: only --abandon is offered; moving the root back to its recorded path makes --apply possible'
      )
    }
    if (cls.kind === 'identity-changed') {
      return refuse(
        action,
        'recovery-identity-changed',
        'a tree has the right content but is not the folder that was written (a copy, or a remount): --accept-identity waives this check'
      )
    }
    if (cls.kind === 'unreadable') {
      return refuse(
        action,
        'recovery-record-unreadable',
        'the record cannot be trusted: --park is offered'
      )
    }
  }
  const other = otherActions(cls, action)
  if (other !== null) return other
  if (cls.kind === 'other-user') {
    return refuse(
      action,
      'recovery-other-user',
      `the op dir belongs to uid ${cls.ownerUid ?? 'unknown'}`
    )
  }
  return refuse(
    action,
    'recovery-not-offered',
    cls.kind === 'ab' ? 'an abandon began: --abandon finishes it' : 'offered here: --abandon'
  )
}

/** Every action's plan for `cls`, in the order the listing shows them. */
export function plansFor(cls: RecoveryClass): ActionPlan[] {
  return RECOVERY_ACTIONS.map((a) => planAction(cls, a))
}

/** The canonical serialization of the plan the digest covers: the label and every action's plan. */
export function serializePlan(cls: RecoveryClass): string {
  return canonicalJson({ label: classLabel(cls), plans: plansFor(cls) })
}
