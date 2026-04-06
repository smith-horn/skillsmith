/**
 * @fileoverview Migration v13 -- Team visibility and ownership columns
 * @see SMI-3896: Private Skills Publishing
 *
 * Adds `visibility` and `team_id` columns to the skills table so that
 * private skills can be scoped to a team. Community users see only
 * `visibility = 'public'` skills; team members also see skills matching
 * their team_id.
 */
export const MIGRATION_V13_SQL = `
ALTER TABLE skills ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE skills ADD COLUMN team_id TEXT;
`
