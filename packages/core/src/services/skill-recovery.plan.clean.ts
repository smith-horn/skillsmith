/**
 * SMI-6531 (A1 step 6b-ii): the plan table's rows for an op dir with no
 * `record.json` (class `no-record`), `--clean-staging` above all (A1 plan
 * §3.9, PLAN:2018; design `step6b-design.md` § 1.2, O1, O2, C2).
 *
 * `--clean-staging` is offered in two cases, and refused otherwise with zero
 * mutation:
 *  - **(a) a verifying `park-intent.json`** (C2: the intent wins over a fresh
 *    keep). Its park is finished as the intent says: `abort-new` (abort
 *    cleanup's, which parks `new/`) or `move-source` (a cross-device finish's,
 *    which `--apply` and `--undo` also finish). With `owner.json` still
 *    there, only when its owner is same-host and dead, or with
 *    `--unsafe-unverified-owner`; without it, the intent alone is enough.
 *  - **(b) no intent**: only when `owner.json`'s owner is same-host and dead,
 *    or with `--unsafe-unverified-owner`. `new/` is kept as `unrecorded-new`,
 *    as it is now, or resumed with its own kind when abort cleanup had
 *    started its keep; then the metadata goes, `owner.json` last.
 *
 * Refused whatever the flag: an entry doctor cannot prove it wrote (O2: named,
 * with "move it out by hand and run the command again"), an intent whose park
 * cannot be finished, a keep in the area that cannot be acted on, and no
 * state root to keep into. The owner verdict is in every offered plan and in
 * the owner refusal, so the serialized plan (and so the re-plan digest)
 * changes when it does: a pid that dies between the plan and the lock is `plan-changed`.
 *
 * Pure, like the rest of the table: no row removes a tree (UD13).
 *
 * @module @skillsmith/core/services/skill-recovery.plan.clean
 */
import path from 'node:path'
import { parkClientOf, parkIndexOf } from './skill-recovery.attribution.js'
import type { Attribution } from './skill-recovery.attribution.js'
import { kept, offer, refuse, step } from './skill-recovery.plan.actions.js'
import type {
  ActionPlan,
  NoRecordIntent,
  PlanStep,
  RecoveryAction,
  RecoveryClass,
} from './skill-recovery.types.js'
import { OWNER_FILE, PARK_INTENT_FILE } from './skill-swap.types.js'

type NoRecord = Extract<RecoveryClass, { kind: 'no-record' }>

const BY_HAND = 'move it out of the op dir by hand, and run the command again'
const UNTOUCHED_NOTE = 'the skill folders are untouched; the manifest is untouched'

/** Where a keep or a park is routed, in words (O1: a routing hint, never authority). */
function routeWords(a: Attribution): string {
  return a.kind === 'attributed'
    ? `routed by owner.json's attribution (client ${a.client}, folder ${a.dirName}, state root ${a.stateRoot}): a routing hint, which decides only where the copy is filed`
    : `filed under client none: no attribution validated (${a.why})`
}

/** The owner refusal: what `owner.json` claims and why it is not enough. */
function ownerRefusal(cls: NoRecord): ActionPlan {
  return refuse(
    'clean-staging',
    'recovery-not-offered',
    `owner ${cls.clean.verdict}: ${cls.clean.verdictWhy}. --clean-staging acts only when owner.json ` +
      'names a process on this host that is not running; if you are sure no update is still using ' +
      'this op dir, add --unsafe-unverified-owner'
  )
}

/** The owner's lines: the verdict, and what `--unsafe-unverified-owner` is acting past. */
function ownerNotes(cls: NoRecord, unsafe: boolean): string[] {
  const c = cls.clean
  const lines = [`owner ${c.verdict}: ${c.verdictWhy}`]
  if (unsafe && c.verdict !== 'same-host-dead') {
    lines.push(
      `--unsafe-unverified-owner: its owner cannot be verified gone (${c.verdict}); acting anyway`
    )
  }
  return lines
}

const roleOf = (name: string): PlanStep['tree'] =>
  name === 'old' ? 'O' : name === 'new' ? 'N' : 'U'

/** (a): finish the intent's park. */
function intentPlan(cls: NoRecord, i: NoRecordIntent, unsafe: boolean): ActionPlan {
  const c = cls.clean
  const kind = i.kind === 'abort-new' ? 'abort-new' : 'move-source'
  const owner = cls.entries.includes(OWNER_FILE)
  const index = parkIndexOf(c.attribution)
  return offer(
    'clean-staging',
    i.sources.map((s) =>
      step(
        roleOf(s.name),
        kept(kind),
        `${s.name}/ is set aside with the op dir, as the intent says`
      )
    ),
    'untouched',
    [
      ...c.temps.map((t) => `unlink the metadata temp ${t}`),
      ...(owner ? ['unlink owner.json'] : []),
      `park the op dir (kind ${kind}), checked against a fresh hash of its contents`,
    ],
    [
      kind === 'abort-new'
        ? `the update that made it aborted and was setting it aside (park-intent.json, kind abort-new); ` +
          `it is parked as client ${parkClientOf(c.attribution)}, ${index === null ? 'with no parked-index line' : `indexed in ${index}`}`
        : `there is no record (a finish that had written its move-source intent: an update after its record was removed, or a cross-device --clean-staging); the intent records the verified copy's path as ${i.backupPath}`,
      ...(kind === 'abort-new' ? [routeWords(c.attribution)] : []),
      ...(owner ? ownerNotes(cls, unsafe) : [`owner ${c.verdict}: ${c.verdictWhy}`]),
      UNTOUCHED_NOTE,
    ]
  )
}

