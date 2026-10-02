/**
 * SMI-2180: better-sqlite3 Driver Implementation
 *
 * Wraps the better-sqlite3 library to implement the Database abstraction interface.
 * This driver is used when native modules are available (Docker, Linux, CI).
 *
 * better-sqlite3 is synchronous and provides excellent performance for local SQLite.
 *
 * @see https://github.com/WiseLibs/better-sqlite3
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'
import type { Database, Statement, RunResult, DatabaseOptions } from '../database-interface.js'
import { isCorruptionError, backupCorruptDbFile } from './corruption.js'

// ESM-compatible require for native modules
const require = createRequire(import.meta.url)

/**
 * Wraps a better-sqlite3 Statement to implement our Statement interface
 */
class BetterSqlite3Statement<T = unknown> implements Statement<T> {
  constructor(private readonly stmt: BetterSqlite3.Statement) {}

  run(...params: unknown[]): RunResult {
    const result = this.stmt.run(...params)
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  get(...params: unknown[]): T | undefined {
    return this.stmt.get(...params) as T | undefined
  }

  all(...params: unknown[]): T[] {
    return this.stmt.all(...params) as T[]
  }

  iterate(...params: unknown[]): IterableIterator<T> {
    return this.stmt.iterate(...params) as IterableIterator<T>
  }

  finalize(): void {
    // better-sqlite3 doesn't require explicit finalization
    // Statements are automatically cleaned up when garbage collected
  }

  bind(...params: unknown[]): this {
    this.stmt.bind(...params)
    return this
  }
}

/**
 * Wraps a better-sqlite3 Database to implement our Database interface
 */
export class BetterSqlite3Database implements Database {
  constructor(private readonly db: BetterSqlite3.Database) {}

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare<T = unknown>(sql: string): Statement<T> {
    const stmt = this.db.prepare(sql)
    return new BetterSqlite3Statement<T>(stmt)
  }

  transaction<T, Args extends unknown[] = []>(fn: (...args: Args) => T): (...args: Args) => T {
    // better-sqlite3 transaction returns a wrapped function
    return this.db.transaction(fn) as (...args: Args) => T
  }

  pragma(pragma: string): unknown {
    return this.db.pragma(pragma)
  }

  close(): void {
    this.db.close()
  }

  get open(): boolean {
    return this.db.open
  }

  get name(): string {
    return this.db.name
  }

  get memory(): boolean {
    return this.db.memory
  }

  get readonly(): boolean {
    return this.db.readonly
  }

