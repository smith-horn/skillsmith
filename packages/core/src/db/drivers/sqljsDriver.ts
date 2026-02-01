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
import type { Database, Statement, RunResult, DatabaseOptions } from '../database-interface.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// ESM-compatible require for dynamic module loading
const require = createRequire(import.meta.url)

// sql.js types - fts5-sql-bundle exports a factory function
// that returns a Promise<SqlJs>
interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase
}

interface SqlJsDatabase {
  run(sql: string): void
  prepare(sql: string): SqlJsStatement
  export(): Uint8Array
  close(): void
}

interface SqlJsStatement {
  bind(params?: SqlJsBindParams): boolean
  step(): boolean
  get(): SqlJsValue[]
  getColumnNames(): string[]
  reset(): void
  free(): void
}

// sql.js bind parameters type
type SqlJsValue = string | number | null | Uint8Array
type SqlJsBindParams = SqlJsValue[] | Record<string, SqlJsValue>

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
    // Handle both ESM and CJS module formats
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const module = (await import('fts5-sql-bundle')) as any
    // Extract initSqlJs function from various export shapes:
    // - ESM named export: module.initSqlJs
    // - ESM default with named: module.default.initSqlJs
    // - CJS interop: module.default.default
    const initSqlJs =
      module.initSqlJs || module.default?.initSqlJs || module.default?.default || module.default

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
 * Wraps a sql.js prepared statement to implement our Statement interface
 *
 * sql.js statements work differently from better-sqlite3:
 * - bind() and step() are separate operations
 * - get() returns column values as array, not object
 * - We need to handle the conversion to named objects
 */
class SqlJsStatementAdapter<T = unknown> implements Statement<T> {
  private stmt: SqlJsStatement
  private columnNames: string[] = []
  // Cached statement for changes() and last_insert_rowid() queries
  // Created once per adapter instance, reused on every run() call
  private changesStmt: SqlJsStatement

  constructor(
    private readonly db: SqlJsDatabase,
    private readonly sql: string
  ) {
    this.stmt = db.prepare(sql)
    // Get column names from the statement
    this.columnNames = this.stmt.getColumnNames()
    // Cache the changes query statement for performance
    this.changesStmt = db.prepare('SELECT changes() as changes, last_insert_rowid() as lastId')
  }

  private rowToObject(row: SqlJsValue[] | null): T | undefined {
    if (!row) return undefined

    const obj: Record<string, SqlJsValue> = {}
    for (let i = 0; i < this.columnNames.length; i++) {
      obj[this.columnNames[i]] = row[i]
    }
    return obj as T
  }

  run(...params: unknown[]): RunResult {
    // Reset and bind parameters
    this.stmt.reset()
    if (params.length > 0) {
      this.stmt.bind(params as SqlJsBindParams)
    }

    // Execute without fetching results
    this.stmt.step()
    this.stmt.reset()

    // Query changes() and last_insert_rowid() using cached statement
    // This avoids creating a new prepared statement on every run() call
    this.changesStmt.reset()
    this.changesStmt.step()
    const result = this.changesStmt.get()
    this.changesStmt.reset()

    return {
      changes: (result?.[0] as number) ?? 0,
      lastInsertRowid: (result?.[1] as number) ?? 0,
    }
  }

  get(...params: unknown[]): T | undefined {
    this.stmt.reset()
    if (params.length > 0) {
      this.stmt.bind(params as SqlJsBindParams)
    }

    const hasRow = this.stmt.step()
    if (!hasRow) {
      this.stmt.reset()
      return undefined
    }

    const row = this.stmt.get()
    this.stmt.reset()
    return this.rowToObject(row)
  }

  all(...params: unknown[]): T[] {
    this.stmt.reset()
    if (params.length > 0) {
      this.stmt.bind(params as SqlJsBindParams)
    }

    const results: T[] = []
    while (this.stmt.step()) {
      const row = this.stmt.get()
      const obj = this.rowToObject(row)
      if (obj !== undefined) {
        results.push(obj)
      }
    }
    this.stmt.reset()
    return results
  }

  *iterate(...params: unknown[]): IterableIterator<T> {
    this.stmt.reset()
    if (params.length > 0) {
      this.stmt.bind(params as SqlJsBindParams)
    }

    while (this.stmt.step()) {
      const row = this.stmt.get()
      const obj = this.rowToObject(row)
      if (obj !== undefined) {
        yield obj
      }
    }
    this.stmt.reset()
  }

  finalize(): void {
    this.stmt.free()
    this.changesStmt.free()
  }

  bind(...params: unknown[]): this {
    this.stmt.bind(params as SqlJsBindParams)
    return this
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

  constructor(
    private readonly db: SqlJsDatabase,
    private readonly filePath: string,
    options?: DatabaseOptions
  ) {
    this._memory = filePath === ':memory:'
    this._readonly = options?.readonly ?? false
  }

  exec(sql: string): void {
    this.db.run(sql)
  }

  prepare<T = unknown>(sql: string): Statement<T> {
    return new SqlJsStatementAdapter<T>(this.db, sql)
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
      this.db.run(`PRAGMA ${name} = ${value}`)
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

    // Persist to file before closing (if not memory and not readonly)
    if (!this._memory && !this._readonly && this.filePath) {
      this.persist()
    }

    this.db.close()
    this._open = false
  }

  /**
   * Persist the in-memory database to file
   */
  persist(): void {
    if (this._memory || !this.filePath) return

    const data = this.db.export()
    writeFileSync(this.filePath, Buffer.from(data))
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

  // Load existing database from file if it exists
  let data: Uint8Array | undefined
  if (path !== ':memory:' && existsSync(path)) {
    data = readFileSync(path)
  } else if (path !== ':memory:' && options?.fileMustExist) {
    throw new Error(`SQLITE_CANTOPEN: unable to open database file: ${path}`)
  }

  const db = new SQL.Database(data)

  // Set default pragmas for consistency
  // Note: WAL mode is intentionally NOT set for sql.js because:
  // 1. sql.js operates fully in-memory with manual file persistence
  // 2. Journal modes are meaningless without filesystem integration
  // 3. Setting WAL would create false parity expectations with better-sqlite3
  db.run('PRAGMA foreign_keys = ON')

  return new SqlJsDatabaseAdapter(db, path, options)
}

/**
 * Check if fts5-sql-bundle (sql.js with FTS5) is available
 * This always returns true in Node.js since it's a pure JS/WASM module
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
