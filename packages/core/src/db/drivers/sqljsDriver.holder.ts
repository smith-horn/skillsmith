/**
 * SMI-7260: the sql.js driver must never replace a database another process
 * may hold.
 *
 * **The rule.** If SQLite's own sidecar files (`-wal`, `-shm` or `-journal`)
 * exist beside the database, the sql.js handle is read-only: writes fail with
 * `DatabaseHeldElsewhereError` and the file is never rewritten. The check runs
 * at open AND again immediately before every rename, because a native process
 * can open the database after this one did.
 *
 * **Why those three files.** SQLite's documented WAL behaviour: the `-wal` and
 * `-shm` files exist for as long as any connection has a WAL database open, and
 * are normally deleted when the last connection closes. A `-wal` left by a
 * process that crashed holds committed transactions that are not yet in the
 * main file, so rewriting the main file around it is also unsafe — the next
 * native open would fold that WAL into a file it was not written for. A
 * `-journal` is the rollback-mode equivalent: a hot journal must be rolled back
 * before the main file is consistent, so sql.js (which reads only the main
 * file) would read and then save a half-written database. A WAL-mode header
 * with none of these files present means no connection is open and nothing is
 * pending: persisting is allowed.
 *
 * **Residual window.** sql.js takes no file locks, so the final check and the
 * rename are not atomic: a native process that opens the database in the
 * microseconds between them is not detected. Shipping the native driver (so
 * this path is a fallback, not the default) is the other half of SMI-7260.
 */

import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { DatabaseHeldElsewhereError } from '../db-errors.js'

/** SQLite's sidecar suffixes, in the order they are reported. */
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

/** sql.js's own message for a write under `PRAGMA query_only`. */
const SQLITE_READONLY_MESSAGE = 'attempt to write a readonly database'

/** Basenames of the SQLite sidecar files that currently exist beside `path`. */
export function sidecarsOf(path: string): string[] {
  return SIDECAR_SUFFIXES.filter((suffix) => existsSync(`${path}${suffix}`)).map(
    (suffix) => `${basename(path)}${suffix}`
  )
}

/** The one-line reason shown to the user, also used as the error message. */
export function heldElsewhereMessage(path: string, sidecars: readonly string[]): string {
  return (
    `[Skillsmith] Not writing ${path}: this process is using the WASM SQLite driver ` +
    '(native better-sqlite3 is not available), and another Skillsmith process may have ' +
    `the database open (found ${sidecars.join(', ')}). The WASM driver cannot share a ` +
    'database safely, so this session is read-only. Close other Skillsmith processes ' +
    '(such as the MCP server) and retry, or reinstall so the native driver loads.'
  )
}

export function heldElsewhereError(
  path: string,
  sidecars: readonly string[],
  cause?: unknown
): DatabaseHeldElsewhereError {
  return new DatabaseHeldElsewhereError({
    message: heldElsewhereMessage(path, sidecars),
    path,
    sidecars,
    cause,
  })
}

/**
 * Rethrow a sql.js error, translated to `DatabaseHeldElsewhereError` when it is
 * the `query_only` refusal of a handle opened read-only for this reason.
 * Matches SQLite's whole message, not a substring (see sqljsDriver.corruption).
 */
export function rethrowWriteError(
  error: unknown,
  path: string,
  heldBy: readonly string[] | undefined
): never {
  const message = error instanceof Error ? error.message : String(error)
  if (heldBy !== undefined && message === SQLITE_READONLY_MESSAGE) {
    throw heldElsewhereError(path, heldBy, error)
  }
  throw error
}
