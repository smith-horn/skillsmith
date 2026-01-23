/**
 * @fileoverview PatternStore database query operations
 * @module @skillsmith/core/learning/PatternStore.queries
 *
 * Database operations extracted for file size reduction.
 */

import type Database from 'better-sqlite3'
import type { StoredPattern, PatternRow, PatternOutcomeType } from './PatternStore.types.js'
import { rowToStoredPattern } from './PatternStore.helpers.js'

// ============================================================================
// Pattern Count Operations
// ============================================================================

/**
 * Get total pattern count from database
 */
export function getPatternCount(db: Database.Database): number {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM patterns')
  const result = stmt.get() as { count: number }
  return result.count
}

/**
 * Get database size in bytes
 */
export function getDatabaseSize(db: Database.Database): number {
  const stmt = db.prepare(
    'SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()'
  )
  const result = stmt.get() as { size: number } | undefined
  return result?.size ?? 0
}

// ============================================================================
// Pattern Retrieval Operations
// ============================================================================

/**
 * Get sample patterns for Fisher estimation
 */
export function getSamplePatterns(
  db: Database.Database,
  limit: number,
  dimensions: number
): StoredPattern[] {
  const stmt = db.prepare('SELECT * FROM patterns ORDER BY RANDOM() LIMIT ?')
  const rows = stmt.all(limit) as PatternRow[]
  return rows.map((row) => rowToStoredPattern(row, dimensions))
}

/**
 * Get all patterns from database
 */
export function getAllPatterns(db: Database.Database, dimensions: number): StoredPattern[] {
  const stmt = db.prepare('SELECT * FROM patterns')
  const rows = stmt.all() as PatternRow[]
  return rows.map((row) => rowToStoredPattern(row, dimensions))
}

// ============================================================================
// Pattern Update Operations
// ============================================================================

/**
 * Update pattern in database
 */
export function updatePatternInDB(
  db: Database.Database,
  patternId: string,
  updates: { importance?: number; accessCount?: number }
): void {
  const sets: string[] = []
  const params: unknown[] = []

  if (updates.importance !== undefined) {
    sets.push('importance = ?')
    params.push(updates.importance)
  }
  if (updates.accessCount !== undefined) {
    sets.push('access_count = ?')
    params.push(updates.accessCount)
  }

  sets.push('last_accessed_at = unixepoch()')
  params.push(patternId)

  const stmt = db.prepare(`UPDATE patterns SET ${sets.join(', ')} WHERE pattern_id = ?`)
  stmt.run(...params)
}

/**
 * Update pattern importance
 */
export function updatePatternImportance(
  db: Database.Database,
  patternId: string,
  importance: number
): void {
  const stmt = db.prepare('UPDATE patterns SET importance = ? WHERE pattern_id = ?')
  stmt.run(importance, patternId)
}

/**
 * Update pattern access count
 */
export function updateAccessCount(db: Database.Database, patternId: string): void {
  const stmt = db.prepare(
    'UPDATE patterns SET access_count = access_count + 1, last_accessed_at = unixepoch() WHERE pattern_id = ?'
  )
  stmt.run(patternId)
}

/**
 * Delete pattern from database
 */
export function deletePattern(db: Database.Database, patternId: string): void {
  const stmt = db.prepare('DELETE FROM patterns WHERE pattern_id = ?')
  stmt.run(patternId)
}

// ============================================================================
// Fisher Matrix Persistence
// ============================================================================

/**
 * Load Fisher matrix data from database
 */
export function loadFisherMatrixData(db: Database.Database): Buffer | null {
  const stmt = db.prepare('SELECT matrix_data FROM fisher_info WHERE id = 1')
  const result = stmt.get() as { matrix_data: Buffer } | undefined
  return result?.matrix_data ?? null
}

/**
 * Save Fisher matrix data to database
 */
export function saveFisherMatrixData(
  db: Database.Database,
  matrixData: Buffer,
  updateCount: number
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO fisher_info (id, matrix_data, update_count, last_decay_at, updated_at)
    VALUES (1, ?, ?, unixepoch(), unixepoch())
  `)
  stmt.run(matrixData, updateCount)
}

// ============================================================================
// Consolidation History
// ============================================================================

/**
 * Record consolidation in history
 */
export function recordConsolidation(
  db: Database.Database,
  patternsProcessed: number,
  patternsPreserved: number,
  patternsPruned: number,
  preservationRate: number,
  durationMs: number,
  averageImportance: number
): void {
  const stmt = db.prepare(`
    INSERT INTO consolidation_history (
      patterns_processed, patterns_preserved, patterns_pruned,
      preservation_rate, duration_ms, average_importance
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    patternsProcessed,
    patternsPreserved,
    patternsPruned,
    preservationRate,
    durationMs,
    averageImportance
  )
}

// ============================================================================
// Metrics Queries
// ============================================================================

/**
 * Get pattern counts by outcome type
 */
export function getPatternsByOutcome(db: Database.Database): Record<PatternOutcomeType, number> {
  const stmt = db.prepare(
    'SELECT outcome_type, COUNT(*) as count FROM patterns GROUP BY outcome_type'
  )
  const rows = stmt.all() as Array<{ outcome_type: string; count: number }>

  const patternsByOutcome: Record<PatternOutcomeType, number> = {
    accept: 0,
    usage: 0,
    frequent: 0,
    dismiss: 0,
    abandonment: 0,
    uninstall: 0,
  }

  for (const row of rows) {
    patternsByOutcome[row.outcome_type as PatternOutcomeType] = row.count
  }

  return patternsByOutcome
}

/**
 * Get average pattern importance
 */
export function getAverageImportance(db: Database.Database): number {
  const stmt = db.prepare('SELECT AVG(importance) as avg FROM patterns')
  const result = stmt.get() as { avg: number | null }
  return result?.avg ?? 0
}

/**
 * Get count of high importance patterns (top 10%)
 */
export function getHighImportanceCount(db: Database.Database): number {
  const stmt = db.prepare(`
    SELECT importance FROM patterns ORDER BY importance DESC
    LIMIT CAST((SELECT COUNT(*) FROM patterns) * 0.1 AS INTEGER)
  `)
  return stmt.all().length
}

/**
 * Get consolidation statistics
 */
export function getConsolidationStats(db: Database.Database): {
  total: number
  lastTimestamp: number | null
  avgRate: number | null
  totalPruned: number | null
} {
  const stmt = db.prepare(`
    SELECT COUNT(*) as total, MAX(timestamp) as last_timestamp,
           AVG(preservation_rate) as avg_rate, SUM(patterns_pruned) as total_pruned
    FROM consolidation_history
  `)
  const result = stmt.get() as {
    total: number
    last_timestamp: number | null
    avg_rate: number | null
    total_pruned: number | null
  }

  return {
    total: result.total,
    lastTimestamp: result.last_timestamp,
    avgRate: result.avg_rate,
    totalPruned: result.total_pruned,
  }
}

/**
 * Get context embeddings for average calculation
 */
export function getContextEmbeddings(
  db: Database.Database,
  limit: number
): Array<{ context_embedding: Buffer }> {
  const stmt = db.prepare('SELECT context_embedding FROM patterns LIMIT ?')
  return stmt.all(limit) as Array<{ context_embedding: Buffer }>
}
