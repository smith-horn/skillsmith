/**
 * @fileoverview SkillDependencyRepository — CRUD for skill_dependencies table
 * @module @skillsmith/core/repositories/SkillDependencyRepository
 * @see SMI-3143: Create SkillDependencyRepository CRUD
 *
 * Reads and writes dependency records from the skill_dependencies table
 * (migration v10). Follows the CoInstallRepository pattern: constructor
 * takes a DatabaseType, and all methods gracefully handle a missing table
 * by returning empty results instead of throwing.
 */

import type { Database as DatabaseType } from '../db/database-interface.js'
import type { SkillDependencyRow, DepSource } from '../types/dependencies.js'

// ============================================================================
// Repository
// ============================================================================

/**
 * Repository for reading and writing skill dependency records.
 *
 * Gracefully handles databases where the skill_dependencies table has not
 * been created yet (returns empty results instead of throwing). This allows
 * test contexts that use createDatabase() directly (without running all
 * migrations) to work without errors.
 */
export class SkillDependencyRepository {
  private db: DatabaseType

  constructor(db: DatabaseType) {
    this.db = db
  }

  /**
   * Set (upsert) dependencies for a skill from a given source.
   *
   * Uses INSERT OR REPLACE on the unique index
   * (skill_id, dep_type, dep_target, dep_source) so repeated calls
   * with the same key are idempotent.
   *
   * @param skillId - The skill these dependencies belong to
   * @param deps - Array of dependency rows to upsert
   * @param source - The dep_source value to stamp on each row
   */
  setDependencies(skillId: string, deps: SkillDependencyRow[], source: DepSource): void {
    if (deps.length === 0) return

    try {
      const upsert = this.db.prepare(`
        INSERT INTO skill_dependencies
          (skill_id, dep_type, dep_target, dep_version, dep_source, confidence, metadata, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(skill_id, dep_type, dep_target, dep_source)
        DO UPDATE SET
          dep_version = excluded.dep_version,
          confidence  = excluded.confidence,
          metadata    = excluded.metadata,
          updated_at  = datetime('now')
      `)

      const runAll = this.db.transaction(() => {
        for (const dep of deps) {
          upsert.run(
            skillId,
            dep.dep_type,
            dep.dep_target,
            dep.dep_version,
            source,
            dep.confidence,
            dep.metadata
          )
        }
      })

      runAll()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('no such table')) return
      throw error
    }
  }

  /**
   * Get all dependencies for a skill, ordered by dep_type.
   *
   * @param skillId - The skill to look up dependencies for
   * @returns Array of dependency rows, or empty array if table missing
   */
  getDependencies(skillId: string): SkillDependencyRow[] {
    try {
      return this.db
        .prepare(
          `
          SELECT id, skill_id, dep_type, dep_target, dep_version,
                 dep_source, confidence, metadata, created_at, updated_at
          FROM skill_dependencies
          WHERE skill_id = ?
          ORDER BY dep_type
        `
        )
        .all(skillId) as SkillDependencyRow[]
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('no such table')) return []
      throw error
    }
  }

  /**
   * Get dependencies for a skill filtered by source.
   *
   * @param skillId - The skill to look up dependencies for
   * @param source - Filter by dep_source value
   * @returns Array of dependency rows matching the source
   */
  getDependenciesBySource(skillId: string, source: DepSource): SkillDependencyRow[] {
    try {
      return this.db
        .prepare(
          `
          SELECT id, skill_id, dep_type, dep_target, dep_version,
                 dep_source, confidence, metadata, created_at, updated_at
          FROM skill_dependencies
          WHERE skill_id = ? AND dep_source = ?
          ORDER BY dep_type
        `
        )
        .all(skillId, source) as SkillDependencyRow[]
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('no such table')) return []
      throw error
    }
  }

  /**
   * Reverse lookup: find all skills that depend on a given target.
   *
   * @param depTarget - The dependency target to search for
   * @param depType - Optional dep_type filter
   * @returns Array of dependency rows where dep_target matches
   */
  getDependents(depTarget: string, depType?: string): SkillDependencyRow[] {
    try {
      if (depType) {
        return this.db
          .prepare(
            `
            SELECT id, skill_id, dep_type, dep_target, dep_version,
                   dep_source, confidence, metadata, created_at, updated_at
            FROM skill_dependencies
            WHERE dep_target = ? AND dep_type = ?
            ORDER BY skill_id
          `
          )
          .all(depTarget, depType) as SkillDependencyRow[]
      }

      return this.db
        .prepare(
          `
          SELECT id, skill_id, dep_type, dep_target, dep_version,
                 dep_source, confidence, metadata, created_at, updated_at
          FROM skill_dependencies
          WHERE dep_target = ?
          ORDER BY skill_id
        `
        )
        .all(depTarget) as SkillDependencyRow[]
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('no such table')) return []
      throw error
    }
  }

  /**
   * Delete only inferred dependencies for a skill.
   * Preserves declared dependencies.
   *
   * @param skillId - The skill to clear inferred deps for
   */
  clearInferred(skillId: string): void {
    try {
      this.db
        .prepare(
          `
          DELETE FROM skill_dependencies
          WHERE skill_id = ? AND dep_source != 'declared'
        `
        )
        .run(skillId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('no such table')) return
      throw error
    }
  }

  /**
   * Delete all dependencies for a skill.
   *
   * @param skillId - The skill to clear all deps for
   */
  clearAll(skillId: string): void {
    try {
      this.db
        .prepare(
          `
          DELETE FROM skill_dependencies
          WHERE skill_id = ?
        `
        )
        .run(skillId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('no such table')) return
      throw error
    }
  }
}
