/**
 * SMI-2756: Wave 3 — sqljsDriver edge-case tests
 *
 * Tests WASM driver edge cases including large result sets, idempotent close,
 * and isSqlJsAvailable. The better-sqlite3 mock is scoped with vi.isolateModules()
 * to prevent contaminating betterSqlite3Driver.test.ts.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSqlJsDatabase,
  SqlJsDatabaseAdapter,
  isSqlJsAvailable,
} from '../../src/db/drivers/sqljsDriver.js'

// SMI-5997: sqljsDriver.ts imports writeFileSync from 'node:fs' as a live ESM
// binding, which vi.spyOn cannot redefine ("Module namespace is not
// configurable in ESM"). vi.mock + importOriginal is the supported way to
// intercept a single named export while passing everything else through.
const failNextWrite = vi.hoisted(() => ({ value: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (failNextWrite.value) {
        failNextWrite.value = false
        throw new Error('simulated crash mid-write')
      }
      return actual.writeFileSync(...args)
    },
  }
})

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

  describe('persist() — atomic write (SMI-5997)', () => {
    let dir: string
    let dbPath: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'sqljs-persist-'))
      dbPath = join(dir, 'test.db')
    })

    afterEach(() => {
      failNextWrite.value = false
      rmSync(dir, { recursive: true, force: true })
    })

    it('writes via temp file + rename, leaving no leftover .tmp file', async () => {
      const db = await createSqlJsDatabase(dbPath)
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
      db.exec("INSERT INTO t (name) VALUES ('alpha')")
      db.persist()

      expect(existsSync(dbPath)).toBe(true)
      expect(existsSync(`${dbPath}.tmp`)).toBe(false)
      expect(readFileSync(dbPath).length).toBeGreaterThan(0)

      db.close()
    })

    it('leaves the original file byte-for-byte untouched if the write is interrupted', async () => {
      const db = await createSqlJsDatabase(dbPath)
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
      db.exec("INSERT INTO t (name) VALUES ('alpha')")
      db.persist()

      const originalContent = readFileSync(dbPath)
      expect(originalContent.length).toBeGreaterThan(0)

      db.exec("INSERT INTO t (name) VALUES ('beta')")

      // Simulate a crash/kill mid-write: writeFileSync (to the temp file)
      // throws before rename() ever runs.
      failNextWrite.value = true

      expect(() => db.persist()).toThrow('simulated crash mid-write')

      // Reproduces the SMI-5997 incident check in reverse: the real file
      // must never be truncated by a failed write, only ever replaced
      // wholesale by a successful rename().
      expect(readFileSync(dbPath)).toEqual(originalContent)
      expect(existsSync(`${dbPath}.tmp`)).toBe(false)

      db.close()
    })
  })
})
