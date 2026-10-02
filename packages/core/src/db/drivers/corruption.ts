/**
 * SMI-4484: SQLite corruption detection + self-heal helpers
 *
 * On fresh macOS installs, the native better-sqlite3 driver writes WAL-mode
 * journal files that the WASM driver (sql.js) cannot read. The result is a
 * `database disk image is malformed` error on the next sync.
 *
 * These helpers let both the sql.js driver and the CLI database opener
 * recognise a corruption-class error and recover by backing up the bad file
 * and rebuilding an empty database — instead of crashing the user's command.
 */

import { existsSync, renameSync } from 'node:fs'

/**
 * Substrings that identify a SQLite corruption-class error.
 * Matched case-insensitively against the error message.
 */
const CORRUPTION_MARKERS = [
  'sqlite_corrupt',
  'malformed',
  'not a database',
  'file is encrypted',
  'disk image is malformed',
]

/**
 * Determine whether an error indicates a corrupt / unreadable SQLite file.
 *
 * @param err - The thrown value (Error, string, or anything).
 * @returns true if the error message matches a known corruption marker.
 */
export function isCorruptionError(err: unknown): boolean {
  const message = (
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  ).toLowerCase()

  return CORRUPTION_MARKERS.some((marker) => message.includes(marker))
}

/**
 * Suffixes of the files SQLite keeps beside a database in WAL mode.
 *
 * SMI-6931: `schema-sql.ts` sets `journal_mode = WAL`, so a real database on
 * disk is a set of three files, not one.
 */
const WAL_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const

/**
 * Back up a corrupt SQLite file by renaming it out of the way, together with
 * its WAL sidecars.
 *
 * The backup path is `${path}.corrupt-<timestamp>` where the timestamp is an
 * ISO string with `:` and `.` replaced by `-` so it is filesystem-safe. Any
 * `-wal` / `-shm` sidecar moves to `${backupPath}-wal` / `${backupPath}-shm`.
 *
 * **Why the sidecars move too (SMI-6931).** Renaming only the main file leaves
 * a `-wal` and `-shm` belonging to the moved database sitting at the live
 * paths, beside whatever the caller rebuilds there. That is wrong twice: the
 * orphans carry a header salt tied to a database that is no longer at that
 * path, and the backup is incomplete, because a WAL can hold committed pages
 * the main file does not. The suffixes are appended **after** the timestamp so
 * the moved set stays self-associating — `<backup>-wal` is exactly where SQLite
 * looks for `<backup>`'s WAL — which keeps the backup recoverable rather than
 * merely preserved.
 *
 * The sql.js driver deliberately never sets WAL (see `sqljsDriver.ts`), so for
 * its callers every sidecar source is absent and the loop below is a no-op. It
 * creates nothing when a source does not exist, which is what keeps that
 * driver's "exactly one backup" expectation true.
 *
 * The main file moves first on purpose. If a sidecar rename then fails the
 * error propagates, but the live path is already free, so the caller's rebuild
 * still produces a working database. The reverse order would orphan sidecars
 * from a database that is still live at its original path.
 *
 * @param path - Path to the corrupt database file. Must be a real file path
 *   (not `:memory:`) and must exist on disk.
 * @returns The path the corrupt **main** file was moved to. Sidecar paths are
 *   this value plus their suffix; callers surface this one to the user.
 * @throws Error if `path` is `:memory:` or the file does not exist.
 */
export function backupCorruptDbFile(path: string): string {
  if (path === ':memory:') {
    throw new Error('[Skillsmith] backupCorruptDbFile: cannot back up an in-memory database')
  }
  if (!existsSync(path)) {
    throw new Error(`[Skillsmith] backupCorruptDbFile: file does not exist: ${path}`)
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${path}.corrupt-${timestamp}`
  renameSync(path, backupPath)

  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    const sidecar = `${path}${suffix}`
    if (existsSync(sidecar)) {
      renameSync(sidecar, `${backupPath}${suffix}`)
    }
  }

  return backupPath
}
