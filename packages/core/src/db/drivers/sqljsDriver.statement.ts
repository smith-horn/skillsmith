/**
 * SMI-2182: sql.js prepared-statement adapter and the sql.js shapes it wraps.
 *
 * A sibling of `sqljsDriver.ts` (moved out for SMI-7260, which pushed that file
 * past the 500-line standard). Behaviour is unchanged except that every `step()`
 * routes a thrown error through the adapter's `onError`, so a write refused by
 * a read-only handle surfaces as a named error rather than SQLite's bare one.
 */

import type { Statement, RunResult } from '../database-interface.js'

export interface SqlJsDatabase {
  run(sql: string): void
  prepare(sql: string): SqlJsStatement
  export(): Uint8Array
  close(): void
}

export interface SqlJsStatement {
  bind(params?: SqlJsBindParams): boolean
  step(): boolean
  get(): SqlJsValue[]
  getColumnNames(): string[]
  reset(): void
  free(): void
}

// sql.js bind parameters type
export type SqlJsValue = string | number | null | Uint8Array
export type SqlJsBindParams = SqlJsValue[] | Record<string, SqlJsValue>

/**
 * Wraps a sql.js prepared statement to implement our Statement interface
 *
 * sql.js statements work differently from better-sqlite3:
 * - bind() and step() are separate operations
 * - get() returns column values as array, not object
 * - We need to handle the conversion to named objects
 */
export class SqlJsStatementAdapter<T = unknown> implements Statement<T> {
  private stmt: SqlJsStatement
  private columnNames: string[] = []
  // Cached statement for changes() and last_insert_rowid() queries
  // Created once per adapter instance, reused on every run() call
  private changesStmt: SqlJsStatement

  constructor(
    db: SqlJsDatabase,
    sql: string,
    private readonly onError: (error: unknown) => never
  ) {
    this.stmt = db.prepare(sql)
    // Get column names from the statement
    this.columnNames = this.stmt.getColumnNames()
    // Cache the changes query statement for performance
    this.changesStmt = db.prepare('SELECT changes() as changes, last_insert_rowid() as lastId')
  }

  /** `stmt.step()`, with a thrown error reset and routed through `onError`. */
  private step(): boolean {
    try {
      return this.stmt.step()
    } catch (error) {
      this.stmt.reset()
      return this.onError(error)
    }
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
    this.step()
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

    const hasRow = this.step()
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
    while (this.step()) {
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

    while (this.step()) {
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
