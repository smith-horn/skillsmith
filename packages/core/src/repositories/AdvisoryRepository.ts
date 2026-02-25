/**
 * @fileoverview AdvisoryRepository — vulnerability advisory storage and retrieval
 * @module @skillsmith/core/repositories/AdvisoryRepository
 * @see SMI-skill-version-tracking Wave 3
 *
 * Provides CRUD operations for skill security advisories stored in
 * the skill_advisories table (introduced in migration v6).
 *
 * Design notes:
 *  - No FK on skill_id — soft reference, advisory history survives skill removal
 *  - upsertAdvisory is idempotent via INSERT OR REPLACE
 *  - "Active" advisories are those where withdrawn_at IS NULL
 */

import type { Database as DatabaseType } from '../db/database-interface.js'

// ============================================================================
// Entity type
// ============================================================================

/**
 * A skill security advisory record
 */
export interface SkillAdvisory {
  /** SSA-YYYY-NNN format advisory identifier */
  id: string
  /** Registry skill identifier (soft reference — no FK) */
  skillId: string
  /** Advisory severity level */
  severity: 'low' | 'medium' | 'high' | 'critical'
  /** Short advisory title */
  title: string
  /** Full advisory description */
  description: string
  /** JSON array of affected version ranges */
  affectedVersions?: string
  /** JSON array of patched version ranges */
  patchedVersions?: string
  /** JSON array of CWE identifiers */
  cweIds?: string
  /** JSON array of reference URLs */
  advisoryRefs?: string
  /** ISO datetime when advisory was published */
  publishedAt: string
  /** ISO datetime if advisory was retracted (undefined = still active) */
  withdrawnAt?: string
  /** Row creation timestamp (set by DB default on insert) */
  createdAt?: string
}

// ============================================================================
// Raw DB row — maps snake_case columns to TS
// ============================================================================

interface AdvisoryRow {
  id: string
  skill_id: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  title: string
  description: string
  affected_versions: string | null
  patched_versions: string | null
  cwe_ids: string | null
  advisory_refs: string | null
  published_at: string
  withdrawn_at: string | null
  created_at: string
}

// ============================================================================
// Repository
// ============================================================================

/**
 * Repository for reading and writing skill advisory records
 */
export class AdvisoryRepository {
  private db: DatabaseType

  constructor(db: DatabaseType) {
    this.db = db
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private rowToAdvisory(row: AdvisoryRow): SkillAdvisory {
    return {
      id: row.id,
      skillId: row.skill_id,
      severity: row.severity,
      title: row.title,
      description: row.description,
      affectedVersions: row.affected_versions ?? undefined,
      patchedVersions: row.patched_versions ?? undefined,
      cweIds: row.cwe_ids ?? undefined,
      advisoryRefs: row.advisory_refs ?? undefined,
      publishedAt: row.published_at,
      withdrawnAt: row.withdrawn_at ?? undefined,
      createdAt: row.created_at,
    }
  }

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  /**
   * Insert or replace an advisory record.
   *
   * Idempotent: re-running with the same id replaces the existing row.
   *
   * @param advisory - Advisory data to persist
   */
  upsertAdvisory(advisory: SkillAdvisory): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO skill_advisories
           (id, skill_id, severity, title, description,
            affected_versions, patched_versions, cwe_ids, advisory_refs,
            published_at, withdrawn_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        advisory.id,
        advisory.skillId,
        advisory.severity,
        advisory.title,
        advisory.description,
        advisory.affectedVersions ?? null,
        advisory.patchedVersions ?? null,
        advisory.cweIds ?? null,
        advisory.advisoryRefs ?? null,
        advisory.publishedAt,
        advisory.withdrawnAt ?? null
      )
  }

  /**
   * Mark an advisory as withdrawn by setting withdrawn_at to the current time.
   *
   * @param id - Advisory identifier to withdraw
   */
  withdrawAdvisory(id: string): void {
    this.db
      .prepare(
        `UPDATE skill_advisories
            SET withdrawn_at = datetime('now')
          WHERE id = ?`
      )
      .run(id)
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /**
   * Get all active (non-withdrawn) advisories for a specific skill.
   *
   * @param skillId - Registry skill identifier
   * @returns Array of active SkillAdvisory records ordered by published_at DESC
   */
  getAdvisoriesForSkill(skillId: string): SkillAdvisory[] {
    const rows = this.db
      .prepare(
        `SELECT id, skill_id, severity, title, description,
                affected_versions, patched_versions, cwe_ids, advisory_refs,
                published_at, withdrawn_at, created_at
           FROM skill_advisories
          WHERE skill_id = ?
            AND withdrawn_at IS NULL
          ORDER BY published_at DESC`
      )
      .all(skillId) as AdvisoryRow[]

    return rows.map((r) => this.rowToAdvisory(r))
  }

  /**
   * Get all active advisories, optionally filtered by severity.
   *
   * @param severity - Optional severity filter; omit to return all active advisories
   * @returns Array of active SkillAdvisory records ordered by published_at DESC
   */
  getActiveAdvisories(severity?: 'low' | 'medium' | 'high' | 'critical'): SkillAdvisory[] {
    let rows: AdvisoryRow[]

    if (severity) {
      rows = this.db
        .prepare(
          `SELECT id, skill_id, severity, title, description,
                  affected_versions, patched_versions, cwe_ids, advisory_refs,
                  published_at, withdrawn_at, created_at
             FROM skill_advisories
            WHERE withdrawn_at IS NULL
              AND severity = ?
            ORDER BY published_at DESC`
        )
        .all(severity) as AdvisoryRow[]
    } else {
      rows = this.db
        .prepare(
          `SELECT id, skill_id, severity, title, description,
                  affected_versions, patched_versions, cwe_ids, advisory_refs,
                  published_at, withdrawn_at, created_at
             FROM skill_advisories
            WHERE withdrawn_at IS NULL
            ORDER BY published_at DESC`
        )
        .all() as AdvisoryRow[]
    }

    return rows.map((r) => this.rowToAdvisory(r))
  }
}
