/**
 * SMI-7260 D2: reading an existing database file into sql.js, re-reading
 * before any corruption verdict.
 *
 * **Why re-read.** sql.js reads the whole file in one go and takes no locks. A
 * read that races a native (better-sqlite3) process's WAL checkpoint can see a
 * torn image: some pages from before the checkpoint, some from after. The
 * ADR-175 integrity probe then fails on an intact file, and the corruption
 * refusal advises moving the database aside, which would destroy it. Measured
 * in the SMI-7260 research: rare at a sync-like write rate, near-certain under
 * heavy churn.
 *
 * **The rule (owner decision, design review round 1).** Every integrity
 * failure gets a bounded re-read: up to {@link RETRY_DELAYS_MS}`.length` more
 * reads, after the listed waits. The corruption verdict, with its move-aside
 * advice, is given only when two consecutive reads are byte-identical (hash
 * compared) and both fail. Any other outcome that never produced a healthy
 * read is `DatabaseReadUnstableError`, which says to try again. Whether the
 * file's `stat` changed during a read, or a `-wal` exists, only chooses that
 * message's wording; it never decides whether to retry.
 *
 * **Why this cannot weaken the guard.** A damaged file that nothing is writing
 * reads identically every time, so its second read is the corrupt verdict, as
 * before. It cannot loop: the number of reads is fixed.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { corruptDatabaseError } from '../corrupt-refusal.js'
import { DatabaseReadUnstableError, isCorruptDatabaseError } from '../db-errors.js'
import { refuseIfCorrupt, sqlJsCorruptionCode } from './sqljsDriver.corruption.js'
import type { SqlJsDatabase } from './sqljsDriver.statement.js'

/** Waits before each re-read. Its length is the retry bound. */
export const RETRY_DELAYS_MS: readonly number[] = [50, 100, 200]

/** The sql.js constructor this module needs. */
export interface SqlJsConstructor {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase
}

/**
 * Open `data` (the bytes of `path`) in sql.js and run ADR-175's two probes.
 *
 * TWO probes, and neither subsumes the other. `sqlite_master` reads only the
 * schema page, so it throws on a bad header and opens a page-damaged file
 * cleanly; `quick_check(1)` reaches the later pages but REPORTS rather than
 * throws, so it cannot live in the catch below. ADR-175 § 2. Do not collapse
 * them. sql.js validates lazily (`new SQL.Database(data)` succeeds on garbage),
 * which is why the probes run here rather than at an arbitrary later query.
 *
 * @throws CorruptDatabaseError when either probe fails; any other error as is.
 */
export function openImage(SQL: SqlJsConstructor, data: Uint8Array, path: string): SqlJsDatabase {
  let db: SqlJsDatabase | undefined
  try {
    db = new SQL.Database(data)
    db.run('PRAGMA foreign_keys = ON')
    db.run('SELECT name FROM sqlite_master LIMIT 1')
  } catch (error) {
    // Free the partially-opened handle's WASM heap memory (SMI-4484).
    try {
      db?.close()
    } catch {
      // handle already unusable — nothing more to free
    }
    const sqliteCode = sqlJsCorruptionCode(error)
    if (sqliteCode === undefined) throw error
    // The same refusal the native driver throws, from the same builder.
    throw corruptDatabaseError(
      path,
      error instanceof Error ? error.message : String(error),
      sqliteCode,
      error
    )
  }
  refuseIfCorrupt(db, path)
  return db
}

interface StatStamp {
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

function stampOf(path: string): StatStamp | null {
  try {
    const s = statSync(path)
    return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }
  } catch {
    return null
  }
}

function sameStamp(a: StatStamp | null, b: StatStamp | null): boolean {
  if (a === null || b === null) return a === b
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function unstableReadError(
  path: string,
  attempts: number,
  writerSeen: boolean,
  cause: unknown
): DatabaseReadUnstableError {
  const why = writerSeen
    ? 'changed while being read (another Skillsmith process is writing it)'
    : 'read differently each time it was opened, so its integrity could not be checked'
  return new DatabaseReadUnstableError({
    message: `[Skillsmith] ${path} ${why}; try again. Nothing was changed.`,
    path,
    attempts,
    cause,
  })
}

/**
 * Read an existing database file and open it, applying the D2 rule above.
 *
 * @throws CorruptDatabaseError only for two consecutive byte-identical failing
 *   reads; DatabaseReadUnstableError when the reads never settled; any
 *   non-integrity error (unreadable file, WASM failure) unchanged.
 */
export async function openExistingImage(
  SQL: SqlJsConstructor,
  path: string
): Promise<SqlJsDatabase> {
  let previousDigest: string | undefined
  let lastFailure: unknown
  let writerSeen = false
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0)
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]))
    const before = stampOf(path)
    const bytes = readFileSync(path)
    if (!sameStamp(before, stampOf(path))) writerSeen = true
    const digest = digestOf(bytes)
    try {
      return openImage(SQL, bytes, path)
    } catch (error) {
      if (!isCorruptDatabaseError(error)) throw error
      if (digest === previousDigest) throw error
      if (previousDigest !== undefined) writerSeen = true
      previousDigest = digest
      lastFailure = error
    }
  }
  writerSeen ||= existsSync(`${path}-wal`)
  throw unstableReadError(path, RETRY_DELAYS_MS.length + 1, writerSeen, lastFailure)
}
