/**
 * SMI-865: Quarantine Repository SQL Queries
 *
 * SQL query constants for quarantine management operations.
 */

/**
 * SQL query to insert a new quarantine entry
 */
export const INSERT_QUERY = `
  INSERT INTO quarantine (
    id, skill_id, source, quarantine_reason, severity,
    detected_patterns, quarantine_date, reviewed_by, review_status,
    review_notes, review_date, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, datetime('now'), datetime('now'))
`

/**
 * SQL query to select a quarantine entry by ID
 */
export const SELECT_BY_ID_QUERY = `
  SELECT * FROM quarantine WHERE id = ?
`

/**
 * SQL query to select quarantine entries by skill ID
 */
export const SELECT_BY_SKILL_ID_QUERY = `
  SELECT * FROM quarantine WHERE skill_id = ? ORDER BY quarantine_date DESC
`

/**
 * SQL query to select all quarantine entries with pagination
 */
export const SELECT_ALL_QUERY = `
  SELECT * FROM quarantine ORDER BY quarantine_date DESC LIMIT ? OFFSET ?
`

/**
 * SQL query to count all quarantine entries
 */
export const SELECT_COUNT_QUERY = `
  SELECT COUNT(*) as count FROM quarantine
`

/**
 * SQL query to update a quarantine entry
 */
export const UPDATE_QUERY = `
  UPDATE quarantine SET
    quarantine_reason = COALESCE(?, quarantine_reason),
    severity = COALESCE(?, severity),
    detected_patterns = COALESCE(?, detected_patterns),
    reviewed_by = COALESCE(?, reviewed_by),
    review_status = COALESCE(?, review_status),
    review_notes = COALESCE(?, review_notes),
    review_date = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE review_date END,
    updated_at = datetime('now')
  WHERE id = ?
`

/**
 * SQL query to delete a quarantine entry by ID
 */
export const DELETE_QUERY = `
  DELETE FROM quarantine WHERE id = ?
`

/**
 * SQL query to delete all quarantine entries for a skill
 */
export const DELETE_BY_SKILL_ID_QUERY = `
  DELETE FROM quarantine WHERE skill_id = ?
`

/**
 * SQL query to get total count
 */
export const STATS_TOTAL_QUERY = 'SELECT COUNT(*) as count FROM quarantine'

/**
 * SQL query to get counts by severity
 */
export const STATS_BY_SEVERITY_QUERY =
  'SELECT severity, COUNT(*) as count FROM quarantine GROUP BY severity'

/**
 * SQL query to get counts by review status
 */
export const STATS_BY_STATUS_QUERY =
  'SELECT review_status, COUNT(*) as count FROM quarantine GROUP BY review_status'

/**
 * SQL query to get pending review count
 */
export const STATS_PENDING_QUERY =
  "SELECT COUNT(*) as count FROM quarantine WHERE review_status = 'pending'"

/**
 * SQL query to get date range
 */
export const STATS_RANGE_QUERY =
  'SELECT MIN(quarantine_date) as oldest, MAX(quarantine_date) as newest FROM quarantine'
