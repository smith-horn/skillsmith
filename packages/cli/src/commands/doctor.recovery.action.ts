/**
 * @fileoverview `skillsmith doctor recovery --apply <opId>` / `--undo <opId>` /
 * `--abandon <opId>` / `--park <opId>` / `--clean-staging <opId>`, under the
 * confirmation contract (A1 plan §3.9; SMI-6531
 * steps 6a-ii and 6a-iii: one device and across devices, where the op dir
 * holding the verified sources is parked once its metadata is unlinked, UD28;
 * 6b-i: `--park`, which sets aside the whole op dir of a record that cannot be
 * read, the only remedy for `recovery-record-unreadable`; 6b-ii:
 * `--clean-staging`, which keeps or parks what an op dir with no record holds,
 * only when its `owner.json` owner is same-host and gone, or with
 * `--unsafe-unverified-owner`, which the plan explains and `--yes` never
 * stands in for; the one exception is a verifying park intent with no
 * `owner.json` left, which needs neither a gone owner nor the flag; 6b-iii:
 * `--abandon`, which keeps the trees of a verified op that `--apply` and
 * `--undo` can't act on and removes only its metadata). Every action runs
 * the same contract; the plan and result lines are
 * `doctor.recovery.action.render.ts`'s.
 *
 * The contract, in order:
 *  0. A flag given with an action it does not apply to exits 1 before any
 *     discovery or planning: `--unsafe-unverified-owner` without
 *     `--clean-staging`, and `--accept-identity` with an action outside
 *     core's `ACCEPT_IDENTITY_ACTIONS` (`--apply`, `--undo`).
 *  1. Plan without any lock (`planRecovery`) and print it (`--json`: as JSON).
 *     A refusal (`recovery-other-user` first, then targeting and the row's own
 *     words) prints why and exits 1, except `already-parked` (report only),
 *     which prints why and exits 0; nothing was locked.
 *  2. Ask once, default No (`Proceed? [y/N]`), only when stdin and stdout are
 *     terminals and `--json` is not given; the prompt runs before lock 1 and
 *     asserts no skills-root lock is held.
 *  3. No, empty input or EOF exit 0; Ctrl-C exits 130. Nothing changed.
 *  4. No terminal, or `--json`, without `--yes`: the plan is printed and the
 *     command exits 3 with nothing changed.
 *  5. `--yes` skips the prompt and waives no check.
 *  6. `executeRecovery` takes lock 1, re-plans and compares digests; a
 *     difference is `plan-changed` with zero mutation (exit 1).
 *  7. A kill after confirmation resumes with the same command, except a kill
 *     right after the park's move: at `afterPark` the park's post-move syncs
 *     have not run, at `afterParkSync` they have. Either way the op dir is
 *     gone, so the rerun only reports `already-parked` (exit 0) and syncs
 *     nothing.
 *
 * Exit status: 0 done, declined, or already set aside (`already-parked`: doctor
 * takes no action), 1 refused or stopped, 3 not confirmed
 * (no terminal), 4 done but the op dir's park did not finish
 * (`removal-not-done`, UD32; 1 wins over 4: `--park` itself ending `kept`,
 * `stopped` or `held`, or the op dir's park of `--apply`, `--undo`,
 * `--abandon` or `--clean-staging`),
 * 130 interrupted.
 * @module @skillsmith/cli/commands/doctor.recovery.action
 */

import chalk from 'chalk'
import {
  ACCEPT_IDENTITY_ACTIONS,
  acceptsIdentity,
  discoverRoots,
  executeRecovery,
  planRecovery,
  type DiscoverOptions,
  type RecoveryAction,
  type RecoveryRequest,
  type ListBackupsOptions,
  type ParkedUsageOptions,
  type RecoveryRunOptions,
  type RecoveryRunResult,
} from '@skillsmith/core'
import { confirmOrStop, type PromptAnswer } from './confirm-gate.js'
import { planLines, resultLines } from './doctor.recovery.action.render.js'
import { printParkedUsageWarning } from './doctor.backups.js'

export interface RecoveryActionOptions {
  apply?: string
  undo?: string
  /** `--park <opId>` (6b-i): set aside an op dir whose record cannot be read. */
  park?: string
  /** `--clean-staging <opId>` (6b-ii): keep or park what an op dir with no record holds. */
  cleanStaging?: string
  /** `--abandon <opId>` (6b-iii): set aside a verified op that `--apply` and `--undo` can't act on. */
  abandon?: string
  /**
   * `--unsafe-unverified-owner` (6b-ii): with `--clean-staging` only, act past
   * an `owner.json` whose owner is not shown gone. `--yes` never stands in for it.
   */
  unsafeUnverifiedOwner?: boolean
  root?: string[]
  stateRoot?: string
  acceptIdentity?: boolean
  yes?: boolean
  json?: boolean
  /** @internal Test seam: overrides for root discovery. */
  discovery?: Partial<DiscoverOptions>
  /** @internal Test seam: whether stdin and stdout are terminals. */
  isTTY?: () => boolean
  /** @internal Test seam: the prompt (default: one readline question on the terminal). */
  prompt?: (question: string) => Promise<PromptAnswer>
  /** @internal Test seam: runs between the confirmation and lock 1. */
  afterConfirm?: () => void | Promise<void>
  /** @internal Test seam: passed to `executeRecovery` (a park stub, hooks). */
  runOptions?: RecoveryRunOptions
  /** @internal Test seam (UD66): the space warning's `statfs` and thresholds. */
  parkedUsage?: ParkedUsageOptions
  /** @internal Test seam (UD66): replaces the size walk of the warning's listing. */
  measure?: ListBackupsOptions['measure']
  /** @internal Test seam: merged into the request (the owner probe, the effective uid). */
  request?: Partial<Pick<RecoveryRequest, 'ownerProbe' | 'euid'>>
}

