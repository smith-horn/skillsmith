/**
 * SMI-2206: Async Schema Functions Tests
 *
 * Tests for async database initialization with WASM fallback support.
 * These tests verify that createDatabaseAsync and openDatabaseAsync work
 * correctly with automatic driver selection.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createDatabaseAsync,
  openDatabaseAsync,
  closeDatabase,
  getSchemaVersion,
  SCHEMA_VERSION,
} from '../../src/db/schema.js'
import type { Database } from '../../src/db/database-interface.js'
import { isBetterSqlite3Available } from '../../src/db/drivers/betterSqlite3Driver.js'

// Track databases to clean up
const testDatabases: Database[] = []
const testPaths: string[] = []

// Unique test directory to avoid collisions
const TEST_DIR = join(tmpdir(), `skillsmith-schema-async-test-${Date.now()}`)

describe('Async Schema Functions (SMI-2206)', () => {
  afterEach(() => {
    // Close all test databases
    for (const db of testDatabases) {
      if (db.open) {
        closeDatabase(db)
      }
    }
    testDatabases.length = 0

    // Clean up test files
    for (const testPath of testPaths) {
      try {
        if (existsSync(testPath)) {
          unlinkSync(testPath)
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    testPaths.length = 0

    // Clean up test directory
    try {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('createDatabaseAsync', () => {
    it('creates in-memory database', async () => {
      // Skip if no driver available
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const db = await createDatabaseAsync(':memory:')
      testDatabases.push(db)

      expect(db.open).toBe(true)
      expect(db.memory).toBe(true)
    })

    it('creates file-based database', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      // Ensure test directory exists
      mkdirSync(TEST_DIR, { recursive: true })

      const testPath = join(TEST_DIR, `test-async-create-${Date.now()}.db`)
      testPaths.push(testPath)

      const db = await createDatabaseAsync(testPath)
      testDatabases.push(db)

      expect(db.open).toBe(true)
      expect(existsSync(testPath)).toBe(true)
    })

    it('initializes schema with FTS5 table', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const db = await createDatabaseAsync(':memory:')
      testDatabases.push(db)

      const result = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skills_fts'")
        .get() as { name: string } | undefined

      expect(result).toBeDefined()
      expect(result?.name).toBe('skills_fts')
    })

    it('creates all required tables', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const db = await createDatabaseAsync(':memory:')
      testDatabases.push(db)

      const tables = db
        .prepare(
          `
          SELECT name FROM sqlite_master
          WHERE type='table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `
        )
        .all() as { name: string }[]

      const tableNames = tables.map((t) => t.name)

      expect(tableNames).toContain('skills')
      expect(tableNames).toContain('skills_fts')
      expect(tableNames).toContain('sources')
      expect(tableNames).toContain('categories')
      expect(tableNames).toContain('cache')
      expect(tableNames).toContain('schema_version')
    })

    it('sets foreign_keys pragma', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const db = await createDatabaseAsync(':memory:')
      testDatabases.push(db)

      const result = db.pragma('foreign_keys') as { foreign_keys: number }[]
      expect(result[0].foreign_keys).toBe(1)
    })

    it('initializes schema version', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const db = await createDatabaseAsync(':memory:')
      testDatabases.push(db)

      const version = getSchemaVersion(db)
      expect(version).toBe(SCHEMA_VERSION)
    })

    it('creates required indexes', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const db = await createDatabaseAsync(':memory:')
      testDatabases.push(db)

      const indexes = db
        .prepare(
          `
          SELECT name FROM sqlite_master
          WHERE type='index' AND name LIKE 'idx_%'
        `
        )
        .all() as { name: string }[]

      const indexNames = indexes.map((i) => i.name)

      expect(indexNames).toContain('idx_skills_author')
      expect(indexNames).toContain('idx_skills_trust_tier')
      expect(indexNames).toContain('idx_skills_quality_score')
    })
  })

  describe('openDatabaseAsync', () => {
    it('opens existing database', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      // Ensure test directory exists
      mkdirSync(TEST_DIR, { recursive: true })

      const testPath = join(TEST_DIR, `test-open-existing-${Date.now()}.db`)
      testPaths.push(testPath)

      // Create first
      const db1 = await createDatabaseAsync(testPath)
      testDatabases.push(db1)
      closeDatabase(db1)
      testDatabases.pop() // Remove from tracking since we closed it

      // Open existing
      const db2 = await openDatabaseAsync(testPath)
      testDatabases.push(db2)

      expect(db2.open).toBe(true)
    })

    it('preserves data when reopening database', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      mkdirSync(TEST_DIR, { recursive: true })

      const testPath = join(TEST_DIR, `test-preserve-data-${Date.now()}.db`)
      testPaths.push(testPath)

      // Create and insert data
      const db1 = await createDatabaseAsync(testPath)
      db1
        .prepare(
          `
        INSERT INTO skills (id, name, description, author)
        VALUES (?, ?, ?, ?)
      `
        )
        .run('test-skill-1', 'Test Skill', 'A test skill', 'test-author')
      closeDatabase(db1)

      // Reopen and verify data persists
      const db2 = await openDatabaseAsync(testPath)
      testDatabases.push(db2)

      const skill = db2.prepare('SELECT * FROM skills WHERE id = ?').get('test-skill-1') as Record<
        string,
        unknown
      >

      expect(skill).toBeDefined()
      expect(skill.name).toBe('Test Skill')
      expect(skill.author).toBe('test-author')
    })

    it('throws for non-existent file', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const nonExistentPath = join(TEST_DIR, 'nonexistent', `db-${Date.now()}.sqlite`)

      await expect(openDatabaseAsync(nonExistentPath)).rejects.toThrow(
        /SQLITE_CANTOPEN|unable to open|directory does not exist/
      )
    })

    it('enables foreign keys after opening', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      mkdirSync(TEST_DIR, { recursive: true })

      const testPath = join(TEST_DIR, `test-fk-open-${Date.now()}.db`)
      testPaths.push(testPath)

      // Create first
      const db1 = await createDatabaseAsync(testPath)
      closeDatabase(db1)

      // Open and check foreign keys
      const db2 = await openDatabaseAsync(testPath)
      testDatabases.push(db2)

      const result = db2.pragma('foreign_keys') as { foreign_keys: number }[]
      expect(result[0].foreign_keys).toBe(1)
    })

    it('runs pending migrations on open', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      mkdirSync(TEST_DIR, { recursive: true })

      const testPath = join(TEST_DIR, `test-migrations-${Date.now()}.db`)
      testPaths.push(testPath)

      // Create database
      const db1 = await createDatabaseAsync(testPath)
      closeDatabase(db1)

      // Open and verify schema version is current
      const db2 = await openDatabaseAsync(testPath)
      testDatabases.push(db2)

      const version = getSchemaVersion(db2)
      expect(version).toBe(SCHEMA_VERSION)
    })
  })

  describe('FTS5 functionality with async creation', () => {
    it('should sync FTS on insert', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const db = await createDatabaseAsync(':memory:')
      testDatabases.push(db)

      db.prepare(
        `
        INSERT INTO skills (id, name, description) VALUES (?, ?, ?)
      `
      ).run('fts-async-test', 'Async Searchable Skill', 'This is async searchable content')

      const results = db
        .prepare(
          `
        SELECT * FROM skills_fts WHERE skills_fts MATCH 'async'
      `
        )
        .all()

      expect(results.length).toBe(1)
    })

    it('should sync FTS on update', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const db = await createDatabaseAsync(':memory:')
      testDatabases.push(db)

      db.prepare(
        `
        INSERT INTO skills (id, name) VALUES (?, ?)
      `
      ).run('fts-async-update', 'Original Async Name')

      db.prepare(
        `
        UPDATE skills SET name = ? WHERE id = ?
      `
      ).run('Updated Async Name', 'fts-async-update')

      const original = db
        .prepare(
          `
        SELECT * FROM skills_fts WHERE skills_fts MATCH 'original'
      `
        )
        .all()

      const updated = db
        .prepare(
          `
        SELECT * FROM skills_fts WHERE skills_fts MATCH 'updated'
      `
        )
        .all()

      expect(original.length).toBe(0)
      expect(updated.length).toBe(1)
    })

    it('should sync FTS on delete', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const db = await createDatabaseAsync(':memory:')
      testDatabases.push(db)

      db.prepare(
        `
        INSERT INTO skills (id, name) VALUES (?, ?)
      `
      ).run('fts-async-delete', 'Deletable Async Skill')

      db.prepare('DELETE FROM skills WHERE id = ?').run('fts-async-delete')

      const results = db
        .prepare(
          `
        SELECT * FROM skills_fts WHERE skills_fts MATCH 'deletable'
      `
        )
        .all()

      expect(results.length).toBe(0)
    })
  })
})
