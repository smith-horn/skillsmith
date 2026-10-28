/**
 * SMI-6531 (A1 step 5): transaction step 3, the record scan under lock 1
 * (plan §3.3 step 3, R1, UD8). It runs before every transaction's step 4, so
 * a record a crashed process left is always seen. A refusal runs abort
 * cleanup (`resultOfFailure`), which removes nothing; the scan itself
 * changes nothing.
 *
 * Precedence: a staging listing that fails stops `staging-unsafe`; then any
 * unreadable record (`recovery-record-unreadable`, the whole root); then a
 * verified record naming this skill (`recovery-pending`, this skill only).
 * The messages are §3.9's.
 *
 * A step-1 failure's abort cleanup runs the same scan under the lock 1 it
 * takes (owner decision 2026-10-24, T-X2): after a crash between the renames
 * the live folder is gone, so the build fails before step 2, and without this
 * the refusal would name the build's reason instead of the unfinished update.
 *
 * @module @skillsmith/core/services/skill-swap.scan
 */
import { SwapFault, trace } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { recordsNaming, scanStagingRecords } from './skill-swap.records.js'

const DOCTOR_RECOVERY = 'skillsmith doctor recovery'

const parkCommand = (opIds: readonly string[]): string =>
  opIds.length === 1
    ? `\`skillsmith doctor recovery --park ${opIds[0]}\``
    : `\`skillsmith doctor recovery --park <opId>\` for each of ${opIds.join(', ')}`

/** Step 3. Throws `SwapFault` (`staging-unsafe`, `recovery-record-unreadable`, `recovery-pending`). */
export async function refuseIfRecorded(st: SwapState): Promise<void> {
  const fault = await recordedRefusal(st)
  if (fault !== null) throw fault
}

/**
 * For a step-1 failure, under lock 1: the `recovery-*` refusal that replaces
 * the build's reason, or null. A listing failure keeps the build's reason.
 */
export async function recordedReason(
  st: SwapState
): Promise<{ reason: RecoveryReason; detail: string } | null> {
  const fault = await recordedRefusal(st)
  if (fault === null || !isRecoveryReason(fault.reason)) return null
  return { reason: fault.reason, detail: fault.detail }
}

type RecoveryReason = 'recovery-pending' | 'recovery-record-unreadable'
const isRecoveryReason = (r: string): r is RecoveryReason =>
  r === 'recovery-pending' || r === 'recovery-record-unreadable'

/** The scan's refusal, or null when nothing blocks this write. Sets `st.blockedBy`. */
async function recordedRefusal(st: SwapState): Promise<SwapFault | null> {
  const { root, stagingDir } = st.binding
  const scan = await scanStagingRecords(root, stagingDir)
  if (!scan.ok) {
    return new SwapFault(
      'staging-unsafe',
      `the update records in ${stagingDir} could not be listed (${scan.path}: ${scan.errno})`
    )
  }
  trace(st, { op: 'record-scan', path: stagingDir })
  if (scan.unreadable.length > 0) {
    const opIds = scan.unreadable.map((r) => r.opId)
    st.blockedBy = opIds
    // A record that verifies but names another root or op dir (a copied or
    // moved root) is `recovery-moved` to doctor, which lists it: parking it is
    // not what its remedy is (§3.9). Every other kind is parked.
    const isMoved = (why: string): boolean => why === 'foreign-root' || why === 'foreign-op-dir'
    // 6b-i (Q7, C9): a record this user may not open is another user's update.
    // Doctor classifies it `other-user` and refuses `--park`, so it names the user instead.
    const isDenied = (r: (typeof scan.unreadable)[number]): boolean =>
      r.why === 'open-failed' && (r.errno === 'EACCES' || r.errno === 'EPERM')
    const parkIds = scan.unreadable
      .filter((r) => !isMoved(r.why) && !isDenied(r))
      .map((r) => r.opId)
    const movedIds = scan.unreadable.filter((r) => isMoved(r.why)).map((r) => r.opId)
    const deniedIds = scan.unreadable.filter(isDenied).map((r) => r.opId)
    const advice = [
      ...(parkIds.length > 0 ? [`Run ${parkCommand(parkIds)}.`] : []),
      ...(deniedIds.length > 0
        ? [
            `${deniedIds.join(', ')} ${deniedIds.length === 1 ? 'is' : 'are'} another user's ` +
              `update; run \`${DOCTOR_RECOVERY}\` as that user.`,
          ]
        : []),
      ...(movedIds.length > 0
        ? [
            parkIds.length > 0
              ? `Run \`${DOCTOR_RECOVERY}\` for ${movedIds.join(', ')}.`
              : `Run \`${DOCTOR_RECOVERY}\`.`,
          ]
        : []),
    ].join(' ')
    return new SwapFault(
      'recovery-record-unreadable',
      `A record of an unfinished update in ${root} can't be read, so no skill in that folder can ` +
        `be changed until it is inspected. ${advice}`
    )
  }
  const naming = recordsNaming(scan.pending, st.input)
  if (naming.length > 0) {
    st.blockedBy = naming.map((r) => r.opId)
    return new SwapFault(
      'recovery-pending',
      `The last update of ${st.input.comparedPath} did not finish. Only this skill is blocked. ` +
        'Run `skillsmith doctor recovery` to finish or undo it.'
    )
  }
  return null
}
