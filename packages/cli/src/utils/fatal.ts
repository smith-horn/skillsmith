/**
 * @fileoverview Last-resort rendering for an error that escaped a command.
 * @see SMI-6961 review finding F6.
 *
 * **The gap this closes.** `program.parse()` does not await an async action's
 * promise, so a rejection from one became an unhandled rejection: Node printed
 * the error's full message plus a stack and a source frame, then exited. That
 * path never reached `sanitizeError`, so an absolute home path in the message
 * was printed verbatim — which is the one thing `sanitize.ts` exists to prevent.
 *
 * **This is a backstop, and its original justification named the wrong
 * instance** (SMI-6991). An earlier version of this comment said two of
 * `search.action.ts`'s opens "sit outside any `try`", so a corrupt database on
 * `skillsmith search` took this route. Measured: those opens are awaited inside
 * `searchActionImpl`'s own `try`, whose catch calls `sanitizeError` and
 * `process.exit(1)`. They sit outside their *immediate* function's try, which
 * is not the same thing — the mechanism-vs-reachability split CLAUDE.md records
 * from SMI-6733.
 *
 * So no command is known to reach this handler today. It is kept anyway,
 * because the failure it prevents is unbounded: any rejection that escapes a
 * command's own catch would otherwise print Node's raw message and stack, and
 * `parse()` would not even await it. A backstop whose current reachability is
 * zero is still the right shape — what was wrong was claiming an instance.
 *
 * Rendering lives here rather than inline in `index.ts` so it can be tested
 * without running the whole CLI.
 */
import { sanitizeError } from './sanitize.js'

/**
 * The text to print for an error no command handled.
 *
 * Returns a string rather than printing, so a test can assert on it. The
 * message is sanitized; the stack is dropped entirely. A stack is the wrong
 * thing to show a user for an expected-but-fatal condition like a corrupt
 * database, and it is also the part most likely to carry filesystem paths the
 * sanitizer does not reach.
 */
export function renderFatal(error: unknown): string {
  return sanitizeError(error)
}

/**
 * Install the handler. Call AFTER `parseAsync` is wired, before parsing.
 *
 * `process.exitCode` rather than `process.exit()`, because it does not cut the
 * process short: anything already queued still writes, and control returns to
 * the caller rather than ending mid-function.
 *
 * **An earlier version of this comment overstated the case** (SMI-6991). It
 * asserted that `process.exit()` "can truncate a multi-line message mid-write
 * on a piped stream" and used the corruption refusal as the example. That was
 * reasoning, not measurement, and it put this file in conflict with the many
 * `catch` blocks that print the same refusal and then call `process.exit(1)`.
 * (An earlier version of this note counted five; the real number is larger, and
 * a count in a comment is the thing SMI-6991 retired one file over. A larger
 * conflicting set strengthens the withdrawal below, not weakens it.)
 *
 * Measured instead: `skillsmith info` against a corrupt database, piped through
 * `cat` and written directly, produced **identical 1217-byte output with all
 * three `mv` lines present** in both. So the refusal is not truncated at its
 * current size and those sites carry no defect. Truncation on exit is a
 * real Node hazard for large asynchronous writes to a pipe; it is not what
 * happens here, and the claim should not be restated without a measurement
 * that reproduces it.
 *
 * `exitCode` remains the right choice for a handler — it composes rather than
 * terminating — but that is a design preference, not a bug fix.
 */
export function installFatalHandler(
  write: (text: string) => void = (text) => process.stderr.write(text)
): (error: unknown) => void {
  const handler = (error: unknown): void => {
    write(`${renderFatal(error)}\n`)
    process.exitCode = 1
  }
  process.on('unhandledRejection', handler)
  process.on('uncaughtException', handler)
  return handler
}
