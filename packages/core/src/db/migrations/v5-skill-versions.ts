/**
 * @fileoverview Migration v5 — skill_versions table
 * @module @skillsmith/core/db/migrations/v5-skill-versions
 * @see SMI-skill-version-tracking Wave 1
 *
 * Creates the skill_versions table for persistent content-hash-based
 * version tracking. Deliberately uses no FK constraint on skill_id so
 * that version history is preserved even when a skill is removed from
 * the registry (soft reference by design).
 *
 * No change_type column in this migration — deferred to Wave 2 per plan.
 */

/**
 * SQL for the skill_versions migration (v5).
 *
 * Table columns:
 *  - id           AUTOINCREMENT surrogate key
 *  - skill_id     Registry skill identifier (TEXT, not FK)
 *  - content_hash SHA-256 hex digest of skill content proxy
 *  - recorded_at  Unix epoch seconds (DEFAULT unixepoch())
 *  - semver       Optional semver string from skill metadata
 *  - metadata     Optional JSON blob for future extension
 *
 * Indexes:
 *  - UNIQUE (skill_id, content_hash) — makes recordVersion idempotent
 *    via INSERT OR IGNORE
 *  - (skill_id, recorded_at DESC) — efficient "latest version" queries
 */
export const MIGRATION_V5_SQL = `
CREATE TABLE IF NOT EXISTS skill_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id     TEXT    NOT NULL,
  content_hash TEXT    NOT NULL,
  recorded_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  semver       TEXT,
  metadata     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_skill_hash
  ON skill_versions(skill_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_recorded
  ON skill_versions(skill_id, recorded_at DESC);
`
