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
 * Back up a corrupt SQLite file by renaming it out of the way.
 *
 * The backup path is `${path}.corrupt-<timestamp>` where the timestamp is an
 * ISO string with `:` and `.` replaced by `-` so it is filesystem-safe.
 *
 * @param path - Path to the corrupt database file. Must be a real file path
 *   (not `:memory:`) and must exist on disk.
 * @returns The path the corrupt file was moved to.
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
  return backupPath
}
