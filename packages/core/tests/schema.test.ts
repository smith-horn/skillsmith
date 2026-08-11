/**
 * SMI-577: Database Schema Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from '../src/db/database-interface.js'
import {
  createDatabase,
  openDatabase,
  closeDatabase,
  getSchemaVersion,
  runMigrations,
  SCHEMA_VERSION,
} from '../src/db/schema.js'
import { isBetterSqlite3Available } from '../src/db/drivers/betterSqlite3Driver.js'

describe('Database Schema', () => {
  let db: Database

  beforeEach(() => {
    db = createDatabase(':memory:')
  })

  afterEach(() => {
    if (db) closeDatabase(db)
  })

  describe('createDatabase', () => {
    it('should create database with correct schema version', () => {
      const version = getSchemaVersion(db)
      expect(version).toBe(SCHEMA_VERSION)
    })

    it('should create all required tables', () => {
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

    it('should enable WAL mode (only for file-based DBs)', () => {
      // Note: In-memory databases cannot use WAL mode, they use 'memory' journal mode
      const result = db.pragma('journal_mode') as { journal_mode: string }[]
      // In-memory uses 'memory', file-based would use 'wal'
      expect(['memory', 'wal']).toContain(result[0].journal_mode)
    })

    it('should enable foreign keys', () => {
      const result = db.pragma('foreign_keys') as { foreign_keys: number }[]
      expect(result[0].foreign_keys).toBe(1)
    })
  })

  describe('skills table', () => {
    it('should insert and retrieve a skill', () => {
      const id = 'test-skill-1'
      db.prepare(
        `
        INSERT INTO skills (id, name, description, author, repo_url, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run(id, 'Test Skill', 'A test skill', 'author', 'https://github.com/test/skill', '["test"]')

      const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Record<
        string,
        unknown
      >

      expect(skill.name).toBe('Test Skill')
      expect(skill.description).toBe('A test skill')
      expect(skill.author).toBe('author')
      expect(skill.trust_tier).toBe('unknown')
    })

    it('should enforce repo_url uniqueness', () => {
      const insert = db.prepare(`
        INSERT INTO skills (id, name, repo_url) VALUES (?, ?, ?)
      `)

      insert.run('skill-1', 'Skill 1', 'https://github.com/test/skill')

      expect(() => {
        insert.run('skill-2', 'Skill 2', 'https://github.com/test/skill')
      }).toThrow(/UNIQUE/)
    })

    it('should validate quality_score range', () => {
      const insert = db.prepare(`
        INSERT INTO skills (id, name, quality_score) VALUES (?, ?, ?)
      `)

      expect(() => {
        insert.run('skill-bad', 'Bad Skill', 1.5)
      }).toThrow(/CHECK/)

      expect(() => {
        insert.run('skill-bad', 'Bad Skill', -0.1)
      }).toThrow(/CHECK/)

      // Valid values should work
      insert.run('skill-good', 'Good Skill', 0.5)
      const skill = db
        .prepare('SELECT quality_score FROM skills WHERE id = ?')
        .get('skill-good') as { quality_score: number }
      expect(skill.quality_score).toBe(0.5)
    })

    it('should validate trust_tier values', () => {
      const insert = db.prepare(`
        INSERT INTO skills (id, name, trust_tier) VALUES (?, ?, ?)
      `)

      expect(() => {
        insert.run('skill-bad', 'Bad Skill', 'invalid')
      }).toThrow(/CHECK/)

      // Valid values should work
      insert.run('skill-verified', 'Verified Skill', 'verified')
      const skill = db
        .prepare('SELECT trust_tier FROM skills WHERE id = ?')
        .get('skill-verified') as { trust_tier: string }
      expect(skill.trust_tier).toBe('verified')
    })
  })

  describe('FTS5 triggers', () => {
    it('should sync FTS on insert', () => {
      db.prepare(
        `
        INSERT INTO skills (id, name, description) VALUES (?, ?, ?)
      `
      ).run('fts-test', 'Searchable Skill', 'This is searchable content')

      const results = db
        .prepare(
          `
        SELECT * FROM skills_fts WHERE skills_fts MATCH 'searchable'
      `
        )
        .all()

      expect(results.length).toBe(1)
    })

    it('should sync FTS on update', () => {
      db.prepare(
        `
        INSERT INTO skills (id, name) VALUES (?, ?)
      `
      ).run('fts-update', 'Original Name')

      db.prepare(
        `
        UPDATE skills SET name = ? WHERE id = ?
      `
      ).run('Updated Name', 'fts-update')

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

    it('should sync FTS on delete', () => {
      db.prepare(
        `
        INSERT INTO skills (id, name) VALUES (?, ?)
      `
      ).run('fts-delete', 'Deletable Skill')

      db.prepare('DELETE FROM skills WHERE id = ?').run('fts-delete')

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

  describe('runMigrations', () => {
    it('should not run migrations when schema is current', () => {
      const count = runMigrations(db)
      expect(count).toBe(0)
    })
  })

  describe('indexes', () => {
    it('should create required indexes', () => {
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

  describe('openDatabase — empty/corrupt database detection (SMI-5997)', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'schema-open-sync-'))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('throws an actionable error for a 0-byte file (no tables, no schema_version)', () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const testPath = join(dir, 'empty-corrupt.db')
      // Reproduces the SMI-5997 incident via the deprecated sync path
      // (packages/cli/src/commands/merge.ts still calls openDatabase()
      // directly) — SQLite treats a 0-byte file as a valid, openable, empty
      // database, so this must be caught by the zero-table check rather
      // than a native SQLITE_CANTOPEN/corruption error.
      writeFileSync(testPath, Buffer.alloc(0))

      expect(() => openDatabase(testPath)).toThrow(/empty or corrupt/)
    })

    it('still treats a file with real tables but no schema_version as a legacy import', () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const testPath = join(dir, 'legacy-import.db')

      const seedDb = createDatabase(testPath)
      seedDb.exec('DROP TABLE schema_version')
      closeDatabase(seedDb)

      const reopened = openDatabase(testPath)
      expect(reopened.open).toBe(true)
      const version = getSchemaVersion(reopened)
      expect(version).toBe(SCHEMA_VERSION)
      closeDatabase(reopened)
    })
  })

  describe('closeDatabase (SMI-4640)', () => {
    it('tolerates undefined without throwing', () => {
      expect(() => closeDatabase(undefined as unknown as Database)).not.toThrow()
    })

    it('tolerates null without throwing', () => {
      expect(() => closeDatabase(null as unknown as Database)).not.toThrow()
    })

    it('still closes a real database', () => {
      const realDb = createDatabase(':memory:')
      expect(() => closeDatabase(realDb)).not.toThrow()
    })
  })
})
