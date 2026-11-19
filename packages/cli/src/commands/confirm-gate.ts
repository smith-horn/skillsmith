/**
 * @fileoverview The confirmation contract shared by `skillsmith doctor recovery`
 * and `skillsmith restore` (A1 plan §3.9 items 2-5; SMI-6531 6d-ii, D2): the
 * `--yes` skip, the no-terminal / `--json` exit 3, the lock-not-held assertion
 * before the prompt, and the 130 / 0 mapping. Callers print their own plan
 * first and call {@link confirmOrStop}; a `'stop'` means the exit code is set
 * and nothing may be taken or changed.
 * @module @skillsmith/cli/commands/confirm-gate
 */

import { createInterface } from 'node:readline'
import { assertSkillWriteLockNotHeld } from '@skillsmith/core'

export type PromptAnswer = 'yes' | 'no' | 'interrupt'

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

export interface ConfirmGateOptions {
  yes?: boolean
  json?: boolean
  /** @internal Test seam: whether stdin and stdout are terminals. */
  isTTY?: () => boolean
  /** @internal Test seam: the prompt (default: one readline question on the terminal). */
  prompt?: (question: string) => Promise<PromptAnswer>
}

/**
 * Items 2-5 of the contract. `printJsonPlan` prints the `--json` plan document
 * for the no-terminal / `--json` stop; `promptLabel` names the caller in the
 * lock-not-held assertion. Sets `process.exitCode` itself when it stops.
 */
export async function confirmOrStop(
  options: ConfirmGateOptions,
  printJsonPlan: () => void,
  promptLabel: string
): Promise<'proceed' | 'stop'> {
  if (options.yes === true) return 'proceed'
  const tty = options.isTTY?.() ?? isInteractive()
  if (options.json === true || !tty) {
    if (options.json === true) printJsonPlan()
    else console.log('Nothing changed: confirm with --yes, or run this at a terminal.')
    process.exitCode = 3
    return 'stop'
  }
  // Item 2: the prompt is never shown while a skills-root lock is held.
  assertSkillWriteLockNotHeld(promptLabel)
  const answer = await (options.prompt ?? askOnce)('Proceed? [y/N] ')
  if (answer === 'interrupt') {
    process.exitCode = 130
    return 'stop'
  }
  if (answer !== 'yes') {
    console.log('Nothing changed.')
    process.exitCode = 0
    return 'stop'
  }
  return 'proceed'
}
