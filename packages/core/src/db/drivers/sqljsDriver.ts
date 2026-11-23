/**
 * SMI-2182: sql.js (WASM) Driver Implementation
 *
 * Wraps the sql.js library to implement the Database abstraction interface.
 * This driver is used when native modules are NOT available (macOS, WebContainers).
 *
 * sql.js is a JavaScript implementation of SQLite that runs in WebAssembly.
 * It requires async initialization but provides cross-platform compatibility.
 *
 * Key differences from better-sqlite3:
 * - Async initialization (WASM loading)
 * - In-memory by default, manual persistence to file
 * - Different API for prepared statements
 *
 * @see https://github.com/sql-js/sql.js
 */

import { createRequire } from 'node:module'
import type { Database, Statement, DatabaseOptions } from '../database-interface.js'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { corruptDatabaseError } from '../corrupt-refusal.js'
import { sqlJsCorruptionCode, refuseIfCorrupt } from './sqljsDriver.corruption.js'
import {
  heldElsewhereError,
  heldElsewhereMessage,
  rethrowWriteError,
  sidecarsOf,
} from './sqljsDriver.holder.js'
import { SqlJsStatementAdapter, type SqlJsDatabase } from './sqljsDriver.statement.js'

// ESM-compatible require for dynamic module loading
const require = createRequire(import.meta.url)

// sql.js types - fts5-sql-bundle exports a factory function
// that returns a Promise<SqlJs>
interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase
}

// Cached sql.js module to avoid reloading WASM
let sqlJsModule: SqlJsStatic | null = null

/**
 * Load sql.js WASM module (cached)
 * @throws Error with user-friendly message if WASM fails to load
 */
