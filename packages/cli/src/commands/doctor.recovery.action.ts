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

import { createInterface } from 'node:readline'
import chalk from 'chalk'
import {
  assertSkillWriteLockNotHeld,
  discoverRoots,
  executeRecovery,
  planRecovery,
  type DiscoverOptions,
  type RecoveryAction,
  type RecoveryRequest,
  type RecoveryRunOptions,
  type RecoveryRunResult,
} from '@skillsmith/core'
import { planLines, resultLines } from './doctor.recovery.action.render.js'

export type PromptAnswer = 'yes' | 'no' | 'interrupt'

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
  /** @internal Test seam: merged into the request (the owner probe, the effective uid). */
  request?: Partial<Pick<RecoveryRequest, 'ownerProbe' | 'euid'>>
}

/** The streams `askOnce` talks to (default: the process's terminal). */
export interface PromptIO {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  /** Treat the streams as a terminal (Ctrl-C is SIGINT); default: readline's own detection. */
  terminal?: boolean
}

/** The prompt runs only when both stdin and stdout are terminals (§3.9 item 2). */
export function isInteractive(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true
}

/** One question on the terminal: `y`/`yes` is yes; anything else, EOF included, is no; Ctrl-C interrupts. */
export function askOnce(
  question: string,
  io: PromptIO = { input: process.stdin, output: process.stdout }
): Promise<PromptAnswer> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: io.input,
      output: io.output,
      ...(io.terminal === undefined ? {} : { terminal: io.terminal }),
    })
    let settled = false
    const done = (a: PromptAnswer): void => {
      if (settled) return
      settled = true
      rl.close()
      resolve(a)
    }
    rl.on('SIGINT', () => done('interrupt'))
    rl.on('close', () => done('no'))
    rl.question(question, (answer) => done(/^y(es)?$/i.test(answer.trim()) ? 'yes' : 'no'))
  })
}

/** UD32: a park that did not finish is exit 4 (an action that stopped or was refused is 1, which wins). */
const exitOf = (r: RecoveryRunResult): number | undefined =>
  r.status !== 'done' ? 1 : r.warnings.some((w) => w.code === 'removal-not-done') ? 4 : undefined

const printLines = (lines: string[]): void => {
  for (const l of lines) console.log(l)
}

/** `--json` prints exactly one document: the plan (null when targeting refused) and the result. */
const printJson = (plan: unknown, result: unknown): void => {
  console.log(JSON.stringify({ plan, result }, null, 2))
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
  if (options.yes !== true) {
    const tty = options.isTTY?.() ?? isInteractive()
    if (json || !tty) {
      if (json) printJson(plan, null)
      else console.log('Nothing changed: confirm with --yes, or run this at a terminal.')
      process.exitCode = 3
      return
    }
    // Item 2: the prompt is never shown while a skills-root lock is held.
    assertSkillWriteLockNotHeld('doctor recovery: prompt')
    const answer = await (options.prompt ?? askOnce)('Proceed? [y/N] ')
    if (answer === 'interrupt') {
      process.exitCode = 130
      return
    }
    if (answer !== 'yes') {
      console.log('Nothing changed.')
      process.exitCode = 0
      return
    }
  }
  await options.afterConfirm?.()
  const result = await executeRecovery(planned, options.runOptions ?? {})
  if (json) printJson(plan, result)
  else printLines(resultLines(result))
  const code = exitOf(result)
  if (code !== undefined) process.exitCode = code
}