export { askOnce, isInteractive } from './confirm-gate.js'
export type { PromptAnswer, PromptIO } from './confirm-gate.js'

/** UD32: a park that did not finish is exit 4 (an action that stopped or was refused is 1, which wins). */
const exitOf = (r: RecoveryRunResult): number | undefined =>
  r.status !== 'done' ? 1 : r.warnings.some((w) => w.code === 'removal-not-done') ? 4 : undefined

/**
 * D8 (UD66): whether the run set a folder aside: a kept `OP` tree, an extra
 * copy of the op dir, a held park (a `removal-not-done` warning naming where
 * it was parked), or a stop after the park's rename (the op dir is gone).
 */
export function parked(r: RecoveryRunResult): boolean {
  if (r.status === 'done') {
    return (
      r.kept.some((k) => k.tree === 'OP') ||
      r.extraCopy !== null ||
      r.warnings.some((w) => w.code === 'removal-not-done' && typeof w.parkedPath === 'string')
    )
  }
  return r.status === 'stopped' && r.opDir?.stillThere === false
}

const printLines = (lines: string[]): void => {
  for (const l of lines) console.log(l)
}

/** `--json` prints exactly one document: the plan (null when targeting refused) and the result. */
const printJson = (plan: unknown, result: unknown): void => {
  console.log(JSON.stringify({ plan, result }, null, 2))
}

/**
 * `--accept-identity` given where it does not apply (another action, or the
 * listing): says which actions take it, from core's table, and exits 1.
 */
export function refuseAcceptIdentity(): void {
  const allowed = ACCEPT_IDENTITY_ACTIONS.map((a) => `--${a} <opId>`).join(' or ')
  console.error(chalk.red(`--accept-identity applies only with ${allowed}.`))
  process.exitCode = 1
}

/** Every action this command dispatches, in flag order, each with the option commander gives it. */
const DISPATCHED = [
  ['apply', 'apply'],
  ['undo', 'undo'],
  ['abandon', 'abandon'],
  ['park', 'park'],
  ['clean-staging', 'cleanStaging'],
] as const satisfies ReadonlyArray<readonly [RecoveryAction, keyof RecoveryActionOptions]>

/** The one action given, or null when none or more than one is. */
function actionOf(options: RecoveryActionOptions): { action: RecoveryAction; opId: string } | null {
  const given = DISPATCHED.filter(([, key]) => options[key] !== undefined)
  if (given.length !== 1) return null
  const [action, key] = given[0]!
  return { action, opId: options[key]! }
}

/** `--apply` / `--undo` / `--abandon` / `--park` / `--clean-staging`: plan, confirm, then act under lock 1. */
export async function runRecoveryAction(options: RecoveryActionOptions): Promise<void> {
  const json = options.json === true
  const chosen = actionOf(options)
  if (chosen === null) {
    console.error(
      chalk.red(
        'Give exactly one of --apply <opId>, --undo <opId>, --abandon <opId>, --park <opId> and --clean-staging <opId>.'
      )
    )
    process.exitCode = 1
    return
  }
  const { action, opId } = chosen
  if (options.unsafeUnverifiedOwner === true && action !== 'clean-staging') {
    console.error(chalk.red('--unsafe-unverified-owner applies only with --clean-staging <opId>.'))
    process.exitCode = 1
    return
  }
  if (options.acceptIdentity === true && !acceptsIdentity(action)) {
    refuseAcceptIdentity()
    return
  }
  const found = await discoverRoots({
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    ...(options.root === undefined || options.root.length === 0 ? {} : { roots: options.root }),
    ...options.discovery,
  })
  const narrowed =
    options.root !== undefined && options.root.length === 1 ? options.root[0] : undefined
  const planned = await planRecovery({
    action,
    opId,
    roots: found.roots.map((r) => r.root),
    stateRoots: found.stateRoots,
    ...(narrowed === undefined ? {} : { root: narrowed }),
    ...(options.acceptIdentity === true ? { acceptIdentity: true } : {}),
    ...(options.unsafeUnverifiedOwner === true ? { unsafeUnverifiedOwner: true } : {}),
    ...options.request,
  })
  if (planned.status !== 'planned') {
    if (json) printJson(null, planned)
    else printLines(resultLines(planned))
    // Already set aside: doctor takes no action, so not a failure (as a declined
    // prompt exits 0). Every other refusal is 1.
    process.exitCode = planned.reason === 'already-parked' ? 0 : 1
    return
  }
  const plan = {
    status: 'planned',
    opDir: planned.opDir,
    label: planned.report.label,
    plan: planned.plan,
  }
  if (!json) printLines(planLines(planned))
  const gate = await confirmOrStop(options, () => printJson(plan, null), 'doctor recovery: prompt')
  if (gate === 'stop') return
  await options.afterConfirm?.()
  // UD66: a throw from the action (after a park's rename) or from printing its result must not
  // skip the warning, so it runs in `finally`: when the run says it parked, and also when it
  // never returned (the outcome is unknown after the user confirmed).
  let result: RecoveryRunResult | undefined
  try {
    result = await executeRecovery(planned, options.runOptions ?? {})
    if (json) printJson(plan, result)
    else printLines(resultLines(result))
    const code = exitOf(result)
    if (code !== undefined) process.exitCode = code
  } finally {
    if (result === undefined || parked(result)) {
      await printParkedUsageWarning({
        discovered: found,
        ...(options.parkedUsage === undefined ? {} : { parkedUsage: options.parkedUsage }),
        ...(options.measure === undefined ? {} : { measure: options.measure }),
      })
    }
  }
}
