/**
 * SMI-7260 D2: reading an existing database file into sql.js, re-reading
 * when it does not read cleanly.
 *
 * **Why re-read.** sql.js reads the whole file in one go and takes no locks. A
 * read that races a native (better-sqlite3) process's WAL checkpoint can see a
 * torn image: some pages from before the checkpoint, some from after. The
 * ADR-175 integrity probes then fail on an intact file. Measured in the
 * SMI-7260 research: rare at a sync-like write rate, near-certain under heavy
 * churn. A torn first read that comes back healthy on a re-read is accepted.
 *
 * **sql.js never declares a database corrupt (owner decision, re-derived).** A
 * checkpoint can stall mid-write for longer than every retry delay, so even two
 * byte-identical failing reads can come from a healthy file. A corruption
 * verdict tells the user to move the database aside, which would destroy that
 * file, and sql.js cannot tell the two cases apart without locks. So when no
 * read in the bounded set ({@link RETRY_DELAYS_MS}) is clean, this always
 * throws the non-destructive `DatabaseReadUnstableError`, never
 * `CorruptDatabaseError`. The corrupt verdict comes only from the native
 * driver, which reads under SQLite's own locking; the message says how to run
 * that check.
 *
 * **What the stat and `-wal` evidence decide.** Only the message's wording:
 * whether the file's `stat` changed during or between reads, or a `-wal`
 * sidecar exists. It never decides whether to retry or what to throw. It
 * cannot loop: the number of reads is fixed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { corruptDatabaseError } from '../corrupt-refusal.js'
import {
  DatabaseReadUnstableError,
  isCorruptDatabaseError,
  type CorruptDatabaseError,
} from '../db-errors.js'
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
 * @throws CorruptDatabaseError when either probe fails (an internal
 *   classification: `openExistingImage` never lets it escape); any other
 *   error as is.
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
    // Classified with the native driver's builder; converted by the caller.
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

function unstableReadError(
  path: string,
  attempts: number,
  writerSeen: boolean,
  lastFailure: CorruptDatabaseError | undefined
): DatabaseReadUnstableError {
  const first = writerSeen
    ? `[Skillsmith] Could not read ${path} consistently: it changed while being read, so another ` +
      'Skillsmith process is probably writing it. Try again in a moment.'
    : `[Skillsmith] Could not read ${path} consistently. Another Skillsmith process may be ` +
      'writing it; try again in a moment.'
  return new DatabaseReadUnstableError({
    message:
      `${first} If this keeps happening when no other Skillsmith process is running, the file may ` +
      'be damaged: once the native SQLite driver loads (`npm rebuild better-sqlite3`), run ' +
      '`skillsmith list`, which checks the database and reports damage. Nothing was changed.',
    path,
    attempts,
    // The integrity verdict only, as a plain Error: the CorruptDatabaseError
    // itself carries move-aside advice, which must not surface through a cause chain.
    cause: lastFailure === undefined ? undefined : new Error(lastFailure.verdict),
  })
}

/**
 * Read an existing database file and open it, applying the D2 rule above.
 *
 * @throws DatabaseReadUnstableError when no read was clean (never
 *   CorruptDatabaseError); any non-integrity error (unreadable file, WASM
 *   failure) unchanged.
 */
export async function openExistingImage(
  SQL: SqlJsConstructor,
  path: string
): Promise<SqlJsDatabase> {
  let lastFailure: CorruptDatabaseError | undefined
  let previousStamp: StatStamp | null | undefined
  let writerSeen = false
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0)
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]))
    const before = stampOf(path)
    const bytes = readFileSync(path)
    const after = stampOf(path)
    // Wording evidence only: the file changed during this read, or since the last one.
    if (!sameStamp(before, after)) writerSeen = true
    if (previousStamp !== undefined && !sameStamp(previousStamp, before)) writerSeen = true
    previousStamp = after
    try {
      return openImage(SQL, bytes, path)
    } catch (error) {
      if (!isCorruptDatabaseError(error)) throw error
      lastFailure = error
    }
  }
  writerSeen ||= existsSync(`${path}-wal`)
  throw unstableReadError(path, RETRY_DELAYS_MS.length + 1, writerSeen, lastFailure)
}
