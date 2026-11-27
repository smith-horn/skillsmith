/**
 * SMI-7260: what Skillsmith tells the user about a database the WASM (sql.js)
 * driver opened, and the error it throws when something tries to write one.
 *
 * A file-backed sql.js handle never writes to disk (see
 * `drivers/sqljsDriver.ts`). The notice and the error share one explanation of
 * why, and one remedy, built here so the two cannot drift apart.
 *
 * SMI-7271: the remedy follows what the installed better-sqlite3 package can
 * do (`drivers/native-driver-advice.ts`), never the shape of its load error: a
 * package that is not installed needs a reinstall with optional dependencies; a
 * package that builds (12.x, the MCP server's) needs a rebuild; a prebuilt-only
 * package (13.x, the CLI's) is never told to rebuild, and is told instead that
 * no binary exists for the platform, that the one there needs a newer glibc,
 * or that the one there did not load. When
 * `SKILLSMITH_FORCE_WASM` is set the remedy names that variable, because
 * reinstalling would not change anything.
 *
 * The advice is captured once, when the sql.js handle opens
 * ({@link captureWasmAdvice}), and every later render for that handle (its
 * notice, `readOnlyReason`, and write refusals) uses the captured value, so a
 * later probe or a changed environment cannot change what one handle says.
 */

import { DatabaseReadOnlyDriverError } from './db-errors.js'
import {
  nativeDriverAdvice,
  SUPPORTED_PREBUILDS,
  type NativeDriverAdvice,
} from './drivers/native-driver-advice.js'

/** Which situation a read-only sql.js handle was opened in. */
export type WasmOpenKind = 'existing' | 'first-run'

/** Why a sql.js handle is in use and what will get the native driver back. */
export type WasmAdvice = { kind: 'forced' } | NativeDriverAdvice

/** SQLite's own message for a write on a `query_only` handle. */
const SQLITE_READONLY_MESSAGE = 'attempt to write a readonly database'

/** The advice for a handle opening now. Called once per handle, at open. */
export function captureWasmAdvice(): WasmAdvice {
  return process.env.SKILLSMITH_FORCE_WASM === 'true' ? { kind: 'forced' } : nativeDriverAdvice()
}

/** Why the WASM driver is in use, and what it cannot do. Starts lower-case. */
function driverClause(advice: WasmAdvice | undefined): string {
  const why =
    advice?.kind === 'forced'
      ? 'SKILLSMITH_FORCE_WASM is set'
      : 'the native SQLite driver (better-sqlite3) did not load'
  return `${why}, so Skillsmith is using the WASM driver, which can read but not save.`
}

const DEBUG_HINT = 'Set SKILLSMITH_DEBUG=1 to see why it did not load.'

function remedy(advice: WasmAdvice | undefined): string {
  switch (advice?.kind) {
    case 'forced':
      return 'Unset SKILLSMITH_FORCE_WASM to use the native driver.'
    case 'not-installed':
      return (
        'better-sqlite3 is not installed: reinstall Skillsmith without --omit=optional ' +
        '(optional dependencies must be installed); if npm reported that better-sqlite3 failed ' +
        'to install, fix that error first (build tools, or a supported platform), then restart. ' +
        DEBUG_HINT
      )
    case 'rebuild':
      return (
        'To fix it, run `npm rebuild better-sqlite3`, or reinstall with install scripts ' +
        `enabled, then restart. ${DEBUG_HINT}`
      )
    case 'no-prebuilt':
      return (
        `No prebuilt native SQLite driver exists for this platform (${advice.target}); ` +
        `supported: ${SUPPORTED_PREBUILDS}. Here the WASM driver reads but cannot save. ` +
        DEBUG_HINT
      )
    case 'glibc-too-old':
      // No rebuild or reinstall: the prebuilt binary needs a newer glibc.
      return (
        `The prebuilt native SQLite driver for ${advice.target} needs glibc ${advice.required} ` +
        `or newer, and this system has glibc ${advice.runtime}, so here the WASM driver reads ` +
        `but cannot save. Upgrade to a distribution with glibc ${advice.required} or newer, or ` +
        `use the Skillsmith MCP server, whose native driver builds on older systems. ${DEBUG_HINT}`
      )
    case 'prebuilt-failed':
      return (
        `The prebuilt native SQLite driver for ${advice.target} failed to load (the file may ` +
        `be damaged): reinstall Skillsmith, then restart. ${DEBUG_HINT}`
      )
    default:
      // A handle with no captured advice: not opened by the sql.js driver, so
      // nothing is known about the installed package. Reinstalling is the one
      // step that is right for every install.
      return `To fix it, reinstall Skillsmith with its optional dependencies, then restart. ${DEBUG_HINT}`
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The one stderr line printed when the WASM driver opens a file-backed database. */
export function wasmOpenNotice(
  path: string,
  kind: WasmOpenKind,
  advice: WasmAdvice | undefined
): string {
  if (kind === 'existing') {
    return `[Skillsmith] Opened ${path} read-only: ${driverClause(advice)} ${remedy(advice)}`
  }
  return (
    `[Skillsmith] No database exists yet at ${path}, and the WASM driver cannot create one; ` +
    'searches use the Skillsmith API and local results stay empty until the native driver ' +
    `creates the database. ${capitalized(driverClause(advice))} ${remedy(advice)}`
  )
}

/**
 * The refusal of a write to a database the WASM driver opened.
 *
 * @param advice - the handle's captured advice (`nativeAdviceOf(db)`).
 * @param situation - what was not done, as a sentence; defaults to the generic
 *   "not saved" case.
 */
export function wasmReadOnlyError(
  path: string,
  advice: WasmAdvice | undefined,
  situation?: string,
  cause?: unknown
): DatabaseReadOnlyDriverError {
  const what = situation ?? `Not saved: ${path} is open read-only.`
  return new DatabaseReadOnlyDriverError({
    message: `[Skillsmith] ${what} ${capitalized(driverClause(advice))} ${remedy(advice)}`,
    path,
    cause,
  })
}

/**
 * Rethrow a sql.js error, translated to `DatabaseReadOnlyDriverError` when it is
 * SQLite's `query_only` refusal on a sealed handle. Matches SQLite's whole
 * message, not a substring (see sqljsDriver.corruption.ts for why).
 */
export function rethrowSqlJsWriteError(
  error: unknown,
  path: string,
  sealed: boolean,
  advice: WasmAdvice | undefined
): never {
  const message = error instanceof Error ? error.message : String(error)
  if (sealed && message === SQLITE_READONLY_MESSAGE) {
    throw wasmReadOnlyError(path, advice, undefined, error)
  }
  throw error
}
