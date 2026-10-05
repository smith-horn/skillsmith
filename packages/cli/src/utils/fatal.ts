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
 * It became reachable when SMI-6961 stopped `openCliDatabase` from swallowing
 * corruption refusals. Two of `search.action.ts`'s opens sit outside any `try`,
 * so a corrupt database on `skillsmith search` took exactly this route. Fixing
 * only those two call sites would have been fixing the instance; a command added
 * later with the same shape would reintroduce it. This fixes the mechanism.
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
 * `process.exitCode` rather than `process.exit()`: it lets stdout and stderr
 * flush. `process.exit()` can truncate a multi-line message mid-write on a
 * piped stream, and the corruption refusal is the longest message this CLI
 * prints — truncating it would cut off the `mv` commands that are the whole
 * point of it.
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