async function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsModule) {
    return sqlJsModule
  }

  try {
    // Dynamic import to avoid loading at module evaluation time
    // Using fts5-sql-bundle for FTS5 full-text search support
    // Typed via ambient declaration in fts5-sql-bundle.d.ts (SMI-2742)
    const module = await import('fts5-sql-bundle')
    // Extract initSqlJs from the typed module. The .d.ts declares the named export;
    // the fallback chain handles CJS interop shapes at runtime (module.default.initSqlJs,
    // module.default.default). These edge cases require a Record cast.
    type InitFn = (config?: object) => Promise<SqlJsStatic>
    const fallback = module.default as unknown as
      | (InitFn & { initSqlJs?: InitFn; default?: InitFn })
      | undefined
    const initSqlJs: InitFn | undefined =
      module.initSqlJs || fallback?.initSqlJs || fallback?.default || fallback

    if (!initSqlJs) {
      throw new Error('[Skillsmith] fts5-sql-bundle: could not locate initSqlJs export')
    }

    // Initialize with bundled WASM - fts5-sql-bundle has a built-in locateFile
    // that correctly resolves the WASM file in its dist/ directory
    sqlJsModule = (await initSqlJs()) as SqlJsStatic

    return sqlJsModule
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[Skillsmith] Failed to load sql.js WASM module: ${message}\n\n` +
        'This may indicate a corrupted installation. Try:\n' +
        '  npm rebuild fts5-sql-bundle\n' +
        '  npm install fts5-sql-bundle'
    )
  }
}

/**
 * Wraps a sql.js Database to implement our Database interface
 */
export class SqlJsDatabaseAdapter implements Database {
  private _open = true
  private readonly _memory: boolean
  private readonly _readonly: boolean
  // Track transaction nesting depth for SAVEPOINT-based nested transactions
  private _transactionDepth = 0

  /**
   * @param heldBy - SMI-7260: SQLite sidecar files found beside the database at
   *   open. When set, the handle is read-only (`query_only`), a write throws
   *   `DatabaseHeldElsewhereError`, and nothing is ever persisted — not even
   *   after the sidecars disappear, since this image may predate a holder's
   *   checkpoint. See sqljsDriver.holder.ts.
   */
  constructor(
    private readonly db: SqlJsDatabase,
    private readonly filePath: string,
    options?: DatabaseOptions,
    private readonly heldBy?: readonly string[]
  ) {
    this._memory = filePath === ':memory:'
    this._readonly = options?.readonly ?? false
    if (heldBy !== undefined) this.db.run('PRAGMA query_only = ON')
  }

  /** Rethrow a sql.js error, naming a write refused because the file is held. */
  private readonly onError = (error: unknown): never =>
    rethrowWriteError(error, this.filePath, this.heldBy)

  exec(sql: string): void {
    try {
      this.db.run(sql)
    } catch (error) {
      this.onError(error)
    }
  }

  prepare<T = unknown>(sql: string): Statement<T> {
    return new SqlJsStatementAdapter<T>(this.db, sql, this.onError)
  }

  transaction<T, Args extends unknown[] = []>(fn: (...args: Args) => T): (...args: Args) => T {
    // Return a callable function that executes the transaction
    const executeTransaction = (...args: Args): T => {
      const depth = this._transactionDepth++
      const savepoint = `sp_${depth}`

      try {
        if (depth === 0) {
          // Outermost transaction: use BEGIN TRANSACTION
          this.db.run('BEGIN TRANSACTION')
        } else {
          // Nested transaction: use SAVEPOINT
          this.db.run(`SAVEPOINT ${savepoint}`)
        }

        const result = fn(...args)

        if (depth === 0) {
          this.db.run('COMMIT')
        } else {
          this.db.run(`RELEASE SAVEPOINT ${savepoint}`)
        }

        return result
      } catch (error) {
        if (depth === 0) {
          this.db.run('ROLLBACK')
        } else {
          this.db.run(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        }
        throw error
      } finally {
        this._transactionDepth--
      }
    }

    return executeTransaction
  }

  pragma(pragma: string): unknown {
    // Split pragma into name and optional value
    const [name, value] = pragma.split('=').map((s) => s.trim())

    if (value !== undefined) {
      // Setting a pragma value
      this.exec(`PRAGMA ${name} = ${value}`)
      return undefined
    }

    // Getting a pragma value
    const stmt = this.db.prepare(`PRAGMA ${name}`)
    if (stmt.step()) {
      const result = stmt.get()
      stmt.free()
      // For simple pragmas like foreign_keys, return the single value
      return result?.[0]
    }
    stmt.free()
    return undefined
  }

  close(): void {
    if (!this._open) return

    // Persist to file before closing (if not memory, not readonly, and not
    // held by another process — SMI-7260). The handle is freed even when the
    // persist refuses, so the refusal is reported without leaking WASM memory.
    try {
      if (!this._memory && !this._readonly && this.heldBy === undefined && this.filePath) {
        this.persist()
      }
    } finally {
      this.db.close()
      this._open = false
    }
  }

  /**
   * Persist the in-memory database to file
   *
   * SMI-5997: writes atomically (temp file + rename) rather than a direct
   * writeFileSync to filePath. A direct write truncates the target file
   * before the new bytes land; a process kill/crash mid-write (OOM, SIGKILL,
   * machine sleep) during that window leaves a 0-byte file on disk, which
   * openDatabaseAsync() then silently misclassifies as a fresh/legacy import
   * instead of a corrupt file — see schema.ts. rename() is atomic on the
   * same filesystem, so the target is only ever fully-old or fully-new.
   *
   * SMI-7260: never renames over a database another process may hold. Refuses
   * when sidecars were present at open, and re-checks immediately before the
   * rename, because a native process can open the file after this one did.
   */
  persist(): void {
    if (this._memory || !this.filePath) return
    if (this.heldBy !== undefined) throw heldElsewhereError(this.filePath, this.heldBy)

    const data = this.db.export()
    const tmpPath = `${this.filePath}.tmp`
    try {
      writeFileSync(tmpPath, Buffer.from(data))
      const lateSidecars = sidecarsOf(this.filePath)
      if (lateSidecars.length > 0) throw heldElsewhereError(this.filePath, lateSidecars)
      renameSync(tmpPath, this.filePath)
    } catch (error) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {
        // best-effort cleanup — surface the original error either way
      }
      throw error
    }
  }

  /**
   * Export the database as a Uint8Array
   * Useful for manual persistence or serialization
   */
  export(): Uint8Array {
    return this.db.export()
  }

  get open(): boolean {
    return this._open
  }

  get name(): string {
    return this.filePath
  }

  get memory(): boolean {
    return this._memory
  }

  get readonly(): boolean {
    return this._readonly
  }

  /**
   * SMI-7260: why this handle refuses writes, as one line for the user, or
   * `undefined` when it may write. Set only for a database found held at open.
   */
  get readOnlyReason(): string | undefined {
    return this.heldBy === undefined ? undefined : heldElsewhereMessage(this.filePath, this.heldBy)
  }

  /**
   * Get the underlying sql.js database instance
   * Use with caution - this bypasses the abstraction layer
   */
  get native(): SqlJsDatabase {
    return this.db
  }
}

/**
 * Create a database connection using sql.js (WASM)
 *
 * @param path - Path to database file, or ':memory:' for in-memory database
 * @param options - Database connection options
 * @returns Promise resolving to a Database instance wrapping sql.js
 * @throws Error if sql.js WASM module fails to load
 */
export async function createSqlJsDatabase(
  path: string = ':memory:',
  options?: DatabaseOptions
): Promise<SqlJsDatabaseAdapter> {
  const SQL = await loadSqlJs()

  // SMI-7260: sidecars beside the file mean another process may hold it (or
  // holds data not yet in it). Checked BEFORE the read, so the image this handle
  // loads is never treated as writable when a holder was present.
  const sidecars = path === ':memory:' || options?.readonly ? [] : sidecarsOf(path)

  // Load existing database from file if it exists
  let data: Uint8Array | undefined
  if (path !== ':memory:' && existsSync(path)) {
    data = readFileSync(path)
  } else if (path !== ':memory:' && options?.fileMustExist) {
    throw new Error(`SQLITE_CANTOPEN: unable to open database file: ${path}`)
  }

  // Open the database. If the on-disk file is corrupt, REFUSE — do not rename
  // it aside and rebuild (ADR-175 § 1, SMI-6961). This driver used to do
  // exactly that, inherited from SMI-4484, and it did so without consulting
  // `options.readonly`: a read-only `skillsmith list` renamed the user's
  // database and then, because `close()` skips `persist()` when read-only,
  // wrote nothing back. The file was simply gone, and the NEXT run found no
  // database and reported every skill "Up to date" — the false currency claim
  // SMI-6946 had just removed, reappearing one run later through the
  // absent-database path.
  //
  // sql.js validates the file lazily — `new SQL.Database(data)` and a no-op
  // PRAGMA can both succeed on garbage bytes; corruption only surfaces on the
  // first read of a page. We therefore probe inside the try-block so corruption
  // is detected here rather than at an arbitrary later query.
  //
  // TWO probes, and neither subsumes the other. `sqlite_master` (here) reads
  // only the schema page, so it throws on a bad header and opens a
  // page-damaged file cleanly; `quick_check(1)` (below) reaches the later pages
  // but REPORTS rather than throws, so it cannot live in this catch. ADR-175
  // § 2. Do not collapse them.
  let db: SqlJsDatabase
  let partialDb: SqlJsDatabase | undefined
  try {
    partialDb = new SQL.Database(data)
    db = partialDb
    // Set default pragmas for consistency.
    // Note: WAL mode is intentionally NOT set for sql.js because:
    // 1. sql.js operates fully in-memory with manual file persistence
    // 2. Journal modes are meaningless without filesystem integration
    // 3. Setting WAL would create false parity expectations with better-sqlite3
    db.run('PRAGMA foreign_keys = ON')
    // SCHEMA-PAGE probe, not the integrity check: it forces a read of page 1,
    // which is what makes a bad header throw here rather than at an arbitrary
    // later query. `quick_check` below reaches the later pages. Skipped for a
    // brand-new empty database (no `data`), where there is nothing to validate.
    if (data !== undefined) {
      db.run('SELECT name FROM sqlite_master LIMIT 1')
    }
  } catch (error) {
    // Free the partially-opened handle's WASM heap memory before we rebuild or
    // rethrow — otherwise it leaks for the process lifetime (SMI-4484).
    if (partialDb) {
      try {
        partialDb.close()
      } catch {
        // handle already unusable — nothing more to free
      }
    }
    const sqliteCode = sqlJsCorruptionCode(error)
    if (sqliteCode === undefined || path === ':memory:') {
      throw error
    }
    // The same refusal the native driver throws, from the same builder, so the
    // two drivers cannot drift apart about what a corrupt database means.
    throw corruptDatabaseError(
      path,
      error instanceof Error ? error.message : String(error),
      sqliteCode,
      error
    )
  }

  // Integrity verdict, deliberately OUTSIDE the try above: `quick_check`
  // REPORTS rather than throws, so no catch can observe it (ADR-175 § 2).
  // Skipped for a brand-new empty database, where there is nothing to verify.
  if (data !== undefined) {
    refuseIfCorrupt(db, path)
  }

  return new SqlJsDatabaseAdapter(db, path, options, sidecars.length > 0 ? sidecars : undefined)
}

/**
 * Check if fts5-sql-bundle (sql.js with FTS5) is available
 * This always returns true in Node.js since it's a pure JS/WASM module
 *
 * Note: We use require.resolve() here instead of dynamic import() because:
 * 1. This is a synchronous availability check - dynamic import would require async
 * 2. require.resolve() is fast and doesn't load the module, just checks resolvability
 * 3. The actual loading in loadSqlJs() uses dynamic import() for proper ESM support
 *
 * @returns true if fts5-sql-bundle is loadable in Node.js
 */
export function isSqlJsAvailable(): boolean {
  try {
    require.resolve('fts5-sql-bundle')
    return true
  } catch {
    return false
  }
}
