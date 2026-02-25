/**
 * @fileoverview Migration v5b — add change_type column to skill_versions
 * @module @skillsmith/core/db/migrations/v5b-change-type
 * @see SMI-skill-version-tracking Wave 2
 *
 * Additive ALTER TABLE on skill_versions; does not increment SCHEMA_VERSION
 * (stays at 5) because the migration system handles duplicate-column errors
 * gracefully and the new column is nullable with no FK implications.
 *
 * Valid change_type values: 'major' | 'minor' | 'patch' | 'unknown'
 */

/**
 * SQL for the skill_versions change_type migration (v5b).
 *
 * Adds a TEXT column constrained to the four valid change-classification
 * values. NULL is allowed so that existing rows are unaffected.
 */
export const MIGRATION_V5B_SQL = `
ALTER TABLE skill_versions ADD COLUMN change_type TEXT
  CHECK(change_type IN ('major', 'minor', 'patch', 'unknown'));
`
