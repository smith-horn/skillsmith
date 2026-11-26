/**
 * SMI-7260: lazily-created tables on a read-only handle.
 *
 * Some repositories create their own table on first construction (`CREATE
 * TABLE IF NOT EXISTS ...`) rather than relying on the schema and migrations.
 * On a read-only handle (a WASM handle, or `{ readonly: true }`) that DDL
 * throws when the table is absent, which used to make a read such as a search
 * fail on the repository's constructor. These helpers let such a repository
 * skip its DDL, report whether its table can be used, and stand in for its
 * statements when it cannot: reads find nothing and writes throw a named error.
 */

import type { Database, RunResult, Statement } from '../db/database-interface.js'
import { isReadOnlyHandle, readOnlyReasonOf } from '../db/read-only-reason.js'
import { wasmReadOnlyError } from '../db/wasm-read-only.js'

/** Whether `table` exists in `db`. */
export function hasTable(db: Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) !== undefined
  )
}

/**
 * Run a lazily-created table's DDL unless the handle is read-only, and report
 * whether the table can be used: always on a writable handle, and on a
 * read-only one only if the table already exists.
 */
export function ensureLazyTable(
  db: Database,
  table: string,
  createSchema: (db: Database) => void
): boolean {
  if (!isReadOnlyHandle(db)) {
    createSchema(db)
    return true
  }
  return hasTable(db, table)
}

/** The refusal of a write to a table a read-only handle could not create. */
export function readOnlyWriteError(db: Database): Error {
  return readOnlyReasonOf(db) !== undefined
    ? wasmReadOnlyError(db.name)
    : new Error(`[Skillsmith] Not saved: ${db.name} was opened read-only.`)
}

/**
 * A statement over a table that does not exist on this read-only handle:
 * `get` finds nothing, `all` and `iterate` find no rows, and `run` throws
 * {@link readOnlyWriteError}. Nothing is prepared against the database.
 */
export function absentTableStatement<T = unknown>(db: Database): Statement<T> {
  const statement: Statement<T> = {
    run(): RunResult {
      throw readOnlyWriteError(db)
    },
    get: () => undefined,
    all: () => [],
    *iterate(): IterableIterator<T> {},
    finalize: () => undefined,
    bind: () => statement,
  }
  return statement
}
