/**
 * @fileoverview Tests for migration v17 — widen `trust_tier` CHECK to allow `'curated'`
 * @see SMI-4917: First-time-install bug fixes
 *
 * Coverage targets (from plan-review § Tests):
 *   - H4: v13→v17 and v16→v17 fixture-DB upgrades reach v17 cleanly with FTS
 *     triggers intact (the only safety net for a client-side migration).
 *   - A `'curated'` row inserts successfully after v17.
 *   - Idempotent re-run of v17 is a no-op.
 *   - H1: the `skills` column set is byte-identical pre/post-v17.
 *   - H3: a fixture DB carrying inbound-FK rows (skill_categories) keeps those
 *     rows, with intact skill_id links, across the v17 skills-table recreate
 *     (SMI-4919 — DROP TABLE fires ON DELETE CASCADE; backup/restore preserves).
 *   - H2: fresh-install convergence — v1 base → migrations → v17, no double-apply.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, closeDatabase, type Database } from '../../helpers/database.js'
import {
  getSchemaVersion,
  SCHEMA_VERSION,
  runMigrations,
  runMigrationsSafe,
  MIGRATIONS,
  createDatabaseAsync,
  initializeSchema,
  SCHEMA_SQL,
} from '../../../src/db/schema.js'
import { applyMigrationV17 } from '../../../src/db/migrations/v17-curated-trust-tier.js'
// The BARE factory (creates no tables) — needed to build a pristine fixture DB
// whose schema_version table starts empty. createDatabaseAsync from schema.js
// calls initializeSchema and would pre-stamp the current SCHEMA_VERSION.
import { createDatabaseAsync as createBareDatabaseAsync } from '../../../src/db/createDatabase.js'

/**
 * The genuine pre-v17 `skills` table DDL (the v16 shape — CHECK omits 'curated').
 * Copied verbatim from `v16-skill-source.ts` so the fixture faithfully reproduces
 * a real pre-fix v16 DB even though the current `SCHEMA_SQL` base is already
 * widened. Without this, a fresh-install fixture built from `SCHEMA_SQL` would
 * already admit 'curated' and the v17 migration would be untestable.
 */
const V16_SKILLS_DDL = `
DROP TRIGGER IF EXISTS skills_ai;
DROP TRIGGER IF EXISTS skills_ad;
DROP TRIGGER IF EXISTS skills_au;
DROP TABLE skills;
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  author TEXT,
  repo_url TEXT UNIQUE,
  quality_score REAL CHECK(quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  trust_tier TEXT CHECK(trust_tier IN ('verified', 'community', 'experimental', 'unknown', 'local')) DEFAULT 'unknown',
  tags TEXT DEFAULT '[]',
  risk_score INTEGER CHECK(risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 100)),
  security_findings_count INTEGER DEFAULT 0,
  security_scanned_at TEXT,
  security_passed INTEGER,
  compatibility TEXT DEFAULT '[]',
  content_hash TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  team_id TEXT,
  source TEXT NOT NULL DEFAULT 'registry' CHECK (source IN ('registry', 'local')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skills_author ON skills(author);
CREATE INDEX IF NOT EXISTS idx_skills_trust_tier ON skills(trust_tier);
CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, tags, author)
  VALUES (NEW.rowid, NEW.name, NEW.description, NEW.tags, NEW.author);
END;
CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, tags, author)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.tags, OLD.author);
END;
CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, tags, author)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.tags, OLD.author);
  INSERT INTO skills_fts(rowid, name, description, tags, author)
  VALUES (NEW.rowid, NEW.name, NEW.description, NEW.tags, NEW.author);
END;
`

/**
 * Build a fixture DB whose schema is stamped at exactly `targetVersion` by
 * running the canonical base schema then every migration up to (and including)
 * `targetVersion`. The `skills` table is then forced to the genuine pre-v17 v16
 * shape so the v17 migration is genuinely "pending" and exercised by the runner.
 */
async function fixtureAtVersion(targetVersion: number): Promise<Database> {
  // Bare factory — no tables created. SCHEMA_SQL then builds the v1 base schema
  // with an empty schema_version table, and migrations are applied up to target.
  const db = (await createBareDatabaseAsync(':memory:')) as Database
  db.exec(SCHEMA_SQL)
  for (const migration of MIGRATIONS) {
    if (migration.version === 1 || migration.version > targetVersion) continue
    try {
      if (migration.apply) {
        migration.apply(db)
      } else if (migration.sql !== undefined) {
        db.exec(migration.sql)
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (!msg.includes('duplicate column')) throw error
    }
    // Some migration SQL stamps its own schema_version row — use INSERT OR
    // IGNORE so this fixture helper never double-stamps.
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(migration.version)
  }
  // Force the `skills` table to the genuine pre-v17 (v16) CHECK shape — the
  // current SCHEMA_SQL base is already widened, so without this the fixture
  // would already admit 'curated'.
  db.exec(V16_SKILLS_DDL)
  return db
}

function skillsColumns(db: Database): string[] {
  return (db.prepare('PRAGMA table_info(skills)').all() as Array<{ name: string }>)
    .map((c) => c.name)
    .sort()
}

function triggerNames(db: Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='skills'")
      .all() as Array<{ name: string }>
  )
    .map((t) => t.name)
    .sort()
}

