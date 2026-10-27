/**
 * @fileoverview `skillsmith doctor recovery --apply <opId>` / `--undo <opId>`,
 * under the confirmation contract (A1 plan §3.9; SMI-6531 steps 6a-ii and
 * 6a-iii: one device and across devices, where the op dir holding the verified
 * sources is parked once its metadata is unlinked, UD28).
 *
 * The contract, in order:
 *  1. Plan without any lock (`planRecovery`) and print it (`--json`: as JSON).
 *     A refusal (`recovery-other-user` first, then targeting and the row's own
 *     words) prints why and exits 1; nothing was locked.
 *  2. Ask once, default No (`Proceed? [y/N]`), only when stdin and stdout are
 *     terminals and `--json` is not given; the prompt runs before lock 1 and
 *     asserts no skills-root lock is held.
 *  3. No, empty input or EOF exit 0; Ctrl-C exits 130. Nothing changed.
 *  4. No terminal, or `--json`, without `--yes`: the plan is printed and the
 *     command exits 3 with nothing changed.
 *  5. `--yes` skips the prompt and waives no check.
 *  6. `executeRecovery` takes lock 1, re-plans and compares digests; a
 *     difference is `plan-changed` with zero mutation (exit 1).
 *  7. A kill after confirmation resumes with the same command.
 *
 * Exit status: 0 done (or declined), 1 refused or stopped, 3 not confirmed
 * (no terminal), 4 done but the op dir's park did not finish
 * (`removal-not-done`, UD32; 1 wins over 4), 130 interrupted.
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
  type PlannedRecovery,
  type RecoveryRunOptions,
  type RecoveryRunResult,
} from '@skillsmith/core'

export type PromptAnswer = 'yes' | 'no' | 'interrupt'

export interface RecoveryActionOptions {
  apply?: string
  undo?: string
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

/** The plan's lines, as the prompt shows them. */
export function planLines(p: PlannedRecovery): string[] {
  const lines = [
    `Plan for ${p.request.action === 'apply' ? '--apply' : '--undo'} ${p.request.opId}`,
    `  op dir: ${p.opDir} (${p.report.label})`,
  ]
  for (const s of p.plan.steps) {
    const d = s.disposition
    lines.push(`  ${s.tree}: ${d.kind === 'kept' ? `kept as ${d.as}` : d.kind}; ${s.note}`)
  }
  lines.push(
    `  manifest: ${p.plan.manifest === 'untouched' ? 'untouched' : 'committed to the updated entry'}`
  )
  for (const r of p.plan.remaining) lines.push(`  then: ${r}`)
  for (const n of p.plan.notes) lines.push(`  note: ${n}`)
  if (p.request.acceptIdentity === true && 'facts' in p.report.cls && p.report.cls.facts) {
    const f = p.report.cls.facts
    const rec = f.record
    const now = (o: typeof f.t) =>
      o.present ? `${o.identity.dev}/${o.identity.ino}/${o.identity.birthtimeNs}` : 'absent'
    lines.push(
      `  identity (dev/ino/birthtime) recorded old ${rec.oldIdentity.dev}/${rec.oldIdentity.ino}/${rec.oldIdentity.birthtimeNs}, new ${rec.newIdentity.dev}/${rec.newIdentity.ino}/${rec.newIdentity.birthtimeNs}; T now ${now(f.t)}`
    )
  }
  return lines
}

function resultLines(r: RecoveryRunResult): string[] {
  if (r.status === 'refused')
    return [`Not done (${r.reason}): ${r.detail}`, ...r.paths.map((p) => `  ${p}`)]
  if (r.status === 'stopped') {
    return [
      `Stopped (${r.reason}): ${r.detail}`,
      r.recordPath === null
        ? '  the record is gone; run the same command to finish'
        : `  the record is kept at ${r.recordPath}; run the same command again to resume`,
    ]
  }
  const lines = [`Done: ${r.action} of ${r.opId} (from ${r.from}).`]
  if (r.installed !== null) lines.push(`  installed: ${r.installed}`)
  for (const k of r.kept) lines.push(`  kept ${k.tree} as ${k.kind} at ${k.path}`)
  if (r.extraCopy !== null) {
    lines.push(
      `  the op dir, holding the verified source copies, was moved aside to ${r.extraCopy}`
    )
  }
  lines.push(`  manifest: ${r.manifest}`)
  if (r.audit.kind === 'not-recorded') lines.push(`  ${r.audit.detail}`)
  for (const w of r.warnings) lines.push(...warningLines(w, r.opId))
  for (const p of r.swept.removed) lines.push(`  removed the empty directory ${p}`)
  for (const p of r.swept.left) lines.push(`  left ${p.path} (${p.errno})`)
  return lines
}

type Warning = Extract<RecoveryRunResult, { status: 'done' }>['warnings'][number]

/** A warning's line; `removal-not-done` names the op dir, the park's status and what finishes it. */
function warningLines(w: Warning, opId: string): string[] {
  if (w.code !== 'removal-not-done') return [`  warning: ${w.code}`]
  const errno = w.errno === undefined ? '' : ` (${w.errno})`
  const where =
    w.status === 'held' ? `; it was moved to ${String(w.parkedPath)} and is held there` : ''
  return [
    `  warning: removal-not-done: the op dir ${w.path} was not set aside (${w.status}/${w.reason}${errno})${where}`,
    ...(w.detail === undefined ? [] : [`    ${w.detail}`]),
    ...(w.status === 'held'
      ? ['    it may have changed while it moved: check it before relying on it']
      : [`    run \`skillsmith doctor recovery --clean-staging ${opId}\` to finish it`]),
  ]
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

/** `--apply` / `--undo`: plan, confirm, then act under lock 1. */
export async function runRecoveryAction(options: RecoveryActionOptions): Promise<void> {
  const json = options.json === true
  if ((options.apply === undefined) === (options.undo === undefined)) {
    console.error(chalk.red('Give exactly one of --apply <opId> and --undo <opId>.'))
    process.exitCode = 1
    return
  }
  const action = options.apply !== undefined ? 'apply' : 'undo'
  const opId = (options.apply ?? options.undo)!
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
    ...(narrowed === undefined ? {} : { root: narrowed }),
    ...(options.acceptIdentity === true ? { acceptIdentity: true } : {}),
  })
  if (planned.status !== 'planned') {
    if (json) printJson(null, planned)
    else printLines(resultLines(planned))
    process.exitCode = 1
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
