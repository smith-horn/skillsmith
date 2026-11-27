/**
 * SMI-7260: what Skillsmith tells the user about a database the WASM (sql.js)
 * driver opened, and the error it throws when something tries to write one.
 *
 * A file-backed sql.js handle never writes to disk (see
 * `drivers/sqljsDriver.ts`). The notice and the error share one explanation of
 * why, and one remedy, built here so the two cannot drift apart. When
 * `SKILLSMITH_FORCE_WASM` is set the remedy names that variable instead of the
 * reinstall advice, because reinstalling would not change anything. Otherwise
 * the remedy follows the measured load failure (SMI-7271): a missing package
 * needs a reinstall with optional dependencies, a binary that failed to load
 * needs a rebuild.
 */

import { DatabaseReadOnlyDriverError } from './db-errors.js'
import { getBetterSqlite3FailureKind } from './drivers/betterSqlite3Driver.js'

/** Which situation a read-only sql.js handle was opened in. */
export type WasmOpenKind = 'existing' | 'first-run'

/** SQLite's own message for a write on a `query_only` handle. */
const SQLITE_READONLY_MESSAGE = 'attempt to write a readonly database'

function forced(): boolean {
  return process.env.SKILLSMITH_FORCE_WASM === 'true'
}

/** Why the WASM driver is in use, and what it cannot do. Starts lower-case. */
function driverClause(): string {
  const why = forced()
    ? 'SKILLSMITH_FORCE_WASM is set'
    : 'the native SQLite driver (better-sqlite3) did not load'
  return `${why}, so Skillsmith is using the WASM driver, which can read but not save.`
}

const DEBUG_HINT = 'Set SKILLSMITH_DEBUG=1 to see why it did not load.'

/**
 * SMI-7271: the fix depends on how the native driver failed, not on which
 * package bundled core. The CLI's better-sqlite3 ships prebuilt binaries and
 * has no install script, so "rebuild" does nothing for an install that skipped
 * the package; the MCP server's builds through an install script, so a rebuild
 * is its fix when the package is present but its binary did not load. When the
 * CLI's package has no prebuilt binary for the platform, nothing can be built,
 * so that case names the platform and the supported ones instead.
 */
function remedy(): string {
  if (forced()) return 'Unset SKILLSMITH_FORCE_WASM to use the native driver.'
  switch (getBetterSqlite3FailureKind()) {
    case 'not-installed':
      return (
        'better-sqlite3 is not installed: reinstall Skillsmith without --omit=optional ' +
        '(optional dependencies must be installed), then restart.'
      )
    case 'no-prebuilt':
      // better-sqlite3 13 never builds from source, so no rebuild advice here.
      return (
        `No prebuilt native SQLite driver exists for this platform (${process.platform}-` +
        `${process.arch}), so here the WASM driver reads but cannot save. Prebuilt drivers ` +
        'cover darwin, linux, linuxmusl and win32, on x64 or arm64; on one of those, the ' +
        `install is incomplete: reinstall Skillsmith, then restart. ${DEBUG_HINT}`
      )
    case 'load-failed':
      return (
        'To fix it, run `npm rebuild better-sqlite3`, or reinstall Skillsmith with install ' +
        `scripts enabled, then restart. ${DEBUG_HINT}`
      )
    default:
      // The load was never attempted in this process, so the cause is unknown.
      return (
        'To fix it, reinstall Skillsmith with optional dependencies and install scripts ' +
        'enabled (or run `npm rebuild better-sqlite3`), then restart.'
      )
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The one stderr line printed when the WASM driver opens a file-backed database. */
export function wasmOpenNotice(path: string, kind: WasmOpenKind): string {
  if (kind === 'existing') {
    return `[Skillsmith] Opened ${path} read-only: ${driverClause()} ${remedy()}`
  }
  return (
    `[Skillsmith] No database exists yet at ${path}, and the WASM driver cannot create one; ` +
    'searches use the Skillsmith API and local results stay empty until the native driver ' +
    `creates the database. ${capitalized(driverClause())} ${remedy()}`
  )
}

/**
 * The refusal of a write to a database the WASM driver opened.
 *
 * @param situation - what was not done, as a sentence; defaults to the generic
 *   "not saved" case.
 */
export function wasmReadOnlyError(
  path: string,
  situation?: string,
  cause?: unknown
): DatabaseReadOnlyDriverError {
  const what = situation ?? `Not saved: ${path} is open read-only.`
  return new DatabaseReadOnlyDriverError({
    message: `[Skillsmith] ${what} ${capitalized(driverClause())} ${remedy()}`,
    path,
    cause,
  })
}

/**
 * Rethrow a sql.js error, translated to `DatabaseReadOnlyDriverError` when it is
 * SQLite's `query_only` refusal on a sealed handle. Matches SQLite's whole
 * message, not a substring (see sqljsDriver.corruption.ts for why).
 */
export function rethrowSqlJsWriteError(error: unknown, path: string, sealed: boolean): never {
  const message = error instanceof Error ? error.message : String(error)
  if (sealed && message === SQLITE_READONLY_MESSAGE) throw wasmReadOnlyError(path, undefined, error)
  throw error
}
