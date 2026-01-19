/**
 * Database Migration Utilities
 *
 * SMI-1446: Handle schema version mismatch during imports
 * SMI-1448: Database merge tooling for combining skill databases
 * SMI-1452: Sync utilities for local-to-Supabase synchronization
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { SCHEMA_VERSION, getSchemaVersion, runMigrationsSafe, MIGRATIONS } from './schema.js'

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

/**
 * Check schema compatibility between database and expected version
 * SMI-1446: Detects version mismatches that block imports
 */
export function checkSchemaCompatibility(db: DatabaseType): SchemaCompatibility {
  const currentVersion = getSchemaVersion(db)
  const expectedVersion = SCHEMA_VERSION

  if (currentVersion === expectedVersion) {
    return {
      isCompatible: true,
      currentVersion,
      expectedVersion,
      action: 'none',
      message: `Database schema is up to date (v${currentVersion})`,
    }
  }

  if (currentVersion < expectedVersion) {
    return {
      isCompatible: true,
      currentVersion,
      expectedVersion,
      action: 'upgrade',
      message: `Database schema v${currentVersion} can be upgraded to v${expectedVersion}`,
    }
  }

  // Database is newer than expected - might be from a newer version of Skillsmith
  if (currentVersion > expectedVersion) {
    // Check if downgrade is safe (no breaking changes in migrations)
    const hasBreakingChanges = MIGRATIONS.slice(expectedVersion).some(
      (m) => m.sql.includes('DROP') || m.sql.includes('RENAME')
    )

    if (hasBreakingChanges) {
      return {
        isCompatible: false,
        currentVersion,
        expectedVersion,
        action: 'incompatible',
        message: `Database schema v${currentVersion} is incompatible with this version of Skillsmith (expected v${expectedVersion}). Please upgrade Skillsmith or use a compatible database.`,
      }
    }

    return {
      isCompatible: true,
      currentVersion,
      expectedVersion,
      action: 'downgrade_warning',
      message: `Database schema v${currentVersion} is newer than expected v${expectedVersion}. This may work but is not recommended. Consider upgrading Skillsmith.`,
    }
  }

  return {
    isCompatible: false,
    currentVersion,
    expectedVersion,
    action: 'incompatible',
    message: 'Unknown schema compatibility issue',
  }
}

/**
 * Ensure database schema is compatible, running migrations if needed
 * SMI-1446: Safe migration that handles version mismatches
 *
 * @throws Error if schema is incompatible
 */
