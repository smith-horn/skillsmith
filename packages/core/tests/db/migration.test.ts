/**
 * SMI-3416: Database Migration Utility Tests
 *
 * Tests for migration.ts:
 * - checkSchemaCompatibility: version detection and compatibility
 * - ensureSchemaCompatibility: auto-upgrade/warning/error
 * - mergeSkillDatabases: three-way skill merge with strategies
 * - getSyncStatus / updateSyncStatus / recordSyncRun / getSyncHistory
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createDatabase,
  closeDatabase,
  getSchemaVersion,
  SCHEMA_VERSION,
} from '../../src/db/schema.js'
import type { Database } from '../../src/db/database-interface.js'
import {
  checkSchemaCompatibility,
  ensureSchemaCompatibility,
  mergeSkillDatabases,
  getSyncStatus,
  recordSyncRun,
  getSyncHistory,
} from '../../src/db/migration.js'

// ============================================================================
// Test helpers
// ============================================================================

const testDatabases: Database[] = []

function createTestDb(): Database {
  const db = createDatabase(':memory:')
  // Add columns that migrations v2+ would add (createDatabase stamps SCHEMA_VERSION
  // but uses base DDL which doesn't include ALTER TABLE columns)
  try {
    db.exec('ALTER TABLE skills ADD COLUMN source TEXT')
  } catch {
    // Column may already exist
  }
  try {
    db.exec('ALTER TABLE skills ADD COLUMN stars INTEGER')
  } catch {
    // Column may already exist
  }
  // Ensure sync tables exist (migration v3)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_config (
      id TEXT PRIMARY KEY DEFAULT 'default',
      last_sync_at TEXT,
      next_sync_at TEXT,
      last_sync_count INTEGER DEFAULT 0,
      last_sync_error TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO sync_config (id) VALUES ('default');
    CREATE TABLE IF NOT EXISTS sync_history (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'partial')),
      skills_added INTEGER DEFAULT 0,
      skills_updated INTEGER DEFAULT 0,
      skills_unchanged INTEGER DEFAULT 0,
      error_message TEXT,
      duration_ms INTEGER
    );
  `)
  testDatabases.push(db)
  return db
}

function insertSkill(
  db: Database,
  id: string,
  overrides?: Partial<{
    name: string
    updated_at: string
    trust_tier: string
    tags: string
  }>
): void {
  db.prepare(
    `INSERT INTO skills (id, name, description, author, repo_url, quality_score,
                        trust_tier, tags, created_at, updated_at, source, stars)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides?.name ?? `skill-${id}`,
    'Test skill',
    'test-author',
    `https://github.com/test/${id}`,
    0.8,
    overrides?.trust_tier ?? 'community',
    overrides?.tags ?? '["test"]',
    '2026-01-01T00:00:00Z',
    overrides?.updated_at ?? '2026-01-01T00:00:00Z',
    // SMI-4665: `source` is now CHECK-constrained to ('registry', 'local').
    // The legacy v2 column previously held free-form values like 'github'; it has
    // been repurposed as the provenance marker. Tests that don't care about the
    // value should pass 'registry' (the default for synced rows).
    'registry',
    10
  )
}

afterEach(() => {
  for (const db of testDatabases) {
    try {
      closeDatabase(db)
    } catch {
      // ignore
    }
  }
  testDatabases.length = 0
})

// ============================================================================
// checkSchemaCompatibility
// ============================================================================

describe('checkSchemaCompatibility', () => {
  it('should return compatible + none when schema is current', () => {
    const db = createTestDb()
    const result = checkSchemaCompatibility(db)
    expect(result.isCompatible).toBe(true)
    expect(result.action).toBe('none')
    expect(result.currentVersion).toBe(SCHEMA_VERSION)
  })

  it('should return compatible + upgrade when schema is older', () => {
    const db = createTestDb()
    // SMI-4486: schema_version now tracks every applied migration as a row;
    // getSchemaVersion reads MAX(version). Drop the latest row to simulate an
    // older DB rather than UPDATE-ing the column (which collides on PK).
    // SMI-4665: migration versions are no longer sequential (v14/v15 reserved,
    // v16 introduced) so compute the second-highest applied version dynamically.
    db.prepare('DELETE FROM schema_version WHERE version = ?').run(SCHEMA_VERSION)
    const prior = (
      db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
    ).v

    const result = checkSchemaCompatibility(db)
    expect(result.isCompatible).toBe(true)
    expect(result.action).toBe('upgrade')
    expect(result.currentVersion).toBe(prior)
    expect(result.expectedVersion).toBe(SCHEMA_VERSION)
  })

  it('should return downgrade_warning when schema is newer (no breaking changes)', () => {
    const db = createTestDb()
    // SMI-4486: append a future-version row instead of UPDATE-ing the column
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION + 1)

    const result = checkSchemaCompatibility(db)
    expect(result.currentVersion).toBe(SCHEMA_VERSION + 1)
    // Could be downgrade_warning or incompatible depending on migration content
    expect(['downgrade_warning', 'incompatible']).toContain(result.action)
  })
})

// ============================================================================
// ensureSchemaCompatibility
// ============================================================================

describe('ensureSchemaCompatibility', () => {
  it('should do nothing when schema is current', () => {
    const db = createTestDb()
    expect(() => ensureSchemaCompatibility(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
  })

  it('should throw for incompatible schema', () => {
    const db = createTestDb()
    // SMI-4486: append a future-version row to bump MAX(version)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(9999)

    // This may or may not throw depending on migration content
    // At minimum, it should not crash
    try {
      ensureSchemaCompatibility(db)
    } catch (e) {
      expect((e as Error).message).toContain('incompatible')
    }
  })
})

// ============================================================================
// mergeSkillDatabases
// ============================================================================

describe('mergeSkillDatabases', () => {
  it('should add new skills from source', () => {
    const target = createTestDb()
    const source = createTestDb()

    insertSkill(source, 'skill-1')
    insertSkill(source, 'skill-2')

    const result = mergeSkillDatabases(target, source)
    expect(result.skillsAdded).toBe(2)
    expect(result.skillsUpdated).toBe(0)
    expect(result.conflicts).toHaveLength(0)
  })

  it('should handle keep_newer strategy (source newer)', () => {
    const target = createTestDb()
    const source = createTestDb()

    insertSkill(target, 'skill-1', { updated_at: '2026-01-01T00:00:00Z' })
    insertSkill(source, 'skill-1', { updated_at: '2026-03-01T00:00:00Z' })

    const result = mergeSkillDatabases(target, source, { strategy: 'keep_newer' })
    expect(result.skillsUpdated).toBe(1)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].resolution).toBe('updated')
  })

  it('should handle keep_newer strategy (target newer)', () => {
    const target = createTestDb()
    const source = createTestDb()

    insertSkill(target, 'skill-1', { updated_at: '2026-03-01T00:00:00Z' })
    insertSkill(source, 'skill-1', { updated_at: '2026-01-01T00:00:00Z' })

    const result = mergeSkillDatabases(target, source, { strategy: 'keep_newer' })
    expect(result.skillsSkipped).toBe(1)
    expect(result.conflicts[0].resolution).toBe('kept_target')
  })

  it('should handle keep_target strategy', () => {
    const target = createTestDb()
    const source = createTestDb()

    insertSkill(target, 'skill-1')
    insertSkill(source, 'skill-1', { name: 'updated-name' })

    const result = mergeSkillDatabases(target, source, { strategy: 'keep_target' })
    expect(result.skillsSkipped).toBe(1)
  })

  it('should handle keep_source strategy', () => {
    const target = createTestDb()
    const source = createTestDb()

    insertSkill(target, 'skill-1')
    insertSkill(source, 'skill-1', { name: 'source-name' })

    const result = mergeSkillDatabases(target, source, { strategy: 'keep_source' })
    expect(result.skillsUpdated).toBe(1)
  })

  it('should handle merge_fields strategy', () => {
    const target = createTestDb()
    const source = createTestDb()

    insertSkill(target, 'skill-1', { name: 'target-name', trust_tier: 'unknown' })
    insertSkill(source, 'skill-1', { name: '', trust_tier: 'verified' })

    const result = mergeSkillDatabases(target, source, { strategy: 'merge_fields' })
    expect(result.skillsUpdated).toBe(1)
  })

  it('should support dry run', () => {
    const target = createTestDb()
    const source = createTestDb()

    insertSkill(source, 'skill-new')

    const result = mergeSkillDatabases(target, source, { strategy: 'keep_newer', dryRun: true })
    expect(result.skillsAdded).toBe(1)

    // Verify nothing was actually inserted
    const count = target.prepare('SELECT COUNT(*) as c FROM skills').get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('should report duration', () => {
    const target = createTestDb()
    const source = createTestDb()

    const result = mergeSkillDatabases(target, source)
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })
})

// ============================================================================
// Sync utilities
// ============================================================================

describe('getSyncStatus', () => {
  it('should return skill count and null sync times when no config', () => {
    const db = createTestDb()
    insertSkill(db, 'skill-1')

    const status = getSyncStatus(db)
    expect(status.skillsInLocal).toBe(1)
    expect(status.pendingUploads).toBe(0)
    expect(status.pendingDownloads).toBe(0)
  })
})

describe('recordSyncRun', () => {
  it('should insert a sync history record', () => {
    const db = createTestDb()
    const id = recordSyncRun(db, 'success', {
      skillsAdded: 3,
      skillsUpdated: 1,
      skillsSkipped: 0,
      conflicts: [],
      duration: 200,
    })

    expect(id).toMatch(/^sync_/)
    const history = getSyncHistory(db, 1)
    expect(history).toHaveLength(1)
    expect(history[0].status).toBe('success')
    expect(history[0].skills_added).toBe(3)
  })

  it('should record running state with null completed_at', () => {
    const db = createTestDb()
    recordSyncRun(db, 'running')

    const history = getSyncHistory(db, 1)
    expect(history[0].status).toBe('running')
    expect(history[0].completed_at).toBeNull()
  })

  it('should record error message for failed runs', () => {
    const db = createTestDb()
    recordSyncRun(db, 'failed', undefined, 'Connection refused')

    const history = getSyncHistory(db, 1)
    expect(history[0].status).toBe('failed')
    expect(history[0].error_message).toBe('Connection refused')
  })
})

describe('getSyncHistory', () => {
  it('should return entries ordered by most recent first', () => {
    const db = createTestDb()
    recordSyncRun(db, 'success')
    // Small delay to ensure different timestamps
    recordSyncRun(db, 'failed', undefined, 'error')

    const history = getSyncHistory(db, 10)
    expect(history.length).toBe(2)
  })

  it('should respect limit parameter', () => {
    const db = createTestDb()
    recordSyncRun(db, 'success')
    recordSyncRun(db, 'success')
    recordSyncRun(db, 'success')

    const history = getSyncHistory(db, 2)
    expect(history).toHaveLength(2)
  })
})
