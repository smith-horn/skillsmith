/**
 * Repository Exports
 * @module exports/repositories
 *
 * Barrel file for repository-related exports
 */

// ============================================================================
// Database (SMI-577, SMI-974)
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
} from '../db/schema.js'

export type { DatabaseType } from '../db/schema.js'

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
