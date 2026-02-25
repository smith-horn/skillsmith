/**
 * @fileoverview Migration v8 — skill_co_installs table
 * @module @skillsmith/core/db/migrations/v8-co-installs
 * @see SMI-2761: Co-install recommendations
 *
 * Session-scoped co-install tracking: when a user installs multiple skills
 * in the same MCP session, all installed-together pairs are recorded.
 *
 * Design notes:
 *  - (skill_id_a, skill_id_b) is always stored in both orderings for
 *    symmetric queries — INSERT (A,B) and INSERT (B,A) together.
 *  - install_count is incremented on conflict (upsert pattern).
 *  - no_self_install constraint prevents (X, X) rows.
 *  - Surfacing threshold: install_count >= 5 before including in response.
 *
 * Indexes:
 *  - idx_co_installs_a: efficient "what did users also install?" queries
 *    sorted by frequency descending.
 */
export const MIGRATION_V8_SQL = `
CREATE TABLE IF NOT EXISTS skill_co_installs (
  skill_id_a TEXT NOT NULL,
  skill_id_b TEXT NOT NULL,
  install_count INTEGER NOT NULL DEFAULT 1 CHECK (install_count >= 1),
  last_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (skill_id_a, skill_id_b),
  CONSTRAINT no_self_install CHECK (skill_id_a != skill_id_b)
);

CREATE INDEX IF NOT EXISTS idx_co_installs_a
  ON skill_co_installs(skill_id_a, install_count DESC);
`
