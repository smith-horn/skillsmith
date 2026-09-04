/**
 * @fileoverview Migration v18 — purge proxy-hash skill_versions history
 * @module @skillsmith/core/db/migrations/v18-skill-versions-real-content-hash
 * @see SMI-6343 Wave 2 — repair the content-hash comparison
 *
 * `skill_versions.content_hash`'s MEANING changed, not its shape. It used to
 * be a SHA-256 hash of a JSON metadata proxy (`{id, name, description,
 * updated_at}`), written by `SyncEngine.upsertSkills()` — never a hash of
 * real SKILL.md content, even though three consumers (`skill_updates`,
 * `skill_outdated`, and the CLI's `skills-directory.ts`) all compared against
 * it as if it were one. As of this migration's companion code change
 * (`SyncEngine.ts`), it is a real SHA-256 hash of the registry's SKILL.md
 * content at index time — `ApiSearchResult.content_hash`, already present on
 * every sync-registry response and previously ignored by the sync writer.
 *
 * This migration purges every existing row rather than leaving old
 * (proxy-hash) and new (real-hash) rows mixed in the same table. Purging is
 * safe: `skill_versions` carries no FK on `skill_id` — `v5-skill-versions.ts`
 * documents this as a deliberate soft reference so version history survives
 * even when a skill is removed from the registry — the table is a
 * regenerable local cache, and it fully rebuilds on the very next registry
 * sync (`SyncEngine.sync()` re-records a version for every skill it
 * upserts).
 *
 * Mixing the two hash spaces is NOT safe. A skill with a pre-existing proxy
 * row would get a new real-hash row on the next sync while its OLDEST
 * recorded row stays a proxy hash — `skill-updates.ts`'s
 * `oldest.content_hash !== latest.content_hash` comparison (pre-fix) would
 * then read `true` for EVERY such skill: a universal false "update
 * available" regression on a paid Individual+ tool. Purging avoids this
 * entirely — every row recorded from this point forward is a real content
 * hash, so any two rows for the same skill are directly, meaningfully
 * comparable again.
 */
export const MIGRATION_V18_SQL = `
DELETE FROM skill_versions;
`
