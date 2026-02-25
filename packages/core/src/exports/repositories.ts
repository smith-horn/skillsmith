/**
 * Repository Exports
 * @module exports/repositories
 *
 * Barrel file for repository-related exports
 */

// ============================================================================
// Database (SMI-577, SMI-974, SMI-2180)
// ============================================================================

export {
  SCHEMA_VERSION,
  createDatabase,
  openDatabase,
  closeDatabase,
  initializeSchema,
  getSchemaVersion,
  runMigrations,
  runMigrationsSafe,
  // SMI-2206: Async schema functions with WASM fallback
  createDatabaseAsync,
  openDatabaseAsync,
} from '../db/schema.js'

export type { DatabaseType } from '../db/schema.js'

// SMI-2180: Database abstraction layer exports (low-level factory)
export { createDatabaseSync } from '../db/createDatabase.js'
export type { Database } from '../db/database-interface.js'

// SMI-2180: Driver detection utilities
export { isBetterSqlite3Available } from '../db/drivers/betterSqlite3Driver.js'

// ============================================================================
// Repositories (SMI-578, SMI-628)
// ============================================================================

export { SkillRepository } from '../repositories/SkillRepository.js'
export { CacheRepository } from '../repositories/CacheRepository.js'
export { IndexerRepository } from '../repositories/IndexerRepository.js'

export type {
  IndexedSkill,
  UpsertResult,
  BatchUpsertResult,
} from '../repositories/IndexerRepository.js'

// ============================================================================
// Quarantine Management (SMI-865)
// ============================================================================

export {
  initializeQuarantineSchema,
  hasQuarantineTable,
  migrateQuarantineSchema,
  QUARANTINE_SEVERITY_POLICIES,
  type QuarantineSeverity,
  type QuarantineReviewStatus,
} from '../db/quarantine-schema.js'

export {
  QuarantineRepository,
  type QuarantineEntry,
  type QuarantineCreateInput,
  type QuarantineUpdateInput,
  type QuarantineQueryFilter,
  type PaginatedQuarantineResults,
  type QuarantineStats,
  type ReviewDecision,
} from '../repositories/QuarantineRepository.js'

// ============================================================================
// Database Migration (WS3: SMI-1446, SMI-1448, SMI-1452)
// ============================================================================

export {
  checkSchemaCompatibility,
  ensureSchemaCompatibility,
  mergeSkillDatabases,
  getSyncStatus,
  updateSyncStatus,
  recordSyncRun,
  getSyncHistory,
} from '../db/migration.js'

export type {
  SchemaCompatibility,
  MergeResult,
  MergeConflict,
  MergeStrategy,
  MergeOptions,
  SyncStatus as MigrationSyncStatus,
  SupabaseSyncConfig,
} from '../db/migration.js'

// ============================================================================
// Analytics Repository (Phase 4: Epic 3 & Epic 4)
// ============================================================================

export { initializeAnalyticsSchema, AnalyticsRepository } from '../analytics/index.js'

// ============================================================================
// Skill Version Repository (SMI-skill-version-tracking Wave 1)
// ============================================================================

export {
  SkillVersionRepository,
  type SkillVersionRow,
} from '../repositories/SkillVersionRepository.js'

// ============================================================================
// Versioning Utilities (SMI-skill-version-tracking Wave 2)
// ============================================================================

export { classifyChange, type ChangeType } from '../versioning/change-classifier.js'

export {
  computeUpdateRisk,
  type RiskLevel,
  type Recommendation,
  type UpdateRisk,
} from '../versioning/update-risk.js'
