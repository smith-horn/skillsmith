/**
 * @fileoverview `skillsmith doctor recovery --apply <opId>` / `--undo <opId>`
 * on one device, under the confirmation contract (A1 plan §3.9; SMI-6531 step
 * 6a-ii, an internal milestone: the options are registered hidden and no
 * message names them until 6a-iii).
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
 * (no terminal), 130 interrupted.
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
}

/** One question on the terminal: `y`/`yes` is yes; anything else, EOF included, is no; Ctrl-C interrupts. */
export function askOnce(question: string): Promise<PromptAnswer> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
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
  lines.push(`  manifest: ${r.manifest}`)
  if (r.audit.kind === 'not-recorded') lines.push(`  ${r.audit.detail}`)
  for (const w of r.warnings) lines.push(`  warning: ${w.code}`)
  for (const p of r.swept.removed) lines.push(`  removed the empty directory ${p}`)
  for (const p of r.swept.left) lines.push(`  left ${p.path} (${p.errno})`)
  return lines
}

const print = (json: boolean, value: unknown, lines: string[]): void => {
  if (json) console.log(JSON.stringify(value, null, 2))
  else for (const l of lines) console.log(l)
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
    print(json, planned, resultLines(planned))
    process.exitCode = 1
    return
  }
  print(
    json,
    { status: 'planned', opDir: planned.opDir, label: planned.report.label, plan: planned.plan },
    planLines(planned)
  )
  if (options.yes !== true) {
    const tty = options.isTTY?.() ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
    if (json || !tty) {
      if (!json) console.log('Nothing changed: confirm with --yes, or run this at a terminal.')
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
  const result = await executeRecovery(planned)
  print(json, result, resultLines(result))
  if (result.status !== 'done') process.exitCode = 1
}
