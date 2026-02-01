/**
 * SMI-2182: sql.js Driver Tests
 *
 * Tests for the sql.js WASM driver implementation.
 * Includes both unit tests and parity tests comparing sql.js vs better-sqlite3.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from '../../src/db/database-interface.js'
import {
  createSqlJsDatabase,
  SqlJsDatabaseAdapter,
  isSqlJsAvailable,
} from '../../src/db/drivers/sqljsDriver.js'
import {
  createBetterSqlite3Database,
  isBetterSqlite3Available,
} from '../../src/db/drivers/betterSqlite3Driver.js'

// Helper to generate unique temp file paths
function tempDbPath(): string {
  return join(tmpdir(), `sqljs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

// Cleanup helper
function cleanupFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

describe('sql.js Driver', () => {
  describe('isSqlJsAvailable', () => {
    it('should detect sql.js is installed', () => {
      expect(isSqlJsAvailable()).toBe(true)
    })
  })

  describe('createSqlJsDatabase', () => {
    let db: SqlJsDatabaseAdapter

    afterEach(() => {
      if (db?.open) {
        db.close()
      }
    })

    it('should create an in-memory database', async () => {
      db = await createSqlJsDatabase(':memory:')
      expect(db).toBeDefined()
      expect(db.open).toBe(true)
      expect(db.memory).toBe(true)
      expect(db.name).toBe(':memory:')
    })

    it('should create a file-based database', async () => {
      const path = tempDbPath()
      try {
        db = await createSqlJsDatabase(path)
        expect(db).toBeDefined()
        expect(db.open).toBe(true)
        expect(db.memory).toBe(false)
        expect(db.name).toBe(path)
        db.close()
        expect(existsSync(path)).toBe(true)
      } finally {
        cleanupFile(path)
      }
    })

    it('should throw when file must exist but does not', async () => {
      const path = tempDbPath()
      await expect(createSqlJsDatabase(path, { fileMustExist: true })).rejects.toThrow(
        /SQLITE_CANTOPEN/
      )
    })
  })

  describe('Database operations', () => {
    let db: SqlJsDatabaseAdapter

    beforeEach(async () => {
      db = await createSqlJsDatabase(':memory:')
    })

    afterEach(() => {
      if (db?.open) {
        db.close()
      }
    })

    it('should execute raw SQL with exec()', () => {
      db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO users (name) VALUES ('Alice');
      `)

      const stmt = db.prepare<{ id: number; name: string }>('SELECT * FROM users')
      const rows = stmt.all()
      stmt.finalize()

      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({ id: 1, name: 'Alice' })
    })

    it('should prepare and execute statements', () => {
      db.exec('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL)')

      const insert = db.prepare('INSERT INTO products (name, price) VALUES (?, ?)')
      const result1 = insert.run('Widget', 9.99)
      const result2 = insert.run('Gadget', 19.99)
      insert.finalize()

      expect(result1.changes).toBe(1)
      expect(result1.lastInsertRowid).toBe(1)
      expect(result2.lastInsertRowid).toBe(2)

      const select = db.prepare<{ name: string; price: number }>('SELECT name, price FROM products')
      const products = select.all()
      select.finalize()

      expect(products).toHaveLength(2)
      expect(products[0]).toEqual({ name: 'Widget', price: 9.99 })
      expect(products[1]).toEqual({ name: 'Gadget', price: 19.99 })
    })

    it('should get single row', () => {
      db.exec(`
        CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT);
        INSERT INTO items (value) VALUES ('first'), ('second');
      `)

      const stmt = db.prepare<{ id: number; value: string }>('SELECT * FROM items WHERE id = ?')
      const row = stmt.get(1)
      const noRow = stmt.get(999)
      stmt.finalize()

      expect(row).toEqual({ id: 1, value: 'first' })
      expect(noRow).toBeUndefined()
    })

    it('should iterate over rows', () => {
      db.exec(`
        CREATE TABLE numbers (n INTEGER);
        INSERT INTO numbers (n) VALUES (1), (2), (3), (4), (5);
      `)

      const stmt = db.prepare<{ n: number }>('SELECT n FROM numbers')
      const values: number[] = []
      for (const row of stmt.iterate()) {
        values.push(row.n)
      }
      stmt.finalize()

      expect(values).toEqual([1, 2, 3, 4, 5])
    })

    it('should handle transactions', () => {
      db.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER)')
      db.exec('INSERT INTO accounts (balance) VALUES (100), (200)')

      const transfer = (from: number, to: number, amount: number) => {
        db.transaction(() => {
          db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').run(amount, from)
          db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').run(amount, to)
        })
      }

      transfer(1, 2, 50)

      const stmt = db.prepare<{ id: number; balance: number }>('SELECT * FROM accounts ORDER BY id')
      const accounts = stmt.all()
      stmt.finalize()

      expect(accounts[0].balance).toBe(50)
      expect(accounts[1].balance).toBe(250)
    })

    it('should rollback transaction on error', () => {
      db.exec('CREATE TABLE test (value INTEGER)')
      db.exec('INSERT INTO test (value) VALUES (1)')

      expect(() => {
        db.transaction(() => {
          db.exec('UPDATE test SET value = 2')
          throw new Error('Intentional failure')
        })
      }).toThrow('Intentional failure')

      const stmt = db.prepare<{ value: number }>('SELECT value FROM test')
      const row = stmt.get()
      stmt.finalize()

      expect(row?.value).toBe(1) // Rolled back
    })

    it('should handle pragmas', () => {
      // Set a pragma
      db.pragma('cache_size = 10000')

      // Get a pragma value
      const foreignKeys = db.pragma('foreign_keys')
      expect(foreignKeys).toBe(1) // Default ON in our driver
    })
  })

  describe('File persistence', () => {
    it('should persist data across open/close cycles', async () => {
      const path = tempDbPath()

      try {
        // Create and populate database
        const db1 = await createSqlJsDatabase(path)
        db1.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)')
        db1.exec("INSERT INTO test (value) VALUES ('persisted')")
        db1.close()

        // Reopen and verify data
        const db2 = await createSqlJsDatabase(path)
        const stmt = db2.prepare<{ value: string }>('SELECT value FROM test')
        const row = stmt.get()
        stmt.finalize()
        db2.close()

        expect(row?.value).toBe('persisted')
      } finally {
        cleanupFile(path)
      }
    })

    it('should export database as Uint8Array', async () => {
      const db = await createSqlJsDatabase(':memory:')
      db.exec('CREATE TABLE test (id INTEGER)')
      db.exec('INSERT INTO test (id) VALUES (1), (2), (3)')

      const data = db.export()
      db.close()

      expect(data).toBeInstanceOf(Uint8Array)
      expect(data.length).toBeGreaterThan(0)
    })
  })
})

// Parity tests - comparing sql.js with better-sqlite3
describe('Driver Parity Tests', () => {
  // Skip if better-sqlite3 is not available (e.g., on macOS without Docker)
  const hasBetterSqlite3 = isBetterSqlite3Available()

  describe.skipIf(!hasBetterSqlite3)('sql.js vs better-sqlite3', () => {
    let sqlJsDb: Database
    let betterSqliteDb: Database

    beforeEach(async () => {
      sqlJsDb = await createSqlJsDatabase(':memory:')
      betterSqliteDb = createBetterSqlite3Database(':memory:')

      // Create identical schema
      const schema = `
        CREATE TABLE skills (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          author TEXT NOT NULL,
          description TEXT,
          score REAL DEFAULT 0
        );
        CREATE INDEX idx_skills_author ON skills(author);
      `
      sqlJsDb.exec(schema)
      betterSqliteDb.exec(schema)
    })

    afterEach(() => {
      sqlJsDb?.close()
      betterSqliteDb?.close()
    })

    it('should return identical results for INSERT', () => {
      const sql = 'INSERT INTO skills (name, author, description, score) VALUES (?, ?, ?, ?)'

      const sqlJsStmt = sqlJsDb.prepare(sql)
      const betterStmt = betterSqliteDb.prepare(sql)

      const sqlJsResult = sqlJsStmt.run('test-skill', 'test-author', 'A test skill', 85.5)
      const betterResult = betterStmt.run('test-skill', 'test-author', 'A test skill', 85.5)

      sqlJsStmt.finalize()
      betterStmt.finalize()

      expect(sqlJsResult.changes).toBe(betterResult.changes)
      expect(Number(sqlJsResult.lastInsertRowid)).toBe(Number(betterResult.lastInsertRowid))
    })

    it('should return identical results for SELECT', () => {
      // Insert test data
      const insert = 'INSERT INTO skills (name, author, score) VALUES (?, ?, ?)'
      sqlJsDb.prepare(insert).run('skill-a', 'author-1', 90)
      sqlJsDb.prepare(insert).run('skill-b', 'author-2', 80)
      betterSqliteDb.prepare(insert).run('skill-a', 'author-1', 90)
      betterSqliteDb.prepare(insert).run('skill-b', 'author-2', 80)

      // Query and compare
      const query = 'SELECT * FROM skills ORDER BY name'
      const sqlJsRows = sqlJsDb.prepare(query).all()
      const betterRows = betterSqliteDb.prepare(query).all()

      expect(sqlJsRows).toEqual(betterRows)
    })

    it('should return identical results for UPDATE', () => {
      // Insert test data
      sqlJsDb.exec("INSERT INTO skills (name, author) VALUES ('skill', 'author')")
      betterSqliteDb.exec("INSERT INTO skills (name, author) VALUES ('skill', 'author')")

      const update = 'UPDATE skills SET score = ? WHERE name = ?'
      const sqlJsResult = sqlJsDb.prepare(update).run(100, 'skill')
      const betterResult = betterSqliteDb.prepare(update).run(100, 'skill')

      expect(sqlJsResult.changes).toBe(betterResult.changes)
    })

    it('should return identical results for DELETE', () => {
      // Insert test data
      sqlJsDb.exec("INSERT INTO skills (name, author) VALUES ('to-delete', 'author')")
      betterSqliteDb.exec("INSERT INTO skills (name, author) VALUES ('to-delete', 'author')")

      const del = 'DELETE FROM skills WHERE name = ?'
      const sqlJsResult = sqlJsDb.prepare(del).run('to-delete')
      const betterResult = betterSqliteDb.prepare(del).run('to-delete')

      expect(sqlJsResult.changes).toBe(betterResult.changes)
    })

    it('should handle transactions identically', () => {
      // Insert initial data
      sqlJsDb.exec("INSERT INTO skills (name, author, score) VALUES ('skill', 'author', 50)")
      betterSqliteDb.exec("INSERT INTO skills (name, author, score) VALUES ('skill', 'author', 50)")

      // Transaction that modifies and reads
      const transactionFn = (db: Database) => {
        return db.transaction(() => {
          db.prepare('UPDATE skills SET score = score + 10').run()
          return db.prepare<{ score: number }>('SELECT score FROM skills').get()
        })
      }

      const sqlJsResult = transactionFn(sqlJsDb)
      const betterResult = transactionFn(betterSqliteDb)

      expect(sqlJsResult).toEqual(betterResult)
      expect(sqlJsResult?.score).toBe(60)
    })

    it('should handle NULL values identically', () => {
      // Insert with NULL description
      sqlJsDb.exec("INSERT INTO skills (name, author) VALUES ('nullable', 'author')")
      betterSqliteDb.exec("INSERT INTO skills (name, author) VALUES ('nullable', 'author')")

      const query = 'SELECT * FROM skills WHERE name = ?'
      const sqlJsRow = sqlJsDb.prepare(query).get('nullable')
      const betterRow = betterSqliteDb.prepare(query).get('nullable')

      expect(sqlJsRow).toEqual(betterRow)
    })

    it('should return undefined for non-existent rows', () => {
      const query = 'SELECT * FROM skills WHERE id = ?'
      const sqlJsRow = sqlJsDb.prepare(query).get(99999)
      const betterRow = betterSqliteDb.prepare(query).get(99999)

      expect(sqlJsRow).toBeUndefined()
      expect(betterRow).toBeUndefined()
    })
  })
})
