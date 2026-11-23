/**
 * SMI-7260: the sql.js driver must never replace a database another process
 * may hold, or has changed since this process read it.
 *
 * **The rule.** A sql.js handle becomes read-only (writes fail with
 * `DatabaseHeldElsewhereError`, the file is never rewritten) when either:
 *
 * 1. SQLite's own sidecar files (`-wal`, `-shm` or `-journal`) exist beside the
 *    database — at open, or immediately before a rename; or
 * 2. the database file is not the one this handle last read or wrote: its
 *    identity (device, inode, size, mtime, ctime) differs, immediately before a
 *    rename, from what was recorded at open or after this handle's own last
 *    save.
 *
 * Once either is seen the handle stays read-only for the rest of the session:
 * its in-memory image may predate another process's writes, so saving it later
 * — even after the sidecars are gone — would replace those writes.
 *
 * **Why the sidecars.** SQLite's documented WAL behaviour: `-wal` and `-shm`
 * exist for as long as any connection has a WAL database open, and are normally
 * deleted when the last connection closes. A `-wal` left by a process that
 * crashed holds committed transactions not yet in the main file, so rewriting
 * the main file around it is also unsafe. A `-journal` is the rollback-mode
 * equivalent: a hot journal must be rolled back before the main file is
 * consistent, and sql.js reads only the main file. A WAL-mode header with none
 * of these files present means no connection is open and nothing is pending.
 *
 * **Why the identity.** The sidecar check sees only what exists at that
 * instant. A native process that opened, wrote, checkpointed and closed after
 * this handle read the file leaves no sidecars behind, but its writes are in
 * the file; renaming this handle's older image over it would lose them. A
 * long-lived handle (the MCP server's periodic autosave) makes that window
 * minutes wide.
 *
 * **Residual window.** sql.js takes no file locks, so the final checks and the
 * rename are not atomic: a process that changes the database in the
 * microseconds between them is not detected. Shipping the native driver (so
 * this path is a fallback, not the default) is the other half of SMI-7260.
 */

import { existsSync, statSync } from 'node:fs'
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

/** What identifies one version of the database file on disk. */
export interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

/** The file's current identity, or `null` when it does not exist. */
export function fileIdentityOf(path: string): FileIdentity | null {
  try {
    const s = statSync(path)
    return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  }
}

export function sameFileIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  )
}

/**
 * Why the handle is read-only, as one line for the user. `sidecars` empty means
 * the file changed after this session read it (rule 2 above).
 */
export function heldElsewhereReason(path: string, sidecars: readonly string[]): string {
  const why =
    sidecars.length > 0
      ? `another process may be using it (found ${sidecars.join(', ')})`
      : 'another process changed it after this session read it'
  return `[Skillsmith] Opened ${path} read-only for this session: ${why}.`
}

/** The thrown error's message: what was not done, and what to do about it. */
export function heldElsewhereMessage(path: string, sidecars: readonly string[]): string {
  const driver =
    process.env.SKILLSMITH_FORCE_WASM === 'true'
      ? 'the WASM SQLite driver (SKILLSMITH_FORCE_WASM is set)'
      : 'the WASM SQLite driver (the native better-sqlite3 driver did not load)'
  const leftover = sidecars.filter((name) => name.endsWith('-wal') || name.endsWith('-journal'))
  const remedy =
    sidecars.length === 0
      ? 'Run the command again: it will read the current database.'
      : 'Stop other Skillsmith processes (such as the MCP server in your editor) and retry.' +
        (leftover.length > 0
          ? ` If none is running, ${leftover.join(' and ')} was left by one that stopped ` +
            'unexpectedly; the next Skillsmith run that loads the native driver folds it back ' +
            'into the database.'
          : '')
  return (
    `[Skillsmith] Not writing ${path}: this process is using ${driver}, which cannot ` +
    `safely write a database that another process ${sidecars.length > 0 ? 'may be using' : 'has changed'}. ${remedy}`
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
 * the `query_only` refusal of a handle made read-only for this reason.
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
