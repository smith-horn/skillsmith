/**
 * @fileoverview SkillVersionRepository — persistent content-hash version tracking
 * @module @skillsmith/core/repositories/SkillVersionRepository
 * @see SMI-skill-version-tracking Wave 1
 *
 * Records a content hash after every successful skill upsert so that the
 * skill_updates MCP tool (Individual tier) can detect registry changes by
 * comparing the locally-stored hash against the current registry hash.
 *
 * Design notes:
 *  - No FK on skill_id — soft reference, version history survives skill removal
 *  - recordVersion is idempotent via INSERT OR IGNORE on the unique index
 *  - pruneVersions keeps the 50 most-recent rows per skill (configurable)
 */

import type { Database as DatabaseType } from '../db/database-interface.js'

// ============================================================================
// Row / entity types
// ============================================================================

/**
 * Raw database row for skill_versions
 */
export interface SkillVersionRow {
  id: number
  skill_id: string
  content_hash: string
  recorded_at: number
  semver: string | null
  metadata: string | null
}

// ============================================================================
// Repository
// ============================================================================

/**
 * Repository for reading and writing skill version records
 */
export class SkillVersionRepository {
  private db: DatabaseType

  constructor(db: DatabaseType) {
    this.db = db
  }

  /**
   * Record a version hash for a skill.
   *
   * Idempotent: if (skill_id, content_hash) already exists the INSERT is
   * silently ignored (INSERT OR IGNORE on the unique index).
   *
   * After inserting, prunes rows beyond keepCount to bound table growth.
   *
   * @param skillId     Registry skill identifier
   * @param contentHash SHA-256 hex digest
   * @param semver      Optional semver string
   * @param metadata    Optional JSON string for future extension
   * @param keepCount   Maximum rows to keep per skill (default 50)
   */
  async recordVersion(
    skillId: string,
    contentHash: string,
    semver?: string,
    metadata?: string,
    keepCount = 50
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO skill_versions (skill_id, content_hash, semver, metadata)
         VALUES (?, ?, ?, ?)`
      )
      .run(skillId, contentHash, semver ?? null, metadata ?? null)

    await this.pruneVersions(skillId, keepCount)
  }

  /**
   * Get the most recently recorded version for a skill.
   *
   * @param skillId Registry skill identifier
   * @returns Most recent SkillVersionRow or null if none recorded
   */
  async getLatestVersion(skillId: string): Promise<SkillVersionRow | null> {
    const row = this.db
      .prepare(
        `SELECT id, skill_id, content_hash, recorded_at, semver, metadata
           FROM skill_versions
          WHERE skill_id = ?
          ORDER BY recorded_at DESC
          LIMIT 1`
      )
      .get(skillId) as SkillVersionRow | undefined

    return row ?? null
  }

  /**
   * Get the full version history for a skill, newest first.
   *
   * @param skillId Registry skill identifier
   * @param limit   Maximum rows to return (default 20)
   * @returns Array of SkillVersionRow ordered by recorded_at DESC
   */
  async getVersionHistory(skillId: string, limit = 20): Promise<SkillVersionRow[]> {
    return this.db
      .prepare(
        `SELECT id, skill_id, content_hash, recorded_at, semver, metadata
           FROM skill_versions
          WHERE skill_id = ?
          ORDER BY recorded_at DESC
          LIMIT ?`
      )
      .all(skillId, limit) as SkillVersionRow[]
  }

  /**
   * Look up a specific version by its content hash.
   *
   * @param skillId     Registry skill identifier
   * @param contentHash SHA-256 hex digest to look up
   * @returns Matching SkillVersionRow or null
   */
  async getVersionByHash(skillId: string, contentHash: string): Promise<SkillVersionRow | null> {
    const row = this.db
      .prepare(
        `SELECT id, skill_id, content_hash, recorded_at, semver, metadata
           FROM skill_versions
          WHERE skill_id = ?
            AND content_hash = ?
          LIMIT 1`
      )
      .get(skillId, contentHash) as SkillVersionRow | undefined

    return row ?? null
  }

  /**
   * Prune version history to at most keepCount rows per skill.
   *
   * Uses the subquery pattern (DELETE WHERE id NOT IN SELECT … LIMIT)
   * which is compatible with SQLite's restricted DELETE syntax.
   *
   * @param skillId   Registry skill identifier
   * @param keepCount Number of most-recent rows to retain (default 50)
   */
  async pruneVersions(skillId: string, keepCount = 50): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM skill_versions
          WHERE skill_id = ?
            AND id NOT IN (
              SELECT id FROM skill_versions
               WHERE skill_id = ?
               ORDER BY recorded_at DESC
               LIMIT ?
            )`
      )
      .run(skillId, skillId, keepCount)
  }
}
