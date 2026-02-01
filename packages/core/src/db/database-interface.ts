/**
 * SMI-2180: Database Abstraction Layer
 *
 * Provides a unified interface for SQLite operations that works with both:
 * - better-sqlite3 (native, synchronous) - used in Docker/Linux
 * - sql.js (WASM, async) - used on macOS/WebContainers
 *
 * This abstraction enables cross-platform MCP server execution without
 * requiring native module compilation.
 *
 * @see docs/issues/mcp-server-native-module-fix-wasm.md
 */

/**
 * Result of a database write operation (INSERT, UPDATE, DELETE)
 */
export interface RunResult {
  /** Number of rows changed by the operation */
  changes: number
  /** Row ID of the last inserted row (for INSERT operations) */
  lastInsertRowid: number | bigint
}

/**
 * A prepared SQL statement that can be executed multiple times with different parameters.
 *
 * Type parameter T represents the shape of rows returned by SELECT queries.
 */
export interface Statement<T = unknown> {
  /**
   * Execute a write operation (INSERT, UPDATE, DELETE)
   * @param params - Bound parameters for the SQL statement
   * @returns Result containing changes count and last insert rowid
   */
  run(...params: unknown[]): RunResult

  /**
   * Execute a SELECT query and return the first matching row
   * @param params - Bound parameters for the SQL statement
   * @returns The first row or undefined if no rows match
   */
  get(...params: unknown[]): T | undefined

  /**
   * Execute a SELECT query and return all matching rows
   * @param params - Bound parameters for the SQL statement
   * @returns Array of all matching rows
   */
  all(...params: unknown[]): T[]

  /**
   * Execute a SELECT query and iterate over results
   * Useful for large result sets to avoid loading all rows into memory
   * @param params - Bound parameters for the SQL statement
   * @returns Iterator over matching rows
   */
  iterate(...params: unknown[]): IterableIterator<T>

  /**
   * Release resources associated with this prepared statement
   * Should be called when the statement is no longer needed
   */
  finalize(): void

  /**
   * Bind parameters to the statement for later execution
   * @param params - Parameters to bind
   * @returns The statement for chaining
   */
  bind(...params: unknown[]): this
}

/**
 * Database connection interface that abstracts SQLite operations.
 *
 * Implementations:
 * - BetterSqlite3Database: Wraps better-sqlite3 for native performance
 * - SqlJsDatabase: Wraps sql.js for cross-platform WASM support
 */
export interface Database {
  /**
   * Execute raw SQL without returning results
   * Useful for DDL statements (CREATE, DROP, ALTER) and multi-statement scripts
   * @param sql - SQL statement(s) to execute
   */
  exec(sql: string): void

  /**
   * Prepare a SQL statement for repeated execution
   * @param sql - SQL statement with optional parameter placeholders (?)
   * @returns A prepared statement that can be executed multiple times
   */
  prepare<T = unknown>(sql: string): Statement<T>

  /**
   * Execute a function within a transaction
   * If the function throws, the transaction is rolled back
   *
   * Returns a callable function that executes the transaction when called.
   * For zero-argument functions, call as: db.transaction(fn)()
   *
   * @param fn - Function to execute within transaction
   * @returns A callable transaction function
   */
  transaction<T, Args extends unknown[] = []>(fn: (...args: Args) => T): (...args: Args) => T

  /**
   * Execute a PRAGMA statement and return the result
   * @param pragma - PRAGMA statement (e.g., 'foreign_keys = ON')
   * @returns The PRAGMA result value, or undefined for set operations
   */
  pragma(pragma: string): unknown

  /**
   * Close the database connection and release all resources
   * For file-based databases, this ensures all changes are persisted
   */
  close(): void

  /**
   * Check if the database connection is open
   */
  readonly open: boolean

  /**
   * The file path of the database, or ':memory:' for in-memory databases
   */
  readonly name: string

  /**
   * Whether the database is in-memory
   */
  readonly memory: boolean

  /**
   * Whether the database is read-only
   */
  readonly readonly: boolean
}

/**
 * Options for creating a database connection
 */
export interface DatabaseOptions {
  /** Open database in read-only mode */
  readonly?: boolean
  /** Create database file if it doesn't exist (default: true) */
  fileMustExist?: boolean
  /** Set busy timeout in milliseconds (default: 5000) */
  timeout?: number
  /** Enable verbose logging */
  verbose?: boolean
}

/**
 * Factory function type for creating database connections
 */
export type DatabaseFactory = (
  path: string,
  options?: DatabaseOptions
) => Database | Promise<Database>
