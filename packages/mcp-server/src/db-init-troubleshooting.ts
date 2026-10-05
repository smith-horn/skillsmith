/**
 * @fileoverview What to print after a database-init failure, by failure kind.
 * @see SMI-6991, found in the post-merge retro of SMI-6961.
 *
 * **Why this is its own module.** `index.ts` runs `main().catch(...)` at module
 * scope, so importing it to test a decision would start the server. The
 * decision therefore lives here, where it is a pure function.
 *
 * **The defect.** The init catch printed one fixed troubleshooting block for
 * every failure, ending with *"Set SKILLSMITH_FORCE_WASM=true to use the WASM
 * SQLite fallback"*. That list is about driver **availability** — a native
 * module that will not load. A corruption refusal is a verdict about the
 * **file**, and since SMI-6961 both drivers refuse the same corrupt file, so
 * switching drivers is a dead end. It only ever appeared to help because the
 * WASM driver used to destroy the file, which is the defect SMI-6961 removed.
 *
 * So the last thing a user read after a correct refusal was advice that cannot
 * work, sending them after a configuration problem they do not have — and this
 * is the npx path, where WASM is already the default driver.
 */
import { isCorruptDatabaseError } from '@skillsmith/core'

/** The availability block: a driver that will not load, not a damaged file. */
const DRIVER_AVAILABILITY = [
  '  - In Docker: Ensure container is running',
  '  - On macOS: sql.js WASM should load automatically',
  '  - Set SKILLSMITH_FORCE_WASM=true to use the WASM SQLite fallback',
].join('\n')

/**
 * The troubleshooting text for a database-init failure, or `null` when the
 * error already carries its own remedy and generic advice would mislead.
 *
 * Returns `null` for a corruption refusal. The refusal names the exact files
 * and commands, and no driver choice changes a damaged file — so there is
 * nothing to add, and the one thing the generic block would add is wrong.
 *
 * Discriminates on `code` via `isCorruptDatabaseError`, never on the message
 * and never on `instanceof`: the CLI and the MCP server can resolve separate
 * copies of `@skillsmith/core`, which breaks an identity check.
 */
export function troubleshootingFor(error: unknown): string | null {
  return isCorruptDatabaseError(error) ? null : DRIVER_AVAILABILITY
}

/**
 * The full stderr block for a database-init failure.
 *
 * Kept here with the decision so the two cannot drift: a caller that forgot the
 * `null` case would otherwise print the literal string "null" as advice.
 */
export function formatDbInitFailure(errorDetail: string, error: unknown): string {
  const troubleshooting = troubleshootingFor(error)
  return troubleshooting === null
    ? `[skillsmith] Failed to initialize database:\n${errorDetail}\n`
    : `[skillsmith] Failed to initialize database:\n${errorDetail}\n\nTroubleshooting:\n${troubleshooting}\n`
}
