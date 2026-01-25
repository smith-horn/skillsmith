/**
 * Type definitions for Database Migration Utilities
 * @module @skillsmith/core/db/migration-types
 */

// ============================================================================
// SMI-1446: Schema Version Compatibility
// ============================================================================

/**
 * Schema compatibility status
 */
export interface SchemaCompatibility {
  isCompatible: boolean
  currentVersion: number
  expectedVersion: number
  action: 'none' | 'upgrade' | 'downgrade_warning' | 'incompatible'
  message: string
}

// ============================================================================
// SMI-1448: Database Merge Tooling
// ============================================================================

/**
 * Merge result statistics
 */
export interface MergeResult {
  skillsAdded: number
  skillsUpdated: number
  skillsSkipped: number
  conflicts: MergeConflict[]
  duration: number
}

/**
 * Merge conflict information
 */
export interface MergeConflict {
  skillId: string
  reason: 'duplicate_id' | 'schema_mismatch' | 'validation_error'
  sourceValue?: unknown
  targetValue?: unknown
  resolution?: 'kept_target' | 'updated' | 'skipped'
}

/**
 * Merge strategy options
 */
export type MergeStrategy = 'keep_target' | 'keep_source' | 'keep_newer' | 'merge_fields'

/**
 * Merge options configuration
 */
export interface MergeOptions {
  strategy: MergeStrategy
  dryRun?: boolean
  onConflict?: (conflict: MergeConflict) => MergeStrategy
  skipInvalid?: boolean
}

// ============================================================================
// SMI-1452: Supabase Sync Utilities
// ============================================================================

/**
 * Sync status for Supabase integration
 */
export interface SyncStatus {
  connected: boolean
  lastSyncAt: string | null
  nextSyncAt: string | null
  skillsInLocal: number
  skillsInRemote: number
  pendingUploads: number
  pendingDownloads: number
}

/**
 * Supabase sync configuration
 */
export interface SupabaseSyncConfig {
  url: string
  anonKey: string
  table?: string
  batchSize?: number
  conflictStrategy?: MergeStrategy
}

/**
 * Skill row from database
 */
export interface SkillRow {
  id: string
  name: string
  description: string | null
  author: string | null
  repo_url: string | null
  quality_score: number | null
  trust_tier: string
  tags: string
  created_at: string
  updated_at: string
  source: string | null
  stars: number | null
}

/**
 * Sync history entry
 */
export interface SyncHistoryEntry {
  id: string
  started_at: string
  completed_at: string | null
  status: string
  skills_added: number
  skills_updated: number
  skills_unchanged: number
  error_message: string | null
  duration_ms: number | null
}
