/**
 * @fileoverview Migration v7 — compatibility column on skills table
 * @module @skillsmith/core/db/migrations/v7-compatibility
 * @see SMI-2760: Compatibility tags
 *
 * Adds the compatibility column to the skills table for IDE, LLM, and
 * platform compatibility tags. Stored as a JSON array in SQLite TEXT;
 * the companion Supabase migration uses JSONB with a GIN index.
 *
 * JSON shape: ["claude-code", "cursor", "claude", "gpt-4o"]
 * A flat array is used for simpler SQLite json_each queries vs a nested
 * { ides: [...], llms: [...] } object. The MCP search filter accepts
 * the structured form and flattens it for DB comparison.
 *
 * Index:
 *  - None added here (SQLite does not support GIN). The Supabase Postgres
 *    migration adds: CREATE INDEX idx_skills_compatibility_gin ON skills
 *    USING gin(compatibility);
 */
export const MIGRATION_V7_SQL = `
ALTER TABLE skills ADD COLUMN compatibility TEXT DEFAULT '[]';
`
