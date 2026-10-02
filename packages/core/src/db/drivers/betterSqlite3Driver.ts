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
import { isCorruptionError } from './corruption.js'

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

  // SMI-6931 finding 6: the constructor itself can reject a corrupt file, and
  // that path previously bypassed every diagnostic. Classify it the same way as
  // a probe failure; anything that is not corruption propagates untouched.
  let db: BetterSqlite3.Database
  try {
    db = new Database(path, dbOptions)
  } catch (error) {
    if (fileExistedBeforeOpen && isCorruptionError(error)) {
      throw corruptDatabaseError(path, error instanceof Error ? error.message : String(error))
    }
    throw error
  }

  if (fileExistedBeforeOpen) {
    const corruptionReason = detectCorruption(db, path)
    if (corruptionReason !== null) {
      closeQuietly(db)
      throw corruptDatabaseError(path, corruptionReason)
    }
  }

  return new BetterSqlite3Database(db)
}

/**
 * The refusal a corrupt database produces.
 *
 * **Why this refuses instead of repairing (SMI-6931).** An earlier draft backed
 * the file aside and rebuilt, mirroring the WASM driver. A cross-family review
 * rejected it, and correctly: this database is shared between processes — a CLI
 * invocation and a long-lived MCP server can both hold it — and SQLite
 * coordinates processes through the **file paths**, not the inodes. Renaming it
 * out from under a live handle leaves that process writing into the renamed
 * backup while new connections use the replacement, so the two diverge
 * silently. Losing writes is worse than refusing to start, and this database is
 * a rebuildable mirror of the remote registry, so refusing costs little.
 *
 * It is also what this repo already decided. ADR-155: *"Recovery never runs
 * automatically."* Skillsmith refuses and defers to an explicit command rather
 * than acting on the user's data unasked.
 *
 * The message therefore has to be actionable, because a correct refusal the
 * user cannot act on is its own defect. It names the path, the verdict, and the
 * exact manual move — **including the WAL sidecars**, because
 * `schema-sql.ts` sets `journal_mode = WAL`, so the database on disk is three
 * files and moving one leaves the others orphaned against a rebuilt file.
 */
function corruptDatabaseError(path: string, reason: string): Error {
  return new Error(
    `[Skillsmith] The local database at ${path} is corrupt and cannot be read: ${reason}\n` +
      `\n` +
      `Skillsmith does not repair it automatically — it holds no data that cannot be ` +
      `rebuilt from the registry, and repairing a database another process may have ` +
      `open risks losing that process's writes.\n` +
      `\n` +
      `To recover, move the file aside and re-run. It is a WAL database, so move all ` +
      `three files together:\n` +
      `  mv ${path} ${path}.corrupt\n` +
      `  mv ${path}-wal ${path}.corrupt-wal   # if present\n` +
      `  mv ${path}-shm ${path}.corrupt-shm   # if present\n` +
      `\n` +
      `Skillsmith rebuilds the database on the next sync.`
  )
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
    const verdict = first && typeof first === 'object' ? Object.values(first)[0] : undefined

    if (typeof verdict !== 'string' || verdict.length === 0) {
      // SMI-6931 finding 5: an unrecognised result is a PROBE failure, not a
      // corruption verdict. An earlier draft mapped any unexpected shape —
      // a scalar, an empty array, a renamed row key — to "corrupt", reasoning
      // that unknown should be treated as unsafe. That is backwards when the
      // "unsafe" branch is the one that refuses to open the user's database:
      // a `pragma()` return-shape change in a dependency would then have
      // bricked every open. Fail-closed is right only where the closed state
      // is the harmless one.
      throw new Error(
        `[Skillsmith] Could not read a quick_check verdict for ${path}. This is a ` +
          `fault in the integrity probe, not evidence that the database is corrupt. ` +
          `Received: ${JSON.stringify(rows)?.slice(0, 200)}`
      )
    }

    return verdict.trim().toLowerCase() === 'ok' ? null : verdict.trim()
  } catch (error) {
    // A corruption-class throw IS corruption. Everything else — including the
    // probe fault above — propagates, so a broken probe is never reported to
    // the user as a broken database.
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