describe('Migration v17: widen trust_tier CHECK to allow curated', () => {
  let db: Database

  beforeEach(async () => {
    db = await createTestDatabase()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('SCHEMA_VERSION is at least 17', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(17)
  })

  it('fresh DB accepts insert with trust_tier=curated', () => {
    const insert = db.prepare(`
      INSERT INTO skills (id, name, description, trust_tier, quality_score, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    expect(() =>
      insert.run(
        'curated-1',
        'a-curated-skill',
        'A curated registry skill',
        'curated',
        0.8,
        'registry'
      )
    ).not.toThrow()

    const row = db.prepare('SELECT trust_tier FROM skills WHERE id = ?').get('curated-1') as {
      trust_tier: string
    }
    expect(row.trust_tier).toBe('curated')
  })

  it('still accepts every pre-existing trust_tier value', () => {
    const insert = db.prepare(
      "INSERT INTO skills (id, name, trust_tier, source) VALUES (?, ?, ?, 'registry')"
    )
    for (const tier of ['verified', 'community', 'experimental', 'unknown', 'local']) {
      expect(() => insert.run(`tier-${tier}`, tier, tier)).not.toThrow()
    }
  })

  it('rejects trust_tier values outside the widened set', () => {
    const insert = db.prepare(
      "INSERT INTO skills (id, name, trust_tier, source) VALUES (?, ?, ?, 'registry')"
    )
    expect(() => insert.run('bad-tier', 'bad', 'made-up')).toThrow(/CHECK constraint failed/)
  })

  it('applyMigrationV17 is idempotent — running twice is a no-op', () => {
    expect(() => applyMigrationV17(db)).not.toThrow()
    const colsAfterFirst = skillsColumns(db)
    expect(() => applyMigrationV17(db)).not.toThrow()
    expect(skillsColumns(db)).toEqual(colsAfterFirst)
  })

  it('v16→v17: a v16 fixture DB upgrades to v17 cleanly', async () => {
    const v16 = await fixtureAtVersion(16)
    expect(getSchemaVersion(v16)).toBe(16)
    // A v16 DB rejects curated before the upgrade.
    expect(() =>
      v16
        .prepare(
          "INSERT INTO skills (id, name, trust_tier, source) VALUES ('pre', 'p', 'curated', 'registry')"
        )
        .run()
    ).toThrow(/CHECK constraint failed/)

    const ran = runMigrations(v16)
    expect(ran).toBeGreaterThanOrEqual(1)
    expect(getSchemaVersion(v16)).toBe(SCHEMA_VERSION)

    // After v17 the curated insert succeeds.
    expect(() =>
      v16
        .prepare(
          "INSERT INTO skills (id, name, trust_tier, source) VALUES ('post', 'p', 'curated', 'registry')"
        )
        .run()
    ).not.toThrow()
    expect(triggerNames(v16)).toEqual(['skills_ad', 'skills_ai', 'skills_au'])
    closeDatabase(v16)
  })

  it('v13→v17: a v13 fixture DB upgrades through every migration to v17 cleanly', async () => {
    const v13 = await fixtureAtVersion(13)
    expect(getSchemaVersion(v13)).toBe(13)

    const ran = runMigrations(v13)
    expect(ran).toBeGreaterThanOrEqual(2) // at minimum v16 + v17
    expect(getSchemaVersion(v13)).toBe(SCHEMA_VERSION)

    expect(() =>
      v13
        .prepare(
          "INSERT INTO skills (id, name, trust_tier, source) VALUES ('c', 'c', 'curated', 'registry')"
        )
        .run()
    ).not.toThrow()
    expect(triggerNames(v13)).toEqual(['skills_ad', 'skills_ai', 'skills_au'])
    closeDatabase(v13)
  })

  it('v16→v17 preserves all existing skill rows', async () => {
    const v16 = await fixtureAtVersion(16)
    const insert = v16.prepare(
      'INSERT INTO skills (id, name, trust_tier, source) VALUES (?, ?, ?, ?)'
    )
    insert.run('keep-1', 'verified-skill', 'verified', 'registry')
    insert.run('keep-2', 'local-skill', 'local', 'local')

    runMigrations(v16)

    const rows = v16
      .prepare('SELECT id, trust_tier, source FROM skills ORDER BY id')
      .all() as Array<{ id: string; trust_tier: string; source: string }>
    expect(rows).toEqual([
      { id: 'keep-1', trust_tier: 'verified', source: 'registry' },
      { id: 'keep-2', trust_tier: 'local', source: 'local' },
    ])
    closeDatabase(v16)
  })

  it('H1: the skills column set is byte-identical before and after v17', async () => {
    const v16 = await fixtureAtVersion(16)
    const colsBefore = skillsColumns(v16)
    applyMigrationV17(v16)
    const colsAfter = skillsColumns(v16)
    expect(colsAfter).toEqual(colsBefore)
    closeDatabase(v16)
  })

  it('H3: v17 preserves skill_categories rows across the skills-table recreate', async () => {
    const v16 = await fixtureAtVersion(16)
    // Skill rows referenced by skill_categories (FK skill_categories.skill_id → skills.id).
    const insertSkill = v16.prepare(
      'INSERT INTO skills (id, name, trust_tier, source) VALUES (?, ?, ?, ?)'
    )
    insertSkill.run('fk-skill', 'fk', 'community', 'registry')
    insertSkill.run('fk-skill-2', 'fk2', 'verified', 'registry')
    v16.prepare("INSERT INTO categories (id, name) VALUES ('cat-1', 'testing')").run()
    v16.prepare("INSERT INTO categories (id, name) VALUES ('cat-2', 'devops')").run()
    const insertLink = v16.prepare(
      'INSERT INTO skill_categories (skill_id, category_id) VALUES (?, ?)'
    )
    insertLink.run('fk-skill', 'cat-1')
    insertLink.run('fk-skill', 'cat-2')
    insertLink.run('fk-skill-2', 'cat-1')

    // The v17 recreate drops & renames `skills` inside one transaction. Under
    // foreign_keys=ON (driver default), `DROP TABLE skills` fires the
    // `ON DELETE CASCADE` on skill_categories immediately — the recreate must
    // back up & restore skill_categories so its rows survive (SMI-4919).
    expect(() => applyMigrationV17(v16)).not.toThrow()

    // The skill rows themselves survive the recreate in the new (widened) table.
    const skills = v16.prepare('SELECT id FROM skills ORDER BY id').all() as Array<{ id: string }>
    expect(skills.map((s) => s.id)).toEqual(['fk-skill', 'fk-skill-2'])

    // The skill_categories rows survive with intact skill_id links — they are
    // NOT cascade-deleted. This is the SMI-4919 regression guard.
    const links = v16
      .prepare('SELECT skill_id, category_id FROM skill_categories ORDER BY skill_id, category_id')
      .all() as Array<{ skill_id: string; category_id: string }>
    expect(links).toEqual([
      { skill_id: 'fk-skill', category_id: 'cat-1' },
      { skill_id: 'fk-skill', category_id: 'cat-2' },
      { skill_id: 'fk-skill-2', category_id: 'cat-1' },
    ])

    // The TEMP backup table is dropped — no leftover artifact.
    const backup = v16
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_skill_categories_backup'"
      )
      .get() as { name: string } | undefined
    expect(backup).toBeUndefined()
    closeDatabase(v16)
  })

  it('H2: fresh-install convergence — base schema → migrations → v17, no double-apply', async () => {
    const fresh = await createDatabaseAsync(':memory:')
    initializeSchema(fresh)
    // initializeSchema stamps SCHEMA_VERSION directly; the v17 probe must no-op.
    expect(getSchemaVersion(fresh)).toBe(SCHEMA_VERSION)
    expect(() => applyMigrationV17(fresh)).not.toThrow()
    // runMigrations sees a current version → 0 pending.
    expect(runMigrations(fresh)).toBe(0)
    // Fresh base schema already admits 'curated'.
    expect(() =>
      fresh
        .prepare(
          "INSERT INTO skills (id, name, trust_tier, source) VALUES ('fresh-c', 'c', 'curated', 'registry')"
        )
        .run()
    ).not.toThrow()
    closeDatabase(fresh)
  })

  it('runMigrationsSafe is a no-op on a DB already at v17', () => {
    const before = getSchemaVersion(db)
    expect(runMigrationsSafe(db)).toBe(0)
    expect(getSchemaVersion(db)).toBe(before)
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(17)
  })
})
