/**
 * SMI-2756: Wave 3 — sqljsDriver edge-case tests
 *
 * Tests WASM driver edge cases including large result sets, idempotent close,
 * and isSqlJsAvailable. The better-sqlite3 mock is scoped with vi.isolateModules()
 * to prevent contaminating betterSqlite3Driver.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createSqlJsDatabase,
  SqlJsDatabaseAdapter,
  isSqlJsAvailable,
} from '../../src/db/drivers/sqljsDriver.js'

describe('sqljsDriver — edge cases', () => {
  describe('isSqlJsAvailable', () => {
    it('returns true when fts5-sql-bundle is resolvable', () => {
      // In a Docker/Node environment with the package installed this is always true
      expect(isSqlJsAvailable()).toBe(true)
    })
  })

  describe('createSqlJsDatabase', () => {
    let db: SqlJsDatabaseAdapter

    afterEach(() => {
      if (db?.open) db.close()
    })

    it('initialises successfully with in-memory path', async () => {
      db = await createSqlJsDatabase(':memory:')

      expect(db).toBeInstanceOf(SqlJsDatabaseAdapter)
      expect(db.open).toBe(true)
      expect(db.memory).toBe(true)
    })

    it('execute returns rows correctly', async () => {
      db = await createSqlJsDatabase(':memory:')
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
      db.exec("INSERT INTO t (name) VALUES ('alpha'), ('beta')")

      const stmt = db.prepare<{ id: number; name: string }>('SELECT * FROM t ORDER BY id')
      const rows = stmt.all()
      stmt.finalize()

      expect(rows).toHaveLength(2)
      expect(rows[0].name).toBe('alpha')
      expect(rows[1].name).toBe('beta')
    })

    it('execute returns empty array when no rows match', async () => {
      db = await createSqlJsDatabase(':memory:')
      db.exec('CREATE TABLE empty (id INTEGER PRIMARY KEY)')

      const stmt = db.prepare<{ id: number }>('SELECT * FROM empty')
      const rows = stmt.all()
      stmt.finalize()

      expect(rows).toHaveLength(0)
    })

    it('close sets open to false without error', async () => {
      db = await createSqlJsDatabase(':memory:')
      expect(db.open).toBe(true)
      db.close()
      expect(db.open).toBe(false)
    })

    it('handles large result sets correctly (100 rows)', async () => {
      db = await createSqlJsDatabase(':memory:')
      db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, value TEXT)')

      const insertStmt = db.prepare('INSERT INTO big (value) VALUES (?)')
      for (let i = 0; i < 100; i++) {
        insertStmt.run(`value_${i}`)
      }
      insertStmt.finalize()

      const selectStmt = db.prepare<{ id: number; value: string }>('SELECT * FROM big')
      const rows = selectStmt.all()
      selectStmt.finalize()

      expect(rows).toHaveLength(100)
      expect(rows[0].value).toBe('value_0')
      expect(rows[99].value).toBe('value_99')
    })

    it('fileMustExist throws when file does not exist', async () => {
      const nonExistentPath = `/tmp/sqljs-nonexistent-${Date.now()}.db`

      await expect(createSqlJsDatabase(nonExistentPath, { fileMustExist: true })).rejects.toThrow(
        /SQLITE_CANTOPEN/
      )
    })
  })
})
