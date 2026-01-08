/**
 * SMI-865: Quarantine Query Builder
 *
 * Dynamic query building for filtered quarantine searches.
 */

import type { QuarantineQueryFilter, QuarantineRow } from './types.js'

/**
 * Query builder result containing SQL and parameters
 */
export interface QueryBuilderResult {
  query: string
  countQuery: string
  params: unknown[]
  countParams: unknown[]
}

/**
 * Build a dynamic query based on filter options
 *
 * @param filter - Query filter options
 * @returns Query strings and parameters for execution
 */
export function buildFilteredQuery(filter: QuarantineQueryFilter): QueryBuilderResult {
  const { skillId, source, severity, reviewStatus, reviewedBy, since, until, limit = 20, offset = 0 } = filter

  let query = 'SELECT * FROM quarantine WHERE 1=1'
  let countQuery = 'SELECT COUNT(*) as count FROM quarantine WHERE 1=1'
  const params: unknown[] = []
  const countParams: unknown[] = []

  if (skillId) {
    query += ' AND skill_id = ?'
    countQuery += ' AND skill_id = ?'
    params.push(skillId)
    countParams.push(skillId)
  }

  if (source) {
    query += ' AND source = ?'
    countQuery += ' AND source = ?'
    params.push(source)
    countParams.push(source)
  }

  if (severity) {
    query += ' AND severity = ?'
    countQuery += ' AND severity = ?'
    params.push(severity)
    countParams.push(severity)
  }

  if (reviewStatus) {
    query += ' AND review_status = ?'
    countQuery += ' AND review_status = ?'
    params.push(reviewStatus)
    countParams.push(reviewStatus)
  }

  if (reviewedBy) {
    query += ' AND reviewed_by = ?'
    countQuery += ' AND reviewed_by = ?'
    params.push(reviewedBy)
    countParams.push(reviewedBy)
  }

  if (since) {
    query += ' AND quarantine_date >= ?'
    countQuery += ' AND quarantine_date >= ?'
    params.push(since.toISOString())
    countParams.push(since.toISOString())
  }

  if (until) {
    query += ' AND quarantine_date <= ?'
    countQuery += ' AND quarantine_date <= ?'
    params.push(until.toISOString())
    countParams.push(until.toISOString())
  }

  query += ' ORDER BY quarantine_date DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  return { query, countQuery, params, countParams }
}

/**
 * Convert a database row to a QuarantineEntry object
 *
 * @param row - Database row
 * @returns Converted QuarantineEntry
 */
export function rowToEntry(row: QuarantineRow) {
  return {
    id: row.id,
    skillId: row.skill_id,
    source: row.source,
    quarantineReason: row.quarantine_reason,
    severity: row.severity,
    detectedPatterns: JSON.parse(row.detected_patterns || '[]'),
    quarantineDate: row.quarantine_date,
    reviewedBy: row.reviewed_by,
    reviewStatus: row.review_status,
    reviewNotes: row.review_notes,
    reviewDate: row.review_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
