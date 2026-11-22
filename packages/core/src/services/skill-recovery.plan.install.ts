/**
 * SMI-6531 (A1 step 8-i-a-2): what `--apply` and `--undo` would do to a
 * fresh install's row (design § 4, § 5; plan D2), as `skill-recovery.plan.ts`
 * says it for an update's rows, and the row labels.
 *
 * | Row | `--apply` | `--undo` |
 * |---|---|---|
 * | FI0 | install N, commit (refused `recovery-conflict` when N no longer hashes to `postTree`) | keep N |
 * | FI1 | rename N over the empty claim, commit (same refusal) | keep N, then remove the empty claim |
 * | FI0/FI1 after the keep | finish the undo | finish the undo |
 * | FI2 | commit; the folder stays | set the folder aside and keep it (`undone`/`conflict`) |
 * | FI2′ | refused `recovery-conflict` | as FI2 |
 * | FI2u | keep U unless kept (= `--undo`) | same |
 * | FI3 | finish (nothing moves) | refused `recovery-not-offered`: the install is complete |
 * | FI4 | finish: nothing moves, the set-aside copy stays where it is (the note says how to get it back) | same |
 *
 * `--abandon` is not offered on a row: each one has an action that finishes
 * it. Pure: no filesystem access.
 *
 * @module @skillsmith/core/services/skill-recovery.plan.install
 */
import path from 'node:path'
import { INSTALLED, kept, refuse, step, UNTOUCHED } from './skill-recovery.plan.actions.js'
import { keptKindOf, resumes, rowOffer } from './skill-recovery.plan.rows.js'
import type { ActionPlan, InstallRowState, OpFacts, RecoveryClass } from './skill-recovery.types.js'

export const INSTALL_ROW_LABEL: Readonly<Record<InstallRowState, string>> = {
  FI0: 'FI0 not claimed',
  FI1: 'FI1 claimed',
  FI2: 'FI2 published',
  FI2prime: "FI2' published, manifest changed",
  FI2u: 'FI2u undo, set aside',
  FI3: 'FI3 committed',
  FI4: 'FI4 rolled back',
}

type StateClass = Extract<RecoveryClass, { kind: 'state' }>

const SAME_UNDO = '`--apply` and `--undo` are the same here: they finish the undo'

/** The note an install's undo ends with: where the folder is kept, and that the skill path stays empty. */
function emptyPathNote(f: OpFacts, kind: string): string {
  return `the skill path stays empty; the new folder is kept at ${path.join(f.area, `${f.opId}.${kind}`)}`
}

/**
 * FI4's note, worded from what `skillsmith restore` itself would do with the
 * set-aside copy (`ParkedCopyFact.restore`, which the classifier asks of
 * restore's own functions): when restore would put it back, the command, and,
 * only when restore's done message will say so, that it differs from what was
 * set aside; when restore would refuse, the copy's path, restore's own reason,
 * and that it can be copied back by hand.
 */
function setAsideNote(f: OpFacts): string {
  const c = f.parked?.[0]
  if (c === undefined) return 'nothing is moved'
  const at = `nothing is moved; the folder set aside at ${c.path}`
  if (!c.restore.would) {
    return (
      `${at} cannot be put back by \`skillsmith restore\` (${c.restore.reason}: ${c.restore.message}); ` +
      `copy it to ${f.tPath} by hand if you want it`
    )
  }
  const offer = `${at} can be put back with \`skillsmith restore ${f.opId}\``
  return c.restore.differs ? `${offer}; restore will say it differs from what was set aside` : offer
}

/** FI0/FI1 `--apply`: N to the skill path and the commit, unless N no longer hashes to `postTree`. */
function installPlan(f: OpFacts, claimed: boolean): ActionPlan {
  if (f.nHashesToPost !== true) {
    return refuse('apply', 'recovery-conflict', 'the new folder no longer hashes to what was built')
  }
  const how = claimed
    ? 'rename the new folder over the empty claim at the skill path'
    : 'claim the skill path and rename the new folder over it'
  return rowOffer(
    f,
    'apply',
    [step('N', INSTALLED, how)],
    'committed-to-post',
    [
      're-check the new folder (identity and hash)',
      how,
      'commit the manifest entry (lock 3)',
      ...resumes(f),
    ],
    [`puts the new folder at ${f.tPath} and adds the manifest entry`]
  )
}

