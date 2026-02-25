/**
 * SMI-2756: Tests for sqljsDriver.ts — WASM driver behaviour
 *
 * Tests the sql.js WASM driver which is used when native modules are unavailable.
 * Note: vi.isolateModules() is not available in Vitest 4.x; native-fallback paths
 * are tested via the public API (createSqlJsDatabase, isSqlJsAvailable) directly.
 */

import { describe, it, expect } from 'vitest'
import {
  createSqlJsDatabase,
  SqlJsDatabaseAdapter,
  isSqlJsAvailable,
} from '../../src/db/drivers/sqljsDriver.js'

describe('sqljsDriver — availability', () => {
  it('isSqlJsAvailable returns true when fts5-sql-bundle is installed', () => {
    // fts5-sql-bundle is a runtime dependency — always installed in Docker
    expect(isSqlJsAvailable()).toBe(true)
  })
})

describe('sqljsDriver — createSqlJsDatabase (WASM mode)', () => {
  it('creates an in-memory WASM database', async () => {
    const db = await createSqlJsDatabase(':memory:')
    expect(db).toBeInstanceOf(SqlJsDatabaseAdapter)
    expect(db.memory).toBe(true)
    expect(db.open).toBe(true)
    db.close()
  })

  it('loads the WASM binary from expected module (fts5-sql-bundle)', async () => {
    // If fts5-sql-bundle fails to load, createSqlJsDatabase would throw.
    // Successful construction proves the WASM binary was located and loaded.
    const db = await createSqlJsDatabase(':memory:')
    expect(db).toBeDefined()
    db.close()
  })

  it('execute works in WASM mode (DDL + DML + SELECT)', async () => {
    const db = await createSqlJsDatabase(':memory:')
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)')
    db.exec("INSERT INTO items VALUES (1, 'alpha')")
    db.exec("INSERT INTO items VALUES (2, 'beta')")

    const stmt = db.prepare<{ id: number; name: string }>('SELECT * FROM items ORDER BY id')
    const rows = stmt.all()

    expect(rows).toHaveLength(2)
    expect(rows[0].name).toBe('alpha')
    expect(rows[1].name).toBe('beta')
    stmt.finalize()
    db.close()
  })

  it('close() in WASM mode completes without error', async () => {
    const db = await createSqlJsDatabase(':memory:')
    expect(() => db.close()).not.toThrow()
  })

  it('double close() does not throw (open guard)', async () => {
    const db = await createSqlJsDatabase(':memory:')
    db.close()
    // Second close is a no-op due to _open guard in SqlJsDatabaseAdapter
    expect(() => db.close()).not.toThrow()
  })

  it('db.name returns the path supplied at construction (:memory:)', async () => {
    const db = await createSqlJsDatabase(':memory:')
    expect(db.name).toBe(':memory:')
    db.close()
  })
})

describe('sqljsDriver — error handling', () => {
  it('throws descriptive error when path does not exist with fileMustExist', async () => {
    const nonexistentPath = '/nonexistent/path/to/db.db'

    await expect(
      createSqlJsDatabase(nonexistentPath, { fileMustExist: true })
    ).rejects.toThrow(/SQLITE_CANTOPEN/)
  })
})
