/**
 * @fileoverview Migration v6 — skill_advisories table
 * @module @skillsmith/core/db/migrations/v6-advisories
 * @see SMI-skill-version-tracking Wave 3
 *
 * Creates the skill_advisories table for vulnerability advisory infrastructure.
 * skill_id is a soft reference — no FK to skills(id), same pattern as skill_versions,
 * so advisory history survives skill removal from the registry.
 */

/**
 * SQL for the skill_advisories migration (v6).
 *
 * Table columns:
 *  - id               SSA-YYYY-NNN format advisory identifier (TEXT PK)
 *  - skill_id         Registry skill identifier (TEXT, not FK — soft reference)
 *  - severity         Advisory severity level (low|medium|high|critical)
 *  - title            Short advisory title
 *  - description      Full advisory description
 *  - affected_versions  JSON array of affected version ranges
 *  - patched_versions   JSON array of patched version ranges
 *  - cwe_ids          JSON array of CWE identifiers
 *  - references       JSON array of reference URLs
 *  - published_at     ISO datetime when advisory was published
 *  - withdrawn_at     ISO datetime if advisory was retracted (NULL = still active)
 *  - created_at       Row creation timestamp
 *
 * Indexes:
 *  - (skill_id) — efficient per-skill advisory queries
 *  - (severity) — efficient severity-filtered queries
 */
export const MIGRATION_V6_SQL = `
CREATE TABLE IF NOT EXISTS skill_advisories (
  id                TEXT    PRIMARY KEY,
  skill_id          TEXT    NOT NULL,
  severity          TEXT    NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  title             TEXT    NOT NULL,
  description       TEXT    NOT NULL,
  affected_versions TEXT,
  patched_versions  TEXT,
  cwe_ids           TEXT,
  advisory_refs     TEXT,
  published_at      TEXT    NOT NULL,
  withdrawn_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skill_advisories_skill_id
  ON skill_advisories(skill_id);

CREATE INDEX IF NOT EXISTS idx_skill_advisories_severity
  ON skill_advisories(severity);
`
