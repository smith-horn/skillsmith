/**
 * Database Migration Utilities
 *
 * SMI-1446: Handle schema version mismatch during imports
 * SMI-1448: Database merge tooling for combining skill databases
 * SMI-1452: Sync utilities for local-to-Supabase synchronization
 *
 * @see migration-types.ts for type definitions
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { SCHEMA_VERSION, getSchemaVersion, runMigrationsSafe, MIGRATIONS } from './schema.js'

// Re-export types
export type {
  SchemaCompatibility,
  MergeResult,
  MergeConflict,
  MergeStrategy,
  MergeOptions,
  SyncStatus,
  SupabaseSyncConfig,
  SkillRow,
  SyncHistoryEntry,
} from './migration-types.js'

// Import types
import type {
  SchemaCompatibility,
  MergeResult,
  MergeConflict,
  MergeOptions,
  SyncHistoryEntry,
} from './migration-types.js'

// ============================================================================
// SMI-1446: Schema Version Compatibility
// ============================================================================

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

  if (currentVersion > expectedVersion) {
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

export function ensureSchemaCompatibility(db: DatabaseType): void {
  const compatibility = checkSchemaCompatibility(db)

  switch (compatibility.action) {
    case 'none':
      break
    case 'upgrade': {
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

type SkillRow = {
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

  ensureSchemaCompatibility(target)
  const sourceCompatibility = checkSchemaCompatibility(source)
  if (!sourceCompatibility.isCompatible) {
    throw new Error(`Source database: ${sourceCompatibility.message}`)
  }

  const sourceSkills = source
    .prepare(
      `SELECT id, name, description, author, repo_url, quality_score,
              trust_tier, tags, created_at, updated_at, source, stars FROM skills`
    )
    .all() as SkillRow[]

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

  const transaction = target.transaction(() => {
    for (const skill of sourceSkills) {
      const existing = getTargetSkill.get(skill.id) as SkillRow | undefined

      if (!existing) {
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
        const conflict: MergeConflict = {
          skillId: skill.id,
          reason: 'duplicate_id',
          sourceValue: skill.updated_at,
          targetValue: existing.updated_at,
        }

        let effectiveStrategy = options.strategy
        if (options.onConflict) effectiveStrategy = options.onConflict(conflict)

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

  if (!options.dryRun) {
    transaction()
  } else {
    try {
      transaction()
    } catch {
      /* Dry run may fail on readonly */
    }
  }

  result.duration = Date.now() - startTime
  return result
}

// ============================================================================
// SMI-1452: Supabase Sync Utilities
// ============================================================================

export function getSyncStatus(
  db: DatabaseType
): Omit<
  {
    connected: boolean
    lastSyncAt: string | null
    nextSyncAt: string | null
    skillsInLocal: number
    skillsInRemote: number
    pendingUploads: number
    pendingDownloads: number
  },
  'connected' | 'skillsInRemote'
> {
  const config = db
    .prepare('SELECT last_sync_at, next_sync_at FROM sync_config WHERE id = ?')
    .get('default') as { last_sync_at: string | null; next_sync_at: string | null } | undefined

  const skillCount = db.prepare('SELECT COUNT(*) as count FROM skills').get() as { count: number }

  return {
    lastSyncAt: config?.last_sync_at || null,
    nextSyncAt: config?.next_sync_at || null,
    skillsInLocal: skillCount.count,
    pendingUploads: 0,
    pendingDownloads: 0,
  }
}

export function updateSyncStatus(
  db: DatabaseType,
  result: { skillsAdded: number; skillsUpdated: number; error?: string }
): void {
  const now = new Date().toISOString()
  const nextSync = new Date(Date.now() + 86400000).toISOString()

  db.prepare(
    `
    UPDATE sync_config SET
      last_sync_at = ?, next_sync_at = ?, last_sync_count = ?, last_sync_error = ?, updated_at = ?
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

export function getSyncHistory(db: DatabaseType, limit = 10): SyncHistoryEntry[] {
  return db
    .prepare(`SELECT * FROM sync_history ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as SyncHistoryEntry[]
}
