/**
 * @fileoverview CoInstallRepository — session-scoped co-install tracking
 * @module @skillsmith/core/repositories/CoInstallRepository
 * @see SMI-2761: Co-install recommendations
 *
 * Records pairs of skills installed together in the same session.
 * Symmetric: installing (A, B) always creates both (A,B) and (B,A) rows.
 * Surfacing threshold: install_count >= 5 before including in responses.
 */

import type { Database as DatabaseType } from '../db/database-interface.js'

// ============================================================================
// Types
// ============================================================================

/** A skill summary returned in co-install recommendations */
export interface CoInstallSummary {
  /** Skill ID (e.g. "anthropic/commit") */
  skillId: string
  /** Human-readable skill name */
  name: string
  /** Short description */
  description?: string
  /** Author slug */
  author?: string
  /** Number of times installed together with the queried skill */
  installCount: number
}

// ============================================================================
// Repository
// ============================================================================

/**
 * Repository for reading and writing skill co-install records.
 *
 * Gracefully handles databases where the skill_co_installs table has not been
 * created yet (returns empty results instead of throwing). This allows
 * test contexts that use createDatabase() directly (without running all
 * migrations) to work without errors.
 */
export class CoInstallRepository {
  private db: DatabaseType

  constructor(db: DatabaseType) {
    this.db = db
  }

  /**
   * Record a co-install between two skills (both orderings).
   *
   * Uses INSERT OR REPLACE with incremented count so repeated co-installs
   * accumulate. Both (A→B) and (B→A) are written for symmetric queries.
   *
   * @param skillIdA - First skill ID
   * @param skillIdB - Second skill ID
   */
  recordCoInstall(skillIdA: string, skillIdB: string): void {
    if (skillIdA === skillIdB) return

    try {
      const upsert = this.db.prepare(`
        INSERT INTO skill_co_installs (skill_id_a, skill_id_b, install_count, last_updated_at)
        VALUES (?, ?, 1, datetime('now'))
        ON CONFLICT(skill_id_a, skill_id_b)
        DO UPDATE SET
          install_count = install_count + 1,
          last_updated_at = datetime('now')
      `)
      upsert.run(skillIdA, skillIdB)
      upsert.run(skillIdB, skillIdA)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Gracefully handle missing table (pre-migration contexts)
      if (msg.includes('no such table')) return
      throw error
    }
  }

  /**
   * Record co-installs for all pairs in a set of skills installed together.
   *
   * For N skills, records N*(N-1) rows (each pair in both orderings).
   * No-op when fewer than 2 skill IDs provided.
   *
   * @param skillIds - Array of skill IDs installed in the same session
   */
  recordSessionCoInstalls(skillIds: string[]): void {
    if (skillIds.length < 2) return
    for (let i = 0; i < skillIds.length; i++) {
      for (let j = i + 1; j < skillIds.length; j++) {
        this.recordCoInstall(skillIds[i], skillIds[j])
      }
    }
  }

  /**
   * Get the top skills co-installed with a given skill.
   *
   * Joins against the skills table to include name/description/author.
   * Only returns skills with install_count >= minCount (default 5).
   * Returns an empty array when the table does not exist or has no results.
   *
   * @param skillId - The skill to look up co-installs for
   * @param limit - Maximum results to return (default 5)
   * @param minCount - Minimum co-install count to include (default 5)
   * @returns Array of co-installed skill summaries, ordered by count desc
   */
  getTopCoInstalls(skillId: string, limit = 5, minCount = 5): CoInstallSummary[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT
          c.skill_id_b  AS skillId,
          s.name        AS name,
          s.description AS description,
          s.author      AS author,
          c.install_count AS installCount
        FROM skill_co_installs c
        LEFT JOIN skills s ON s.id = c.skill_id_b
        WHERE c.skill_id_a = ?
          AND c.install_count >= ?
        ORDER BY c.install_count DESC
        LIMIT ?
      `
        )
        .all(skillId, minCount, limit) as Array<{
        skillId: string
        name: string | null
        description: string | null
        author: string | null
        installCount: number
      }>

      return rows.map((row) => ({
        skillId: row.skillId,
        name: row.name ?? row.skillId,
        description: row.description ?? undefined,
        author: row.author ?? undefined,
        installCount: row.installCount,
      }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Gracefully handle missing table (pre-migration contexts)
      if (msg.includes('no such table')) return []
      throw error
    }
  }
}
