/**
 * SMI-6531 (A1 step 6a-i): what each doctor action would do to each class
 * (plan §3.3 "Dispositions", the post-keep table, §3.9 targeting; design § 3).
 *
 * `planAction(cls, action)` is pure: a table from a classification to an
 * `ActionPlan`, a list of steps whose dispositions are `installed`, `kept as
 * <kind>` or `untouched`, and nothing else. No row removes a tree (UD13); the
 * `Disposition` type has no case for it. `--apply` and `--undo` perform these
 * plans (`skill-recovery.run.ts`).
 *
 * `--apply` and `--undo` are offered for the §3.3 rows and their post-keep
 * forms; every other class gets its own words (`recovery-moved`,
 * `recovery-identity-changed`, `recovery-conflict`, `recovery-other-user`,
 * `recovery-not-offered`). The words for `--abandon` and `--park` (6b), and
 * the table's building blocks, are in `skill-recovery.plan.actions.ts`; an op
 * dir with no record (`--clean-staging`, 6b-ii) is
 * `skill-recovery.plan.clean.ts`'s.
 *
 * @module @skillsmith/core/services/skill-recovery.plan
 */
import { canonicalJson } from './skill-recovery.digest.js'
import {
  FINISH,
  INSTALLED,
  kept,
  offer,
  parkWord,
  refuse,
  sixBActions,
  step,
  UNTOUCHED,
} from './skill-recovery.plan.actions.js'
import { noRecordPlan } from './skill-recovery.plan.clean.js'
import { FREE_SPACE_REMEDY } from './skill-swap.types.js'
import type {
  ActionPlan,
  NoRecordIntent,
  OpFacts,
  RecoveryAction,
  RecoveryClass,
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

/** Notes every row of the plan states: where the old folder is kept, and what a cross-device keep needs. */
function commonNotes(f: OpFacts): string[] {
  const notes = [`the old folder is kept at ${f.record.backupDest}`]
  if (f.groups.some((g) => g.crossDevice)) {
    notes.push(
      'part of the keep is across devices: each copy is verified before its source is parked with the op dir'
    )
  }
  if (f.fullDevice !== null) {
    notes.push(
      `an earlier copy stopped on a full device (${f.fullDevice.cause} at ${f.fullDevice.stage}); ` +
        `if the copy still cannot fit, this stops with state-root-full: ${FREE_SPACE_REMEDY}`
    )
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

/**
 * 6a-iii: an op dir with no record whose move-source park intent verifies (a
 * finish that had written its intent: an update after its record was removed,
 * or a cross-device `--clean-staging`). `--apply` and `--undo`
 * finish that park as the uninterrupted run would: each source goes with OP.
 * 6b-ii: the metadata temps the classifier proved this op's (`temps`) are
 * unlinked first, so the plan names each one (and the digest covers them).
 */
function intentParkPlan(
  i: NoRecordIntent,
  temps: readonly string[],
  action: 'apply' | 'undo'
): ActionPlan {
  return offer(
    action,
    i.sources.map((s) =>
      step(
        s.name === 'old' ? 'O' : s.name === 'new' ? 'N' : 'U',
        kept('move-source'),
        `the verified source ${s.name} is set aside with the op dir`
      )
    ),
    'untouched',
    [
      ...temps.map((t) => `unlink the metadata temp ${t}`),
      'unlink owner.json if it is there',
      `park the op dir (kind ${i.kind}), checked against a fresh hash of its contents`,
    ],
    [
      `there is no record (a finish that had written its move-source intent: an update after its record was removed, or a cross-device --clean-staging); the intent records the verified copy's path as ${i.backupPath}`,
      '`--apply` and `--undo` are the same here: they finish the park',
    ]
  )
}

/** What a plan may take from the request besides the class (6b-ii). */
export interface PlanOptions {
  /** `--unsafe-unverified-owner`: `--clean-staging` acts past an owner it cannot show gone. */
  unsafeUnverifiedOwner?: boolean
}

/**
 * What `action` would do to `cls`: the steps and where each tree ends, or why
 * it is not offered. The listing and the digest plan without `opts` (the
 * owner verdict is in those words, so the digest covers it); the targeted
 * action plans with the request's flags.
 */
export function planAction(
  cls: RecoveryClass,
  action: RecoveryAction,
  opts: PlanOptions = {}
): ActionPlan {
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
    if (cls.kind === 'no-record' && cls.intent !== null && cls.intent.blocked === null) {
      return intentParkPlan(cls.intent, cls.clean.temps, action)
    }
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
        `the record cannot be trusted: ${parkWord(cls)}`
      )
    }
  }
  // 6b-ii: `--clean-staging` and the other actions' words for an op dir with no record.
  if (cls.kind === 'no-record')
    return noRecordPlan(cls, action, opts.unsafeUnverifiedOwner === true)
  const other = sixBActions(cls, action)
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
