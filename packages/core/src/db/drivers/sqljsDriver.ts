/**
 * SMI-2182: sql.js (WASM) Driver Implementation
 *
 * Wraps the sql.js library to implement the Database abstraction interface.
 * This driver is used when native modules are NOT available (macOS, WebContainers).
 *
 * sql.js is a JavaScript implementation of SQLite that runs in WebAssembly.
 * It requires async initialization but provides cross-platform compatibility.
 *
 * **A file-backed sql.js handle never writes to disk (SMI-7260).** sql.js holds
 * the whole database in memory and could only save by writing a new file and
 * renaming it over the old one. It takes no file locks, so it can never know
 * whether a native (better-sqlite3) process holds the database in WAL mode; when
 * one does, that rename silently loses the native process's work, and a later
 * native open folds a stale WAL into the new file and corrupts it. No heuristic
 * can detect a live holder without locks, so this driver does not try:
 *
 * - **An existing file** is read once (with the D2 re-read rule,
 *   sqljsDriver.read.ts) and the handle is sealed at open: `PRAGMA query_only`,
 *   `readonly === true`, `readOnlyReason` set. A write throws
 *   `DatabaseReadOnlyDriverError`.
 * - **A missing file** starts as an empty in-memory database that stays
 *   writable until its opener calls `seal()` once after building its schema
 *   (`initializeSchema`, `openDatabaseAsync`, or a store's own initializer).
 *   It never reaches the disk either; if it is closed unsealed after being
 *   written, `close()` warns once, naming the path, that the writes were
 *   discarded.
 * - **`{ readonly: true }`** on any path, `:memory:` included, is a sealed handle.
 * - **`:memory:`** is otherwise unchanged: writable, and `export()` returns its bytes.
 *
 * @see https://github.com/sql-js/sql.js
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import type { Database, Statement, DatabaseOptions } from '../database-interface.js'
import {
  captureWasmAdvice,
  rethrowSqlJsWriteError,
  wasmOpenNotice,
  type WasmAdvice,
  type WasmOpenKind,
} from '../wasm-read-only.js'
import { isQuietModeEnabled } from '../../utils/quiet-mode.js'
import { openExistingImage } from './sqljsDriver.read.js'
import {
  isMutatingSql,
  SqlJsStatementAdapter,
  type SqlJsDatabase,
} from './sqljsDriver.statement.js'

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
  // Track transaction nesting depth for SAVEPOINT-based nested transactions
  private _transactionDepth = 0
  // SMI-7260: true once the handle is read-only (`query_only`) for good.
  private _sealed = false
  // SMI-7260: set, and never cleared, by any successful statement that may
  // write (isMutatingSql). Drives the unsealed-close warning.
  private _dirty = false
  private readonly markDirty = (): void => {
    this._dirty = true
  }

  /**
   * @param kind - SMI-7260: for a file-backed handle, whether the file existed
   *   at open. `undefined` for `:memory:`.
   * @param sealNow - seal at construction (an existing file, or `readonly`;
   *   on `:memory:` only an explicit `readonly` request does this).
   */
  constructor(
    private readonly db: SqlJsDatabase,
    private readonly filePath: string,
    private readonly kind?: WasmOpenKind,
    sealNow = false
  ) {
    this._memory = filePath === ':memory:'
    // SMI-7271: captured once, so every later notice, reason and refusal for
    // this handle gives the same advice.
    this.advice = kind === undefined ? undefined : captureWasmAdvice()
    if (sealNow) this.applySeal()
  }

  /** SMI-7271: the native-driver advice captured when this handle opened. */
  private readonly advice: WasmAdvice | undefined

  /**
   * Rethrow a sql.js error, naming a write refused by a sealed file-backed
   * handle. A `:memory:` handle opened `readonly` keeps SQLite's own error:
   * the WASM driver did not make it read-only, its caller did.
   */
  private readonly onError = (error: unknown): never =>
    rethrowSqlJsWriteError(
      error,
      this.filePath,
      this._sealed && this.kind !== undefined,
      this.advice
    )

  private applySeal(): void {
    this.db.run('PRAGMA query_only = ON')
    this._sealed = true
  }

  /**
   * SMI-7260 D1: make a file-backed handle read-only (`query_only`) for good.
   * One-shot: a no-op on `:memory:` and on a handle already sealed.
   */
  seal(): void {
    if (this._memory || this._sealed || !this._open) return
    this.applySeal()
  }

  exec(sql: string): void {
    try {
      this.db.run(sql)
    } catch (error) {
      this.onError(error)
    }
    if (isMutatingSql(sql)) this._dirty = true
  }

  prepare<T = unknown>(sql: string): Statement<T> {
    return new SqlJsStatementAdapter<T>(this.db, sql, this.onError, this.markDirty)
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

  /**
   * Free the WASM handle. Never writes the file (SMI-7260). An unsealed
   * first-run handle that was written to warns once that those writes are gone,
   * so a missing seal cannot lose data silently. Honours quiet mode.
   */
  close(): void {
    if (!this._open) return
    try {
      if (!this._memory && !this._sealed && this._dirty && !isQuietModeEnabled()) {
        console.warn(
          `[Skillsmith] ${this.filePath}: changes made in this session were not saved; ` +
            'the WASM SQLite driver never writes a database file.'
        )
      }
    } finally {
      this.db.close()
      this._open = false
    }
  }

  /**
   * Export the database as a Uint8Array. Returns bytes only; never writes.
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
    return this._sealed
  }

  /**
   * SMI-7260: the one line Skillsmith prints when this driver opens a
   * file-backed database, or `undefined` for `:memory:`.
   */
  get openNotice(): string | undefined {
    return this.kind === undefined
      ? undefined
      : wasmOpenNotice(this.filePath, this.kind, this.advice)
  }

  /**
   * SMI-7271: the advice captured at open (`undefined` for `:memory:`), for
   * write refusals raised outside this adapter (`nativeAdviceOf`).
   */
  get nativeAdvice(): WasmAdvice | undefined {
    return this.advice
  }

  /**
   * SMI-7260: why this handle refuses writes, as one line for the user, or
   * `undefined` while it may write (`:memory:`, or a first-run handle not yet
   * sealed).
   */
  get readOnlyReason(): string | undefined {
    return this._sealed ? this.openNotice : undefined
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
 * @throws DatabaseReadUnstableError if an existing file never read cleanly
 *   (SMI-7260 D2). This driver never throws CorruptDatabaseError: the corrupt
 *   verdict comes only from the native driver (ADR-175 as amended)
 */
export async function createSqlJsDatabase(
  path: string = ':memory:',
  options?: DatabaseOptions
): Promise<SqlJsDatabaseAdapter> {
  const SQL = await loadSqlJs()

  if (path === ':memory:') {
    const db = new SQL.Database()
    db.run('PRAGMA foreign_keys = ON')
    return new SqlJsDatabaseAdapter(db, path, undefined, options?.readonly === true)
  }

  // An existing file: read it (re-reading when it does not read cleanly) and
  // seal at open. A file that never reads cleanly is refused, never renamed
  // aside or rebuilt (ADR-175 § 1, SMI-6961).
  if (existsSync(path)) {
    const db = await openExistingImage(SQL, path)
    return new SqlJsDatabaseAdapter(db, path, 'existing', true)
  }
  if (options?.fileMustExist) {
    throw new Error(`SQLITE_CANTOPEN: unable to open database file: ${path}`)
  }

  // A missing file (SMI-7260 D1): an empty in-memory database, writable until
  // its opener seals it. `{ readonly: true }` is sealed now.
  // Note: WAL mode is intentionally NOT set; sql.js has no filesystem VFS.
  const db = new SQL.Database()
  db.run('PRAGMA foreign_keys = ON')
  return new SqlJsDatabaseAdapter(db, path, 'first-run', options?.readonly === true)
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
