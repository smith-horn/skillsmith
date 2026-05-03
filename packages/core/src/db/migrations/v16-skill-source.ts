/**
 * @fileoverview Migration v16 — add `source` column + extend `trust_tier` CHECK
 * @see SMI-4665: Filesystem-walking SKILL.md import command
 *
 * Adds two changes to the `skills` table:
 *
 *  1. `source TEXT NOT NULL DEFAULT 'registry' CHECK (source IN ('registry', 'local'))`
 *     — distinguishes registry-synced rows from filesystem-imported rows so
 *     `sync --force` can refuse to clobber locally-imported skills.
 *
 *     NOTE: Migration v2 (SMI-974) added a free-form `source TEXT` column that
 *     held values like `'github'` for Phase-5 imports. The v16 recreation
 *     coerces any non-`'local'` legacy value to `'registry'` so the new CHECK
 *     constraint accepts existing rows. The semantic shift is intentional —
 *     callers that need the original import-source string can rely on
 *     `repo_url` (always set for github-sourced rows). See SMI-4665 retro.
 *
 *  2. Extend the `trust_tier` CHECK to allow `'local'`. Existing values:
 *     `verified`, `community`, `experimental`, `unknown`. Local skills
 *     surface as a distinct tier in search output instead of being indistinguishable
 *     from unscanned registry imports under `'unknown'`.
 *
 * SQLite cannot ALTER an existing CHECK constraint in place — the table is
 * recreated using the standard rename/copy/drop dance, all wrapped in a
 * transaction so a mid-process kill leaves either the old shape or the new
 * shape, never a half-applied state.
 *
 * Idempotent: short-circuits when the `source` column already exists. Re-running
 * the migration on a v16+ DB is a no-op. The duplicate-column guard in
 * `runMigrations` / `runMigrationsSafe` adds defense-in-depth.
 */
import type { Database } from '../database-interface.js'

const RECREATE_TABLE_SQL = `
BEGIN;

CREATE TABLE skills_v16 (
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

INSERT INTO skills_v16 (
  id, name, description, author, repo_url, quality_score, trust_tier, tags,
  risk_score, security_findings_count, security_scanned_at, security_passed,
  compatibility, content_hash, visibility, team_id,
  created_at, updated_at
)
SELECT
  id, name, description, author, repo_url, quality_score, trust_tier, tags,
  risk_score, security_findings_count, security_scanned_at, security_passed,
  compatibility, content_hash, visibility, team_id,
  created_at, updated_at
FROM skills;

DROP TABLE skills;
ALTER TABLE skills_v16 RENAME TO skills;

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
 * Apply the v16 migration if not already present.
 *
 * Exported as a function rather than a SQL string because the table-recreation
 * dance must short-circuit on an already-migrated DB (the canonical schema
 * already includes `source` for fresh installs).
 */
export function applyMigrationV16(db: Database): void {
  const probe = db
    .prepare("SELECT 1 AS hit FROM pragma_table_info('skills') WHERE name = 'source'")
    .get() as { hit: number } | undefined
  if (probe) {
    // Column already exists — fresh DB or v16 already applied. No-op.
    return
  }

  db.exec(RECREATE_TABLE_SQL)
}