const tempLine = (t: string): string => `unlink the metadata temp ${t}`
const isIntentTemp = (t: string): boolean => path.basename(t) === `${PARK_INTENT_FILE}.tmp`

/**
 * What `finishNoRecord` does after the keep, in its order: the temps, then
 * `owner.json` (only when the op dir holds it), then the `rmdir`.
 */
function oneDeviceSteps(temps: readonly string[], owner: boolean): string[] {
  return [
    ...temps.map(tempLine),
    ...(owner ? ['unlink owner.json'] : []),
    'rmdir the emptied op dir and sync the staging dir',
  ]
}

/**
 * What `finishAcross` does after the keep, in its order: a `park-intent.json.tmp`
 * of this op, the intent, the other temps, `owner.json` (only when the op dir
 * holds it), a sync of the op dir, then the park of the op dir whole.
 */
function acrossSteps(temps: readonly string[], owner: boolean): string[] {
  return [
    ...temps.filter(isIntentTemp).map(tempLine),
    'write park-intent.json (kind move-source) durably',
    ...temps.filter((t) => !isIntentTemp(t)).map(tempLine),
    ...(owner ? ['unlink owner.json'] : []),
    'sync the op dir',
    'park the op dir whole with the verified new/ and the intent (no rmdir)',
  ]
}

/**
 * (b): keep `new/`, then the metadata. Only a `new/` still to be kept can cross
 * devices, and whether it does is decided when the copy runs (its rename fails
 * `EXDEV`), not by anything the plan reads. So for a source the plan states
 * both finishes, each in the order its executor takes: a text that changed
 * with the device would be `plan-changed` at lock 1.
 */
function keepPlan(cls: NoRecord, area: string, unsafe: boolean): ActionPlan {
  const c = cls.clean
  const n = c.n
  const owner = cls.entries.includes(OWNER_FILE)
  const steps: PlanStep[] = []
  const remaining: string[] = []
  if (n.kind === 'source') {
    const kind = n.started?.kind ?? 'unrecorded-new'
    steps.push(
      step(
        'N',
        kept(kind),
        n.started === null
          ? 'new/ is kept as unrecorded-new, as it is now (any edit in it included)'
          : `the keep abort cleanup started resumes with its own kind, ${kind}`
      )
    )
    if (n.started !== null)
      remaining.push(`resume the keep of ${n.started.base} from ${n.started.state}`)
  } else if (n.kind === 'kept') {
    steps.push(step('N', kept(n.keep.kind), `already kept at ${n.keep.destPath}`))
  }
  if (n.kind === 'source') {
    remaining.push(
      `on one device: ${oneDeviceSteps(c.temps, owner).join(', then ')}`,
      `if the copy crosses devices: ${acrossSteps(c.temps, owner).join(', then ')}`
    )
  } else {
    remaining.push(...oneDeviceSteps(c.temps, owner))
  }
  return offer('clean-staging', steps, 'untouched', remaining, [
    `kept into ${area}; ${routeWords(c.attribution)}`,
    ...(n.kind === 'source'
      ? [
          'if the backup area is on another device, new/ is copied and verified first, and the op dir is then set aside whole with it',
        ]
      : []),
    ...ownerNotes(cls, unsafe),
    UNTOUCHED_NOTE,
  ])
}

/** `--clean-staging` for a no-record op dir (see the module comment). */
function cleanPlan(cls: NoRecord, unsafe: boolean): ActionPlan {
  const c = cls.clean
  const i = cls.intent
  if (c.unprovable !== null) {
    return refuse(
      'clean-staging',
      'recovery-not-offered',
      `${path.join(cls.opDir, c.unprovable.name)}: ${c.unprovable.why}, so doctor cannot prove it ` +
        `wrote it and changes nothing here; ${BY_HAND}`
    )
  }
  const ownerOk = c.verdict === 'same-host-dead' || unsafe
  if (i !== null && i.valid) {
    if (c.intentBlocked !== null) {
      return refuse(
        'clean-staging',
        'recovery-not-offered',
        `its park-intent.json verifies, but its park cannot be finished: ${c.intentBlocked}`
      )
    }
    if (cls.entries.includes(OWNER_FILE) && !ownerOk) return ownerRefusal(cls)
    return intentPlan(cls, i, unsafe)
  }
  if (c.groupsBlocked !== null) {
    return refuse(
      'clean-staging',
      'recovery-not-offered',
      `${c.groupsBlocked}; nothing was changed`
    )
  }
  if (c.area === null) {
    return refuse(
      'clean-staging',
      'recovery-not-offered',
      'no state root to keep into: give the state root with --state-root <dir>'
    )
  }
  if (!ownerOk) return ownerRefusal(cls)
  return keepPlan(cls, c.area, unsafe)
}

/** Every action's plan for a no-record op dir but `--apply`/`--undo` of a verifying move-source intent. */
export function noRecordPlan(cls: NoRecord, action: RecoveryAction, unsafe: boolean): ActionPlan {
  if (action === 'clean-staging') return cleanPlan(cls, unsafe)
  const p = cleanPlan(cls, false)
  const word = p.offered
    ? 'offered here: --clean-staging'
    : `--clean-staging is not offered either (${p.reason}: ${p.detail})`
  const blocked = cls.intent?.blocked
  return refuse(
    action,
    'recovery-not-offered',
    `${word}${blocked === undefined || blocked === null ? '' : ` (${blocked})`}`
  )
}