/** FI0/FI1 `--undo`, and either action after the keep: keep N (unless kept), then (FI1) the claim goes. */
function keepNewPlan(cls: StateClass, action: 'apply' | 'undo'): ActionPlan {
  const f = cls.facts
  const nKind = keptKindOf('N', f, 'unused-new', 'edited-new')
  const claimed = cls.state === 'FI1'
  return rowOffer(
    f,
    action,
    [
      step(
        'N',
        kept(nKind),
        cls.postKeep ? `already kept as ${nKind}` : `the staged copy is kept as ${nKind}`
      ),
    ],
    'untouched',
    [
      ...resumes(f),
      ...(claimed ? ['remove the empty claim at the skill path (a non-recursive rmdir)'] : []),
    ],
    [
      ...(cls.postKeep ? [SAME_UNDO] : []),
      ...(claimed ? ['the claim is removed only while it is still empty'] : []),
      'the skill path stays empty; the manifest entry is untouched',
    ]
  )
}

/** FI2/FI2′ `--undo`: the folder at the skill path set aside and kept. */
function setAsidePlan(f: OpFacts): ActionPlan {
  const tKind = f.t.present && f.t.hash === f.record.postTree ? 'undone' : 'conflict'
  return rowOffer(
    f,
    'undo',
    [step('T', kept(tKind), `the folder at the skill path is set aside and kept as ${tKind}`)],
    'untouched',
    ['set the folder at the skill path aside', ...resumes(f)],
    [emptyPathNote(f, tKind), 'the manifest entry is untouched']
  )
}

/** `--apply` and `--undo` for an install's row (`state` is `cls.state`, narrowed). */
export function installRowPlan(
  cls: StateClass,
  state: InstallRowState,
  action: 'apply' | 'undo'
): ActionPlan {
  const f = cls.facts
  switch (state) {
    case 'FI0':
    case 'FI1':
      if (action === 'apply' && !cls.postKeep) return installPlan(f, state === 'FI1')
      return keepNewPlan(cls, action)
    case 'FI2':
    case 'FI2prime':
      if (action === 'undo') return setAsidePlan(f)
      if (state === 'FI2prime') {
        return refuse(
          'apply',
          'recovery-conflict',
          'the manifest entry is neither the planned one nor the installed one'
        )
      }
      return rowOffer(
        f,
        'apply',
        [step('T', UNTOUCHED, 'the new folder stays')],
        'committed-to-post',
        ['commit the manifest entry (lock 3)', ...resumes(f)],
        [
          'adds the manifest entry; the folder stays',
          ...(f.t.present && f.t.hash !== f.record.postTree
            ? ['the folder changed since the install: committed with live-folder-changed']
            : []),
        ]
      )
    case 'FI2u': {
      const uKind = keptKindOf('U', f, 'undone', 'conflict')
      return rowOffer(
        f,
        action,
        [step('U', kept(uKind), `the set-aside folder is kept as ${uKind}`)],
        'untouched',
        [...resumes(f)],
        [SAME_UNDO, emptyPathNote(f, uKind)]
      )
    }
    case 'FI3':
      if (action === 'undo') {
        return refuse(
          'undo',
          'recovery-not-offered',
          `the install is complete; run \`skillsmith remove ${f.record.target.dirName}\` to remove it`
        )
      }
      return rowOffer(
        f,
        'apply',
        [step('T', UNTOUCHED, 'the installed folder stays')],
        'untouched',
        [...resumes(f)]
      )
    case 'FI4':
      return rowOffer(
        f,
        action,
        [],
        'untouched',
        [...resumes(f)],
        [
          setAsideNote(f),
          '`--apply` and `--undo` are the same here: the install was already rolled back',
        ]
      )
  }
}

/** `--abandon` on an install row: each row has an action that finishes it. */
export function installRowAbandon(): ActionPlan {
  return refuse(
    'abandon',
    'recovery-not-offered',
    'every install row is finished by --apply or --undo, so --abandon is not offered on one'
  )
}