export function ensureSchemaCompatibility(db: DatabaseType): void {
  const compatibility = checkSchemaCompatibility(db)

  switch (compatibility.action) {
    case 'none':
      // Already compatible
      break

    case 'upgrade': {
      // Run migrations
      const migrationsRun = runMigrationsSafe(db)
      if (migrationsRun > 0) {
        console.log(`Upgraded database schema: ${migrationsRun} migration(s) applied`)
      }
      break
    }

    case 'downgrade_warning':
      console.warn(compatibility.message)
      break

    case 'incompatible':
      throw new Error(compatibility.message)
  }
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

/**
 * Merge skills from source database into target database
 * SMI-1448: Core merge functionality
 *
 * @param target - Target database to merge into
 * @param source - Source database to merge from
 * @param options - Merge configuration
 */
export function mergeSkillDatabases(
  target: DatabaseType,
  source: DatabaseType,
  options: MergeOptions = { strategy: 'keep_newer' }
): MergeResult {
  const startTime = Date.now()
  const result: MergeResult = {
    skillsAdded: 0,
    skillsUpdated: 0,
    skillsSkipped: 0,
    conflicts: [],
    duration: 0,
  }

  // Ensure both databases are compatible
  ensureSchemaCompatibility(target)

  const sourceCompatibility = checkSchemaCompatibility(source)
  if (!sourceCompatibility.isCompatible) {
    throw new Error(`Source database: ${sourceCompatibility.message}`)
  }

  // Get all skills from source
  const sourceSkills = source
    .prepare(
      `SELECT id, name, description, author, repo_url, quality_score,
              trust_tier, tags, created_at, updated_at, source, stars
       FROM skills`
    )
    .all() as Array<{
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
  }>

  // Prepare statements
  const getTargetSkill = target.prepare('SELECT * FROM skills WHERE id = ?')
  const insertSkill = target.prepare(`
    INSERT INTO skills (id, name, description, author, repo_url, quality_score,
                       trust_tier, tags, created_at, updated_at, source, stars)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const updateSkill = target.prepare(`
    UPDATE skills SET
      name = ?, description = ?, author = ?, repo_url = ?, quality_score = ?,
      trust_tier = ?, tags = ?, updated_at = ?, source = ?, stars = ?
    WHERE id = ?
  `)

  // Process each skill
  const transaction = target.transaction(() => {
    for (const skill of sourceSkills) {
      const existing = getTargetSkill.get(skill.id) as typeof skill | undefined

      if (!existing) {
        // New skill - add it
        if (!options.dryRun) {
          insertSkill.run(
            skill.id,
            skill.name,
            skill.description,
            skill.author,
            skill.repo_url,
            skill.quality_score,
            skill.trust_tier,
            skill.tags,
            skill.created_at,
            skill.updated_at,
            skill.source,
            skill.stars
          )
        }
        result.skillsAdded++
      } else {
        // Skill exists - handle conflict
        const conflict: MergeConflict = {
          skillId: skill.id,
          reason: 'duplicate_id',
          sourceValue: skill.updated_at,
          targetValue: existing.updated_at,
        }

        // Determine strategy
        let effectiveStrategy = options.strategy
        if (options.onConflict) {
          effectiveStrategy = options.onConflict(conflict)
        }

        switch (effectiveStrategy) {
          case 'keep_target':
            conflict.resolution = 'kept_target'
            result.skillsSkipped++
            break

          case 'keep_source':
            if (!options.dryRun) {
              updateSkill.run(
                skill.name,
                skill.description,
                skill.author,
                skill.repo_url,
                skill.quality_score,
                skill.trust_tier,
                skill.tags,
                skill.updated_at,
                skill.source,
                skill.stars,
                skill.id
              )
            }
            conflict.resolution = 'updated'
            result.skillsUpdated++
            break

          case 'keep_newer': {
            const sourceDate = new Date(skill.updated_at).getTime()
            const targetDate = new Date(existing.updated_at).getTime()

            if (sourceDate > targetDate) {
              if (!options.dryRun) {
                updateSkill.run(
                  skill.name,
                  skill.description,
                  skill.author,
                  skill.repo_url,
                  skill.quality_score,
                  skill.trust_tier,
                  skill.tags,
                  skill.updated_at,
                  skill.source,
                  skill.stars,
                  skill.id
                )
              }
              conflict.resolution = 'updated'
              result.skillsUpdated++
            } else {
              conflict.resolution = 'kept_target'
              result.skillsSkipped++
            }
            break
          }

          case 'merge_fields': {
            // Merge non-null fields from source into target
            const merged = {
              name: skill.name || existing.name,
              description: skill.description || existing.description,
              author: skill.author || existing.author,
              repo_url: skill.repo_url || existing.repo_url,
              quality_score:
                skill.quality_score !== null ? skill.quality_score : existing.quality_score,
              trust_tier: skill.trust_tier !== 'unknown' ? skill.trust_tier : existing.trust_tier,
              tags: skill.tags !== '[]' ? skill.tags : existing.tags,
              updated_at:
                new Date(skill.updated_at) > new Date(existing.updated_at)
                  ? skill.updated_at
                  : existing.updated_at,
              source: skill.source || existing.source,
              stars: skill.stars !== null ? skill.stars : existing.stars,
            }

            if (!options.dryRun) {
              updateSkill.run(
                merged.name,
                merged.description,
                merged.author,
                merged.repo_url,
                merged.quality_score,
                merged.trust_tier,
                merged.tags,
                merged.updated_at,
                merged.source,
                merged.stars,
                skill.id
              )
            }
            conflict.resolution = 'updated'
            result.skillsUpdated++
            break
          }
        }

        result.conflicts.push(conflict)
      }
    }
  })

  // Execute transaction (unless dry run)
  if (!options.dryRun) {
    transaction()
  } else {
    // Still run to collect stats, but rollback
    try {
      transaction()
    } catch {
      // Dry run may fail on readonly, that's ok
    }
  }

  result.duration = Date.now() - startTime
  return result
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
 * Get sync status from local database
 * SMI-1452: Reports current sync state
 */
export function getSyncStatus(db: DatabaseType): Omit<SyncStatus, 'connected' | 'skillsInRemote'> {
  const config = db
    .prepare('SELECT last_sync_at, next_sync_at FROM sync_config WHERE id = ?')
    .get('default') as { last_sync_at: string | null; next_sync_at: string | null } | undefined

  const skillCount = db.prepare('SELECT COUNT(*) as count FROM skills').get() as { count: number }

  return {
    lastSyncAt: config?.last_sync_at || null,
    nextSyncAt: config?.next_sync_at || null,
    skillsInLocal: skillCount.count,
    pendingUploads: 0, // Would need change tracking to implement
    pendingDownloads: 0,
  }
}

/**
 * Update sync status after a sync operation
 * SMI-1452: Records sync results
 */
export function updateSyncStatus(
  db: DatabaseType,
  result: { skillsAdded: number; skillsUpdated: number; error?: string }
): void {
  const now = new Date().toISOString()
  const nextSync = new Date(Date.now() + 86400000).toISOString() // Default: 24 hours

  db.prepare(
    `
    UPDATE sync_config SET
      last_sync_at = ?,
      next_sync_at = ?,
      last_sync_count = ?,
      last_sync_error = ?,
      updated_at = ?
    WHERE id = ?
  `
  ).run(
    now,
    nextSync,
    result.skillsAdded + result.skillsUpdated,
    result.error || null,
    now,
    'default'
  )
}

/**
 * Record a sync run in history
 * SMI-1452: Tracks sync history for debugging
 */
export function recordSyncRun(
  db: DatabaseType,
  status: 'running' | 'success' | 'failed' | 'partial',
  result?: MergeResult,
  error?: string
): string {
  const id = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()

  db.prepare(
    `
    INSERT INTO sync_history (id, started_at, completed_at, status, skills_added,
                             skills_updated, skills_unchanged, error_message, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    now,
    status === 'running' ? null : now,
    status,
    result?.skillsAdded || 0,
    result?.skillsUpdated || 0,
    result?.skillsSkipped || 0,
    error || null,
    result?.duration || null
  )

  return id
}

/**
 * Get recent sync history
 * SMI-1452: Returns sync history for monitoring
 */
export function getSyncHistory(
  db: DatabaseType,
  limit = 10
): Array<{
  id: string
  started_at: string
  completed_at: string | null
  status: string
  skills_added: number
  skills_updated: number
  skills_unchanged: number
  error_message: string | null
  duration_ms: number | null
}> {
  return db
    .prepare(
      `
    SELECT * FROM sync_history
    ORDER BY started_at DESC
    LIMIT ?
  `
    )
    .all(limit) as Array<{
    id: string
    started_at: string
    completed_at: string | null
    status: string
    skills_added: number
    skills_updated: number
    skills_unchanged: number
    error_message: string | null
    duration_ms: number | null
  }>
}
