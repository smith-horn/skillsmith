/**
 * @fileoverview Migration v17 — widen the `trust_tier` CHECK to allow `'curated'`
 * @see SMI-4917: First-time-install bug fixes
 *
 * The skill registry ships skills with `trust_tier = 'curated'` (introduced in
 * SMI-2381 — third-party publishers manually opted in). The canonical `TrustTier`
 * type and the API/Zod schema accept `'curated'`, but the SQLite CHECK constraint
 * on the `skills` table omitted it (`schema-sql.ts`, `v16-skill-source.ts` allowed
 * only `verified, community, experimental, unknown, local`). Every `'curated'` row
 * therefore failed on insert, so `sync` silently dropped every curated skill.
 *
 * SQLite cannot ALTER an existing CHECK constraint in place — the table is
 * recreated using the standard create/copy/drop/rename dance, all wrapped in a
 * transaction so a mid-process kill leaves either the old shape or the new shape,
 * never a half-applied state. This mirrors `applyMigrationV16` exactly; the column
 * set, indexes, and FTS5 triggers are copied verbatim from v16 (v17 changes only
 * the `trust_tier` CHECK list — no column added, no column dropped).
 *
 * R1 (FK inbound refs): with `foreign_keys=ON` (the driver default), `DROP TABLE
 * skills` fires every inbound `ON DELETE CASCADE` action *immediately* — SQLite
 * does NOT defer cascade actions to the end of the transaction. Today
 * `skill_categories` (`schema-sql.ts:96-100`) is the only child with a hard FK
 * `skill_id ... REFERENCES skills(id) ON DELETE CASCADE`; its rows would be
 * silently cascade-deleted by the recreate (SMI-4919). The recreate therefore
 * backs `skill_categories` up into a TEMP table before `DROP TABLE skills` and
 * restores it verbatim after the RENAME, all inside the one `BEGIN; ... COMMIT;`.
 * (`skill_versions`, `skill_advisories`, `skill_co_installs`,
 * `skill_dependencies`, `risk_score_history` use soft `skill_id TEXT` columns
 * with no FK — they are unaffected.) RULE: any future `skills` table-recreate
 * MUST back up every `ON DELETE CASCADE` child of `skills` the same way (today
 * `skill_categories` is the only one — re-check `schema-sql.ts` before changing
 * this dance).
 *
 * Idempotent: v17 adds no column, so the probe inspects the CHECK text itself —
 * if the `skills` DDL already contains `'curated'`, the migration is a no-op.
 * Re-running on a v17+ DB (or a fresh install, whose base `SCHEMA_SQL` already
 * includes `'curated'`) short-circuits. The duplicate-column guard in
 * `runMigrations` / `runMigrationsSafe` does not apply here (no column change),
 * so the probe is the sole idempotency mechanism — it is load-bearing.
 */
import type { Database } from '../database-interface.js'

const RECREATE_TABLE_SQL = `
BEGIN;

CREATE TABLE skills_v17 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  author TEXT,
  repo_url TEXT UNIQUE,
  quality_score REAL CHECK(quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  trust_tier TEXT CHECK(trust_tier IN ('verified', 'curated', 'community', 'experimental', 'unknown', 'local')) DEFAULT 'unknown',
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

INSERT INTO skills_v17 (
  id, name, description, author, repo_url, quality_score, trust_tier, tags,
  risk_score, security_findings_count, security_scanned_at, security_passed,
  compatibility, content_hash, visibility, team_id, source,
  created_at, updated_at
)
SELECT
  id, name, description, author, repo_url, quality_score, trust_tier, tags,
  risk_score, security_findings_count, security_scanned_at, security_passed,
  compatibility, content_hash, visibility, team_id, source,
  created_at, updated_at
FROM skills;

-- Back up the only ON DELETE CASCADE child of skills so DROP TABLE skills
-- (which fires cascades immediately under foreign_keys=ON) cannot silently
-- delete its rows. Restored verbatim after the RENAME below (SMI-4919).
DROP TABLE IF EXISTS _skill_categories_backup;
CREATE TEMP TABLE _skill_categories_backup AS SELECT * FROM skill_categories;

DROP TABLE skills;
ALTER TABLE skills_v17 RENAME TO skills;

INSERT INTO skill_categories SELECT * FROM _skill_categories_backup;
DROP TABLE _skill_categories_backup;

CREATE INDEX IF NOT EXISTS idx_skills_author ON skills(author);
CREATE INDEX IF NOT EXISTS idx_skills_trust_tier ON skills(trust_tier);
CREATE INDEX IF NOT EXISTS idx_skills_quality_score ON skills(quality_score);
CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills(updated_at);
CREATE INDEX IF NOT EXISTS idx_skills_created_at ON skills(created_at);
CREATE INDEX IF NOT EXISTS idx_skills_risk_score ON skills(risk_score);
CREATE INDEX IF NOT EXISTS idx_skills_security_passed ON skills(security_passed);
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

COMMIT;
`

/**
 * Apply the v17 migration if not already present.
 *
 * Exported as a function rather than a SQL string because the table-recreation
 * dance must short-circuit on an already-widened DB. v17 adds no column, so the
 * probe inspects the `skills` table DDL for the `'curated'` literal — if present,
 * the constraint is already widened (fresh install or v17 already applied) and
 * the migration is a no-op.
 */
export function applyMigrationV17(db: Database): void {
  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='skills'")
    .get() as { sql: string } | undefined

  if (ddl && ddl.sql.includes("'curated'")) {
    // CHECK already widened — fresh DB or v17 already applied. No-op.
    return
  }

  db.exec(RECREATE_TABLE_SQL)
}
