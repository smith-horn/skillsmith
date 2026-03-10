/**
 * @fileoverview Migration v10 — skill_dependencies table
 * @module @skillsmith/core/db/migrations/v10-dependencies
 * @see Architecture: ../research/skill-dependency-intelligence-architecture.md §4
 *
 * Stores declared and inferred dependency records for skills.
 * Three signal sources: author declaration, static mcp__* analysis,
 * and co-install behavioral inference.
 *
 * Design notes:
 *  - No FK on skill_id — soft reference, dep records survive skill removal
 *    (matches SkillVersionRepository pattern)
 *  - dep_source distinguishes declared vs inferred for confidence filtering
 *  - Unique index on (skill_id, dep_type, dep_target, dep_source) prevents
 *    duplicate rows from repeated inference runs
 */
export const MIGRATION_V10_SQL = `
CREATE TABLE IF NOT EXISTS skill_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  dep_type TEXT NOT NULL CHECK (dep_type IN (
    'skill_hard', 'skill_soft', 'skill_peer',
    'mcp_server',
    'model_minimum', 'model_capability',
    'env_tool', 'env_os', 'env_node',
    'cli_version',
    'conflict'
  )),
  dep_target TEXT NOT NULL,
  dep_version TEXT,
  dep_source TEXT NOT NULL CHECK (dep_source IN (
    'declared',
    'inferred_static',
    'inferred_coinstall'
  )),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skill_deps_skill ON skill_dependencies(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_deps_target ON skill_dependencies(dep_target);
CREATE INDEX IF NOT EXISTS idx_skill_deps_type ON skill_dependencies(dep_type);
CREATE INDEX IF NOT EXISTS idx_skill_deps_source ON skill_dependencies(dep_source);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_deps_unique
  ON skill_dependencies(skill_id, dep_type, dep_target, dep_source);
`
