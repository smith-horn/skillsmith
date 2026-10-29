/**
 * SMI-6531 (A1 step 6b-iii): the plan text for the end of a recorded op's
 * action, step for step as its executor takes it (design `step6b-design.md`
 * § 6 traces; the #3204 lesson, as `skill-recovery.plan.clean.ts` states
 * `--clean-staging`'s). Shared by `--apply` and `--undo`
 * (`skill-recovery.plan.ts`) and `--abandon` (`skill-recovery.plan.abandon.ts`),
 * whose executors end the same two ways:
 *
 *  - **one device** (`finishRecovered`, `skill-recovery.finish.ts`): each held
 *    metadata file other than `record.json` by name, then OP synced,
 *    `record.json` unlinked, OP synced, OP `rmdir`ed, ST synced;
 *  - **across devices** (`finishRecoveredAcross`, `skill-recovery.park.ts`):
 *    a provable `park-intent.json.tmp` and a sync of OP (when there is one),
 *    the intent written (or the verifying one reused), the other metadata, OP
 *    synced, `record.json` unlinked, OP synced, then OP parked whole.
 *
 * Whether a keep crosses devices is decided when its rename fails `EXDEV`, not
 * by anything the plan reads, so a plan that still keeps a source states both
 * finishes (a text that changed with the device would be `plan-changed` at
 * lock 1). A plan that keeps no source can only end the first way.
 *
 * Pure: no filesystem access.
 *
 * @module @skillsmith/core/services/skill-recovery.plan.finish
 */
import type { OpFacts, PlanStep } from './skill-recovery.types.js'
import { OWNER_FILE, PARK_INTENT_FILE, RECORD_FILE } from './skill-swap.types.js'

/** What the finish reads of the facts: the metadata files the op dir holds. */
type FinishFacts = Pick<OpFacts, 'hasOwnerFile' | 'recordTmp' | 'parkIntent' | 'parkIntentTmp'>

const SYNC_OP = 'sync the op dir'
const unlink = (name: string): string => `unlink ${name}`

/**
 * `finishRecovered`'s order: every adopted metadata file but `record.json`, in
 * adoption order (`owner.json`, `record.json.tmp`, `park-intent.json.tmp`,
 * then a verifying `park-intent.json`), then the record last.
 */
export function recordedOneDevice(f: FinishFacts): string[] {
  return [
    ...(f.hasOwnerFile ? [unlink(OWNER_FILE)] : []),
    ...(f.recordTmp !== null ? [unlink(`${RECORD_FILE}.tmp`)] : []),
    ...(f.parkIntentTmp !== null ? [unlink(`${PARK_INTENT_FILE}.tmp`)] : []),
    ...(f.parkIntent !== null ? [unlink(PARK_INTENT_FILE)] : []),
    SYNC_OP,
    unlink(RECORD_FILE),
    SYNC_OP,
    'rmdir the emptied op dir',
    'sync the staging dir',
  ]
}

/** `finishRecoveredAcross`'s order (see the module comment); a verifying intent is reused. */
export function recordedAcross(f: FinishFacts): string[] {
  return [
    ...(f.parkIntentTmp !== null ? [unlink(`${PARK_INTENT_FILE}.tmp`), SYNC_OP] : []),
    f.parkIntent !== null
      ? `reuse the verified ${PARK_INTENT_FILE}`
      : `write ${PARK_INTENT_FILE} (kind move-source) durably`,
    ...(f.hasOwnerFile ? [unlink(OWNER_FILE)] : []),
    ...(f.recordTmp !== null ? [unlink(`${RECORD_FILE}.tmp`)] : []),
    SYNC_OP,
    unlink(RECORD_FILE),
    SYNC_OP,
    'park the op dir whole with its verified sources and the intent (no rmdir)',
  ]
}

/**
 * Whether the plan still keeps a tree from a source (a role in OP, or T set
 * aside): the trees `spaceBlock` and `intentBlock` look at (`keptSources`).
 */
export function keepsSource(f: Pick<OpFacts, 'roles' | 't'>, steps: readonly PlanStep[]): boolean {
  return steps.some((s) => {
    if (s.disposition.kind !== 'kept') return false
    if (s.tree === 'T') return f.t.present
    if (s.tree === 'OP') return false
    return f.roles[s.tree].kind === 'source'
  })
}

/** The finish lines a plan states (see the module comment). */
export function finishLines(f: FinishFacts, sourceKept: boolean): string[] {
  if (!sourceKept) return recordedOneDevice(f)
  return [
    `on one device: ${recordedOneDevice(f).join(', then ')}`,
    `if a copy crosses devices: ${recordedAcross(f).join(', then ')}`,
  ]
}
