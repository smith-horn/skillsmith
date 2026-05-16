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
 * R1 (FK inbound refs): `skill_categories`, `skill_versions`, etc. reference
 * `skills(id)`. v16 ships the identical drop/rename inside a single transaction
 * and is proven safe in production — v17 follows it exactly, with NO
 * `PRAGMA foreign_keys` toggle. SQLite defers FK enforcement to statement
 * boundaries within a transaction, so dropping and recreating `skills` in one
 * `BEGIN; ... COMMIT;` is safe even with inbound FK rows present.
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

DROP TABLE skills;
ALTER TABLE skills_v17 RENAME TO skills;

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
