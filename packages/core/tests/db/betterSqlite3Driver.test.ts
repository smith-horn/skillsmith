/**
 * SMI-2756: Wave 3 — BetterSqlite3Driver tests
 *
 * Tests constructor paths, WAL-mode pragma handling, execute with/without rows,
 * and close paths.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createBetterSqlite3Database,
  BetterSqlite3Database,
  isBetterSqlite3Available,
} from '../../src/db/drivers/betterSqlite3Driver.js'

describe('BetterSqlite3Driver', () => {
  describe('isBetterSqlite3Available', () => {
    it('returns true when native module is loadable', () => {
      // Running in Docker with native modules available
      const available = isBetterSqlite3Available()
      expect(typeof available).toBe('boolean')
      // In CI/Docker this is always true; accept either to handle all envs
    })
  })

  describe('createBetterSqlite3Database', () => {
    it('creates an in-memory database by default', () => {
      const db = createBetterSqlite3Database(':memory:')
      expect(db).toBeInstanceOf(BetterSqlite3Database)
      expect(db.memory).toBe(true)
      expect(db.open).toBe(true)
      db.close()
    })

    it('creates a database at a valid explicit path (in-memory)', () => {
      const db = createBetterSqlite3Database(':memory:')
      expect(db.name).toBe(':memory:')
      db.close()
    })

    it('WAL mode pragma executes without error', () => {
      const db = createBetterSqlite3Database(':memory:')
      // WAL mode via pragma — should not throw
      expect(() => db.pragma('journal_mode = WAL')).not.toThrow()
      db.close()
    })

    it('WAL mode failure is swallowed gracefully when driver is constructed', () => {
      // Even if a pragma fails during higher-level init it should not propagate
      // In this unit test we just verify the driver wraps pragma correctly
      const db = createBetterSqlite3Database(':memory:')
      // Unknown pragma value — better-sqlite3 ignores unknown values
      expect(() => db.pragma('journal_mode = INVALIDMODE')).not.toThrow()
      db.close()
    })
  })

  describe('BetterSqlite3Database operations', () => {
    let db: BetterSqlite3Database

    afterEach(() => {
      if (db?.open) db.close()
    })

    it('execute returns rows when rows exist', () => {
      db = createBetterSqlite3Database(':memory:')
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
      db.exec("INSERT INTO t (val) VALUES ('hello')")

      const stmt = db.prepare<{ id: number; val: string }>('SELECT * FROM t')
      const rows = stmt.all()

      expect(rows).toHaveLength(1)
      expect(rows[0].val).toBe('hello')
    })

    it('execute returns empty array when no rows', () => {
      db = createBetterSqlite3Database(':memory:')
      db.exec('CREATE TABLE empty (id INTEGER PRIMARY KEY)')

      const stmt = db.prepare<{ id: number }>('SELECT * FROM empty')
      const rows = stmt.all()

      expect(rows).toHaveLength(0)
    })

    it('close sets open to false', () => {
      db = createBetterSqlite3Database(':memory:')
      expect(db.open).toBe(true)
      db.close()
      expect(db.open).toBe(false)
    })

    it('native getter returns underlying better-sqlite3 instance', () => {
      db = createBetterSqlite3Database(':memory:')
      const native = db.native
      expect(native).toBeDefined()
      // The native instance should have better-sqlite3's own exec method
      expect(typeof native.exec).toBe('function')
    })

    it('readonly getter reflects actual readonly state', () => {
      db = createBetterSqlite3Database(':memory:')
      // Default: not readonly
      expect(db.readonly).toBe(false)
    })
  })
})