  /**
   * Get the underlying better-sqlite3 database instance
   * Use with caution - this bypasses the abstraction layer
   */
  get native(): BetterSqlite3.Database {
    return this.db
  }
}

/**
 * Create a database connection using better-sqlite3
 *
 * @param path - Path to database file, or ':memory:' for in-memory database
 * @param options - Database connection options
 * @returns A Database instance wrapping better-sqlite3
 * @throws Error if better-sqlite3 native module is not available
 */
export function createBetterSqlite3Database(
  path: string = ':memory:',
  options?: DatabaseOptions
): BetterSqlite3Database {
  // Dynamic import to avoid loading native module at module evaluation time
  // This is synchronous because better-sqlite3 is synchronous

  const Database = require('better-sqlite3') as typeof BetterSqlite3

  // Build options object, only including defined values
  // better-sqlite3 doesn't accept undefined for boolean options
  const dbOptions: Record<string, unknown> = {
    timeout: options?.timeout ?? 5000,
  }

  if (options?.readonly !== undefined) {
    dbOptions.readonly = options.readonly
  }
  if (options?.fileMustExist !== undefined) {
    dbOptions.fileMustExist = options.fileMustExist
  }
  if (options?.verbose) {
    dbOptions.verbose = console.log
  }

  // Captured BEFORE opening, because `new Database()` creates the file — a
  // check made afterwards can never distinguish a pre-existing database from
  // one this call just brought into being.
  const fileExistedBeforeOpen = path !== ':memory:' && existsSync(path)

  const db = new Database(path, dbOptions)

  if (fileExistedBeforeOpen) {
    const corruptionReason = detectCorruption(db, path)

    if (corruptionReason !== null) {
      // Backing a file aside is a WRITE. A caller that asked only to read must
      // not have its database renamed and replaced underneath it, so refuse
      // with something it can act on. The WASM driver has no `readonly` mode,
      // which is why its own self-heal never had to make this distinction.
      if (dbOptions.readonly === true) {
        closeQuietly(db)
        throw new Error(
          `[Skillsmith] The database at ${path} is corrupt and cannot be read ` +
            `(${corruptionReason}). It was NOT modified, because this connection is ` +
            `read-only. Re-open it read-write to have Skillsmith back it up and ` +
            `rebuild, or move it aside manually.`
        )
      }

      // Move the files aside BEFORE closing the handle. Measured (SMI-6931):
      // `close()` DELETES the `-wal` and `-shm` SQLite found at open, so a
      // backup taken afterwards is silently missing them and the sidecars are
      // gone rather than preserved. Renaming first is safe — the open handle
      // follows the inode — and leaves `close()` looking for paths that no
      // longer exist, which it tolerates.
      const backupPath = backupCorruptDbFile(path)
      closeQuietly(db)

      console.warn(
        `[Skillsmith] The local database at ${path} was corrupt and could not be read ` +
          `(${corruptionReason}). It has been backed up to ${backupPath} and will be ` +
          `rebuilt on the next sync.`
      )
      return new BetterSqlite3Database(new Database(path, dbOptions))
    }
  }

  return new BetterSqlite3Database(db)
}

/** Release a handle whose state is already unknown, without masking the real error. */
function closeQuietly(db: BetterSqlite3.Database): void {
  try {
    db.close()
  } catch {
    // Handle already unusable — nothing left to release.
  }
}

/**
 * Decide whether an already-open database is corrupt.
 *
 * SMI-6931. Two things here are not obvious and were both measured rather than
 * assumed, because getting either wrong yields a probe that silently detects
 * nothing while looking correct:
 *
 * **1. A `sqlite_master` read is not sufficient.** The WASM driver probes
 * `SELECT name FROM sqlite_master LIMIT 1` (SMI-4484), which validates only the
 * schema page. On a database whose schema page is intact and whose data pages
 * are damaged — the condition SMI-6931 was actually filed for — that read
 * **succeeds** while `SELECT COUNT(*)` on a real table throws
 * `database disk image is malformed`. Copying the WASM probe here would have
 * detected nothing on the machine that prompted the fix.
 *
 * **2. `quick_check` REPORTS rather than throws.** It returns a row whose value
 * is `ok` for a healthy database, and the damage as a *string* for a corrupt
 * one. Wrapping it in `try`/`catch` alone would be a no-op: the catch never
 * fires and every corrupt database passes. The verdict has to be inspected.
 *
 * `quick_check` over `integrity_check` on measured cost: on a fresh 59.6 MB
 * database, `quick_check(1)` took 114 ms against `integrity_check(1)`'s 190 ms.
 * It skips index-vs-table consistency, which a rebuild-on-corruption path does
 * not need — an inconsistent index is repairable by REINDEX, not grounds for
 * discarding the file. The `(1)` argument stops after the first error, so the
 * corrupt case is cheap; the healthy case is the one that pays, and that cost
 * is why this is worth stating out loud rather than burying.
 *
 * @returns A human-readable reason, or `null` when the database reads cleanly.
 */
function detectCorruption(db: BetterSqlite3.Database, path: string): string | null {
  try {
    const rows = db.pragma('quick_check(1)') as unknown
    const first = Array.isArray(rows) ? rows[0] : undefined
    const verdict =
      first && typeof first === 'object'
        ? String(Object.values(first)[0] ?? '')
        : String(first ?? '')

    if (verdict.trim().toLowerCase() === 'ok') return null
    return verdict.trim() || `quick_check returned no verdict for ${path}`
  } catch (error) {
    // A corruption-class throw is still corruption; anything else is a real
    // failure this function must not swallow.
    if (isCorruptionError(error)) {
      return error instanceof Error ? error.message : String(error)
    }
    closeQuietly(db)
    throw error
  }
}

/**
 * Captured reason the native driver last failed to load.
 *
 * SMI-4807: `better-sqlite3` is an optionalDependency whose install/dlopen
 * failures were previously swallowed by a bare `catch {}`. We now retain the
 * error message so the WASM-fallback path can surface it under `SKILLSMITH_DEBUG`.
 */
let betterSqlite3FailureReason: string | undefined

/**
 * Get the reason the native better-sqlite3 module last failed to load.
 *
 * @returns The failure message, or `undefined` if the native module loaded
 *   successfully or has not been checked yet.
 */
export function getBetterSqlite3FailureReason(): string | undefined {
  return betterSqlite3FailureReason
}

/**
 * Check if better-sqlite3 native module is available
 * @returns true if the native module can be loaded
 */
export function isBetterSqlite3Available(): boolean {
  try {
    const Database = require('better-sqlite3') as typeof BetterSqlite3
    // Instantiate in-memory DB to trigger dlopen of the native binary.
    // Catches ABI mismatch (Node upgrade) and platform mismatch (Linux binary on macOS).
    const testDb = new Database(':memory:')
    testDb.close()
    betterSqlite3FailureReason = undefined
    return true
  } catch (err) {
    // SMI-4807: capture the failure reason instead of silently discarding it.
    betterSqlite3FailureReason = err instanceof Error ? err.message : String(err)
    return false
  }
}
