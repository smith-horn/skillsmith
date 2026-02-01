/**
 * SMI-2180: Database Abstraction Layer Tests
 *
 * Tests the database interface contracts and driver implementations.
 * These tests should pass with any conforming driver (better-sqlite3, sql.js).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database, Statement, RunResult } from '../../src/db/database-interface.js'
import {
  createDatabaseSync,
  createDatabaseAsync,
  detectAvailableDrivers,
  getBestDriver,
} from '../../src/db/createDatabase.js'
import {
  isBetterSqlite3Available,
  BetterSqlite3Database,
} from '../../src/db/drivers/betterSqlite3Driver.js'

describe('Database Abstraction Layer', () => {
  describe('Driver Detection', () => {
    it('should detect available drivers', () => {
      const drivers = detectAvailableDrivers()
      expect(drivers).toBeInstanceOf(Array)
      expect(drivers.length).toBeGreaterThan(0)

      // Each driver should have required fields
      for (const driver of drivers) {
        expect(driver).toHaveProperty('type')
        expect(driver).toHaveProperty('available')
        expect(typeof driver.available).toBe('boolean')
      }
    })

    it('should get best available driver', () => {
      const best = getBestDriver()
      // In Docker environment, better-sqlite3 should be available
      if (isBetterSqlite3Available()) {
        expect(best).toBe('better-sqlite3')
      }
    })

    it('should detect better-sqlite3 availability', () => {
      const available = isBetterSqlite3Available()
      expect(typeof available).toBe('boolean')
    })
  })

  describe('Database Interface Contract', () => {
    let db: Database

    beforeEach(() => {
      // Skip if no driver available
      if (!isBetterSqlite3Available()) {
        return
      }
      db = createDatabaseSync(':memory:')
    })

    afterEach(() => {
      if (db?.open) {
        db.close()
      }
    })

    it('should create in-memory database', () => {
      if (!isBetterSqlite3Available()) return

      expect(db).toBeDefined()
      expect(db.open).toBe(true)
      expect(db.memory).toBe(true)
    })

    it('should execute raw SQL', () => {
      if (!isBetterSqlite3Available()) return

      expect(() => {
        db.exec(`
          CREATE TABLE test (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL
          )
        `)
      }).not.toThrow()
    })

    it('should prepare and execute statements', () => {
      if (!isBetterSqlite3Available()) return

      db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')

      const insertStmt = db.prepare<{ id: number; name: string }>(
        'INSERT INTO test (name) VALUES (?)'
      )
      const result = insertStmt.run('Alice')

      expect(result.changes).toBe(1)
      expect(result.lastInsertRowid).toBe(1)
    })

    it('should query single row with get()', () => {
      if (!isBetterSqlite3Available()) return

      db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
      db.exec("INSERT INTO test (name) VALUES ('Alice'), ('Bob')")

      const stmt = db.prepare<{ id: number; name: string }>(
        'SELECT * FROM test WHERE name = ?'
      )
      const row = stmt.get('Alice')

      expect(row).toEqual({ id: 1, name: 'Alice' })
    })

    it('should return undefined for non-existent row', () => {
      if (!isBetterSqlite3Available()) return

      db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')

      const stmt = db.prepare<{ id: number; name: string }>(
        'SELECT * FROM test WHERE name = ?'
      )
      const row = stmt.get('NonExistent')

      expect(row).toBeUndefined()
    })

    it('should query multiple rows with all()', () => {
      if (!isBetterSqlite3Available()) return

      db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
      db.exec("INSERT INTO test (name) VALUES ('Alice'), ('Bob'), ('Charlie')")

      const stmt = db.prepare<{ id: number; name: string }>('SELECT * FROM test')
      const rows = stmt.all()

      expect(rows).toHaveLength(3)
      expect(rows[0].name).toBe('Alice')
      expect(rows[1].name).toBe('Bob')
      expect(rows[2].name).toBe('Charlie')
    })

    it('should iterate over rows with iterate()', () => {
      if (!isBetterSqlite3Available()) return

      db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
      db.exec("INSERT INTO test (name) VALUES ('Alice'), ('Bob')")

      const stmt = db.prepare<{ id: number; name: string }>('SELECT * FROM test')
      const names: string[] = []

      for (const row of stmt.iterate()) {
        names.push(row.name)
      }

      expect(names).toEqual(['Alice', 'Bob'])
    })

    it('should execute transactions', () => {
      if (!isBetterSqlite3Available()) return

      db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, balance INTEGER)')
      db.exec('INSERT INTO test (balance) VALUES (100), (50)')

      const transfer = () => {
        const withdraw = db.prepare('UPDATE test SET balance = balance - ? WHERE id = ?')
        const deposit = db.prepare('UPDATE test SET balance = balance + ? WHERE id = ?')

        withdraw.run(30, 1)
        deposit.run(30, 2)

        return 'success'
      }

      const result = db.transaction(transfer)
      expect(result).toBe('success')

      // Verify balances
      const stmt = db.prepare<{ balance: number }>('SELECT balance FROM test WHERE id = ?')
      expect(stmt.get(1)?.balance).toBe(70)
      expect(stmt.get(2)?.balance).toBe(80)
    })

    it('should execute pragma statements', () => {
      if (!isBetterSqlite3Available()) return

      // Set pragma
      db.pragma('foreign_keys = ON')

      // Get pragma value
      const result = db.pragma('foreign_keys')
      expect(result).toBeDefined()
    })

    it('should close database', () => {
      if (!isBetterSqlite3Available()) return

      expect(db.open).toBe(true)
      db.close()
      expect(db.open).toBe(false)
    })

    it('should expose database properties', () => {
      if (!isBetterSqlite3Available()) return

      expect(db.name).toBe(':memory:')
      expect(db.memory).toBe(true)
      expect(db.readonly).toBe(false)
    })
  })

  describe('Async Database Creation', () => {
    it('should create database asynchronously', async () => {
      if (!isBetterSqlite3Available()) return

      const db = await createDatabaseAsync(':memory:')
      expect(db).toBeDefined()
      expect(db.open).toBe(true)
      db.close()
    })
  })

  describe('BetterSqlite3Database Wrapper', () => {
    it('should provide access to native instance', () => {
      if (!isBetterSqlite3Available()) return

      const db = createDatabaseSync(':memory:')
      expect(db).toBeInstanceOf(BetterSqlite3Database)

      const native = (db as BetterSqlite3Database).native
      expect(native).toBeDefined()
      expect(native.open).toBe(true)

      db.close()
    })
  })

  describe('Error Handling', () => {
    it('should throw on invalid SQL', () => {
      if (!isBetterSqlite3Available()) return

      const db = createDatabaseSync(':memory:')

      expect(() => {
        db.exec('INVALID SQL STATEMENT')
      }).toThrow()

      db.close()
    })

    it('should throw on constraint violation', () => {
      if (!isBetterSqlite3Available()) return

      const db = createDatabaseSync(':memory:')
      db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT UNIQUE)')
      db.exec("INSERT INTO test (name) VALUES ('Alice')")

      expect(() => {
        db.exec("INSERT INTO test (name) VALUES ('Alice')")
      }).toThrow()

      db.close()
    })
  })
})
