/**
 * @fileoverview Risk Score History Repository
 * @module @skillsmith/core/repositories/RiskScoreHistoryRepository
 * @see SMI-3864: Security-informed quality scoring
 *
 * CRUD operations for the risk_score_history table.
 * Records point-in-time snapshots after each security scan
 * for trend detection and supply chain attack monitoring.
 */

import type { Database } from '../db/database-interface.js'

export interface RiskScoreSnapshot {
  id: number
  skillId: string
  riskScore: number
  findingsCount: number
  contentHash: string | null
  scannedAt: string
  source: 'install' | 'indexer' | 'rescan'
}

/** Maximum history entries per skill before pruning (Review #7) */
const MAX_HISTORY_PER_SKILL = 100

export class RiskScoreHistoryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Record a risk score snapshot. Prunes old entries to cap at
   * MAX_HISTORY_PER_SKILL per skill (Review #7).
   */
  record(snapshot: Omit<RiskScoreSnapshot, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO risk_score_history (skill_id, risk_score, findings_count, content_hash, scanned_at, source)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.skillId,
        snapshot.riskScore,
        snapshot.findingsCount,
        snapshot.contentHash,
        snapshot.scannedAt,
        snapshot.source
      )

    // Prune old entries beyond the cap
    this.db
      .prepare(
        `DELETE FROM risk_score_history
         WHERE skill_id = ? AND id NOT IN (
           SELECT id FROM risk_score_history
           WHERE skill_id = ?
           ORDER BY scanned_at DESC
           LIMIT ?
         )`
      )
      .run(snapshot.skillId, snapshot.skillId, MAX_HISTORY_PER_SKILL)
  }

  /**
   * Get risk score history for a skill, most recent first.
   */
  getHistory(skillId: string, limit: number = 50): RiskScoreSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT id, skill_id, risk_score, findings_count, content_hash, scanned_at, source
         FROM risk_score_history
         WHERE skill_id = ?
         ORDER BY scanned_at DESC
         LIMIT ?`
      )
      .all(skillId, limit) as Array<{
      id: number
      skill_id: string
      risk_score: number
      findings_count: number
      content_hash: string | null
      scanned_at: string
      source: string
    }>

    return rows.map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      riskScore: row.risk_score,
      findingsCount: row.findings_count,
      contentHash: row.content_hash,
      scannedAt: row.scanned_at,
      source: row.source as RiskScoreSnapshot['source'],
    }))
  }

  /**
   * Get the most recent risk score snapshot for a skill.
   */
  getLatest(skillId: string): RiskScoreSnapshot | null {
    const rows = this.getHistory(skillId, 1)
    return rows.length > 0 ? rows[0] : null
  }
}
