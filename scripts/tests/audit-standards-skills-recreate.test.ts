/**
 * Tests for the SMI-4925 skills-recreate FK-cascade guard helper.
 *
 * Covers `findUnsafeSkillsRecreateMigrations` in audit-standards-helpers.mjs.
 *
 * Background: any migration that drops and recreates the `skills` table must
 * back up `skill_categories` (the only ON DELETE CASCADE child as of
 * schema-sql.ts) into a TEMP table before the DROP and restore it after the
 * RENAME — otherwise SQLite's immediate-cascade behaviour silently deletes all
 * child rows (SMI-4919). v17 is the conforming reference; v16 is allow-listed.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  findUnsafeSkillsRecreateMigrations: (
    migrationsByPath: Record<string, string>,
    options?: { allowList?: string[] }
  ) => Array<{ file: string; reason: string }>
}

const { findUnsafeSkillsRecreateMigrations } = helpers

// ---------------------------------------------------------------------------
// Fixture SQL snippets
// ---------------------------------------------------------------------------

/** Conforming v17-shaped SQL: contains both halves of the backup/restore pair. */
const V17_SAFE_SQL = `
BEGIN;
CREATE TABLE skills_v17 (id TEXT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO skills_v17 SELECT id, name FROM skills;
DROP TABLE IF EXISTS _skill_categories_backup;
CREATE TEMP TABLE _skill_categories_backup AS SELECT * FROM skill_categories;
DROP TABLE skills;
ALTER TABLE skills_v17 RENAME TO skills;
INSERT INTO skill_categories SELECT * FROM _skill_categories_backup;
DROP TABLE _skill_categories_backup;
COMMIT;
`

/** v16-shaped SQL: recreates skills but has NO backup/restore pair. */
const V16_UNSAFE_SQL = `
BEGIN;
CREATE TABLE skills_v16 (id TEXT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO skills_v16 SELECT id, name FROM skills;
DROP TABLE skills;
ALTER TABLE skills_v16 RENAME TO skills;
COMMIT;
`

/** A migration that does not recreate skills at all. */
const NON_RECREATE_SQL = `
ALTER TABLE skills ADD COLUMN foo TEXT;
CREATE INDEX IF NOT EXISTS idx_skills_foo ON skills(foo);
`

/** Has the CREATE TEMP TABLE backup half but NOT the INSERT restore half. */
const HALF_BACKUP_ONLY_SQL = `
BEGIN;
CREATE TABLE skills_v18 (id TEXT PRIMARY KEY);
INSERT INTO skills_v18 SELECT id FROM skills;
CREATE TEMP TABLE _skill_categories_backup AS SELECT * FROM skill_categories;
DROP TABLE skills;
ALTER TABLE skills_v18 RENAME TO skills;
COMMIT;
`

/** Has DROP TABLE skills_v17 but NOT DROP TABLE skills — must NOT trigger. */
const DROP_VERSIONED_TABLE_SQL = `
BEGIN;
CREATE TABLE skills_v17 (id TEXT PRIMARY KEY);
DROP TABLE skills_v17;
ALTER TABLE skills_new RENAME TO skills_v17;
COMMIT;
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findUnsafeSkillsRecreateMigrations (SMI-4925)', () => {
  it('v17-shaped SQL with backup/restore pair — no violation', () => {
    const violations = findUnsafeSkillsRecreateMigrations({
      'packages/core/src/db/migrations/v17-curated-trust-tier.ts': V17_SAFE_SQL,
    })
    expect(violations).toHaveLength(0)
  })

  it('recreate dropping skills with NO backup pair — violation', () => {
    const violations = findUnsafeSkillsRecreateMigrations({
      'packages/core/src/db/migrations/v99-hypothetical.ts': V16_UNSAFE_SQL,
    })
    expect(violations).toHaveLength(1)
    expect(violations[0].file).toBe('packages/core/src/db/migrations/v99-hypothetical.ts')
    expect(violations[0].reason).toMatch(/_skill_categories_backup/)
  })

  it('v16-shaped SQL with basename in allowList — no violation', () => {
    const violations = findUnsafeSkillsRecreateMigrations(
      { 'packages/core/src/db/migrations/v16-skill-source.ts': V16_UNSAFE_SQL },
      { allowList: ['v16-skill-source.ts'] }
    )
    expect(violations).toHaveLength(0)
  })

  it('non-recreate migration (ALTER TABLE ADD COLUMN) — no violation', () => {
    const violations = findUnsafeSkillsRecreateMigrations({
      'packages/core/src/db/migrations/v10-add-column.ts': NON_RECREATE_SQL,
    })
    expect(violations).toHaveLength(0)
  })

  it('recreate with ONLY the CREATE TEMP TABLE half (no restore INSERT) — violation', () => {
    const violations = findUnsafeSkillsRecreateMigrations({
      'packages/core/src/db/migrations/v20-missing-restore.ts': HALF_BACKUP_ONLY_SQL,
    })
    expect(violations).toHaveLength(1)
    expect(violations[0].reason).toMatch(/restore half/)
  })

  it('DROP TABLE skills_v17 present but NOT DROP TABLE skills — no violation (word-boundary check)', () => {
    const violations = findUnsafeSkillsRecreateMigrations({
      'packages/core/src/db/migrations/v17-curated-trust-tier.ts': DROP_VERSIONED_TABLE_SQL,
    })
    expect(violations).toHaveLength(0)
  })

  it('multiple migrations — only unsafe non-allowlisted ones are flagged', () => {
    const violations = findUnsafeSkillsRecreateMigrations(
      {
        'packages/core/src/db/migrations/v16-skill-source.ts': V16_UNSAFE_SQL,
        'packages/core/src/db/migrations/v17-curated-trust-tier.ts': V17_SAFE_SQL,
        'packages/core/src/db/migrations/v18-some-other.ts': V16_UNSAFE_SQL,
        'packages/core/src/db/migrations/v10-add-column.ts': NON_RECREATE_SQL,
      },
      { allowList: ['v16-skill-source.ts'] }
    )
    // v16 is allow-listed, v17 is safe, v10 is not a recreate → only v18 flagged
    expect(violations).toHaveLength(1)
    expect(violations[0].file).toBe('packages/core/src/db/migrations/v18-some-other.ts')
  })

  it('defaults to empty allowList when options are omitted', () => {
    const violations = findUnsafeSkillsRecreateMigrations({
      'packages/core/src/db/migrations/v16-skill-source.ts': V16_UNSAFE_SQL,
    })
    // No allowList → v16 is flagged
    expect(violations).toHaveLength(1)
  })

  it('DROP TABLE IF EXISTS skills (with IF EXISTS) also triggers the guard', () => {
    const sqlWithIfExists = `
BEGIN;
CREATE TABLE skills_v99 (id TEXT PRIMARY KEY);
INSERT INTO skills_v99 SELECT id FROM skills;
DROP TABLE IF EXISTS skills;
ALTER TABLE skills_v99 RENAME TO skills;
COMMIT;
`
    const violations = findUnsafeSkillsRecreateMigrations({
      'packages/core/src/db/migrations/v99-if-exists.ts': sqlWithIfExists,
    })
    expect(violations).toHaveLength(1)
  })
})
