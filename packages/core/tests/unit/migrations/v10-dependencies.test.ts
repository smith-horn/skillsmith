/**
 * @fileoverview Tests for migration v10 — skill_dependencies table
 * @see SMI-3134: Database Schema — skill_dependencies Table
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, closeDatabase, type Database } from '../../helpers/database.js'
import { getSchemaVersion, SCHEMA_VERSION } from '../../../src/db/schema.js'
import { MIGRATION_V10_SQL } from '../../../src/db/migrations/v10-dependencies.js'

describe('Migration v10: skill_dependencies table', () => {
  let db: Database

  beforeEach(() => {
    db = createTestDatabase()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('creates the skill_dependencies table', () => {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_dependencies'")
      .get() as { name: string } | undefined

    expect(table).toBeDefined()
    expect(table!.name).toBe('skill_dependencies')
  })

  it('has all expected columns with correct types', () => {
    const columns = db.prepare('PRAGMA table_info(skill_dependencies)').all() as Array<{
      name: string
      type: string
      notnull: number
      pk: number
    }>

    const columnMap = new Map(columns.map((c) => [c.name, c]))

    // Verify all expected columns exist
    const expectedColumns = [
      'id',
      'skill_id',
      'dep_type',
      'dep_target',
      'dep_version',
      'dep_source',
      'confidence',
      'metadata',
      'created_at',
      'updated_at',
    ]

    for (const col of expectedColumns) {
      expect(columnMap.has(col), `column '${col}' should exist`).toBe(true)
    }

    // Check NOT NULL constraints
    expect(columnMap.get('skill_id')!.notnull).toBe(1)
    expect(columnMap.get('dep_type')!.notnull).toBe(1)
    expect(columnMap.get('dep_target')!.notnull).toBe(1)
    expect(columnMap.get('dep_source')!.notnull).toBe(1)
    expect(columnMap.get('created_at')!.notnull).toBe(1)
    expect(columnMap.get('updated_at')!.notnull).toBe(1)

    // Optional columns
    expect(columnMap.get('dep_version')!.notnull).toBe(0)
    expect(columnMap.get('confidence')!.notnull).toBe(0)
    expect(columnMap.get('metadata')!.notnull).toBe(0)

    // Primary key
    expect(columnMap.get('id')!.pk).toBe(1)
  })

  it('migration is idempotent — running twice does not error', () => {
    // createTestDatabase already ran the migration once.
    // Running the SQL again should not throw (IF NOT EXISTS).
    expect(() => db.exec(MIGRATION_V10_SQL)).not.toThrow()
  })

  it('schema version is at least 10 after migration', () => {
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(10)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(10)
  })

  it('unique index prevents duplicate (skill_id, dep_type, dep_target, dep_source)', () => {
    const insert = db.prepare(`
      INSERT INTO skill_dependencies (skill_id, dep_type, dep_target, dep_source)
      VALUES (?, ?, ?, ?)
    `)

    // First insert succeeds
    insert.run('author/skill-a', 'mcp_server', '@modelcontextprotocol/server-github', 'declared')

    // Same combination fails with constraint error
    expect(() =>
      insert.run('author/skill-a', 'mcp_server', '@modelcontextprotocol/server-github', 'declared')
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('allows same skill_id + dep_target with different dep_source', () => {
    const insert = db.prepare(`
      INSERT INTO skill_dependencies (skill_id, dep_type, dep_target, dep_source)
      VALUES (?, ?, ?, ?)
    `)

    // Same target, different source — both should succeed
    insert.run('author/skill-a', 'mcp_server', 'server-github', 'declared')
    insert.run('author/skill-a', 'mcp_server', 'server-github', 'inferred_static')

    const count = db.prepare('SELECT COUNT(*) as cnt FROM skill_dependencies').get() as {
      cnt: number
    }
    expect(count.cnt).toBe(2)
  })

  describe('CHECK constraints', () => {
    it('rejects invalid dep_type', () => {
      const insert = db.prepare(`
        INSERT INTO skill_dependencies (skill_id, dep_type, dep_target, dep_source)
        VALUES (?, ?, ?, ?)
      `)

      expect(() => insert.run('author/skill-a', 'invalid_type', 'target', 'declared')).toThrow(
        /CHECK constraint failed/
      )
    })

    it('rejects invalid dep_source', () => {
      const insert = db.prepare(`
        INSERT INTO skill_dependencies (skill_id, dep_type, dep_target, dep_source)
        VALUES (?, ?, ?, ?)
      `)

      expect(() => insert.run('author/skill-a', 'mcp_server', 'target', 'invalid_source')).toThrow(
        /CHECK constraint failed/
      )
    })

    it('accepts all valid dep_type values', () => {
      const validTypes = [
        'skill_hard',
        'skill_soft',
        'skill_peer',
        'mcp_server',
        'model_minimum',
        'model_capability',
        'env_tool',
        'env_os',
        'env_node',
        'cli_version',
        'conflict',
      ]

      const insert = db.prepare(`
        INSERT INTO skill_dependencies (skill_id, dep_type, dep_target, dep_source)
        VALUES (?, ?, ?, ?)
      `)

      for (const depType of validTypes) {
        expect(() =>
          insert.run(`author/skill-${depType}`, depType, `target-${depType}`, 'declared')
        ).not.toThrow()
      }
    })

    it('accepts all valid dep_source values', () => {
      const validSources = ['declared', 'inferred_static', 'inferred_coinstall']

      const insert = db.prepare(`
        INSERT INTO skill_dependencies (skill_id, dep_type, dep_target, dep_source)
        VALUES (?, ?, ?, ?)
      `)

      for (const source of validSources) {
        expect(() =>
          insert.run(`author/skill-${source}`, 'mcp_server', `target-${source}`, source)
        ).not.toThrow()
      }
    })

    it('rejects confidence outside 0.0-1.0 range', () => {
      const insert = db.prepare(`
        INSERT INTO skill_dependencies (skill_id, dep_type, dep_target, dep_source, confidence)
        VALUES (?, ?, ?, ?, ?)
      `)

      expect(() => insert.run('author/skill-a', 'mcp_server', 'target', 'declared', 1.5)).toThrow(
        /CHECK constraint failed/
      )

      expect(() => insert.run('author/skill-b', 'mcp_server', 'target', 'declared', -0.1)).toThrow(
        /CHECK constraint failed/
      )
    })

    it('accepts confidence within 0.0-1.0 range and NULL', () => {
      const insert = db.prepare(`
        INSERT INTO skill_dependencies (skill_id, dep_type, dep_target, dep_source, confidence)
        VALUES (?, ?, ?, ?, ?)
      `)

      // Valid values
      expect(() =>
        insert.run('author/skill-c0', 'mcp_server', 'target-0', 'declared', 0.0)
      ).not.toThrow()
      expect(() =>
        insert.run('author/skill-c1', 'mcp_server', 'target-1', 'declared', 1.0)
      ).not.toThrow()
      expect(() =>
        insert.run('author/skill-c5', 'mcp_server', 'target-5', 'declared', 0.5)
      ).not.toThrow()
      expect(() =>
        insert.run('author/skill-cn', 'mcp_server', 'target-n', 'declared', null)
      ).not.toThrow()
    })
  })

  it('creates expected indexes', () => {
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='skill_dependencies'"
      )
      .all() as Array<{ name: string }>

    const indexNames = indexes.map((i) => i.name)

    expect(indexNames).toContain('idx_skill_deps_skill')
    expect(indexNames).toContain('idx_skill_deps_target')
    expect(indexNames).toContain('idx_skill_deps_type')
    expect(indexNames).toContain('idx_skill_deps_source')
    expect(indexNames).toContain('idx_skill_deps_unique')
  })
})
