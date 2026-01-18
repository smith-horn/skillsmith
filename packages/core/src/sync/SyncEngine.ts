/**
 * SyncEngine - Core sync logic for registry synchronization
 *
 * Implements differential sync by comparing local database state with
 * the live Skillsmith registry API. Fetches only changed skills based
 * on updated_at timestamps.
 */

import type { SkillsmithApiClient, ApiSearchResult } from '../api/client.js'
import type { SkillRepository } from '../repositories/SkillRepository.js'
import type { SyncConfigRepository } from '../repositories/SyncConfigRepository.js'
import type { SyncHistoryRepository } from '../repositories/SyncHistoryRepository.js'

/**
 * Sync options
 */
export interface SyncOptions {
  /** Force full sync (ignore lastSyncAt) */
  force?: boolean
  /** Don't write changes, just report what would sync */
  dryRun?: boolean
  /** API pagination size (default: 100) */
  pageSize?: number
  /** Progress callback */
  onProgress?: (progress: SyncProgress) => void
}

/**
 * Sync progress info
 */
export interface SyncProgress {
  phase: 'connecting' | 'fetching' | 'comparing' | 'upserting' | 'complete'
  current: number
  total: number
  skillsProcessed: number
  skillsChanged: number
  message?: string
}

/**
 * Sync result
 */
export interface SyncResult {
  success: boolean
  skillsAdded: number
  skillsUpdated: number
  skillsUnchanged: number
  totalProcessed: number
  errors: string[]
  durationMs: number
  dryRun: boolean
}

/**
 * Internal upsert stats
 */
interface UpsertStats {
  added: number
  updated: number
  unchanged: number
}

/**
 * Sync engine for registry synchronization
 */
export class SyncEngine {
  private apiClient: SkillsmithApiClient
  private skillRepo: SkillRepository
  private syncConfigRepo: SyncConfigRepository
  private syncHistoryRepo: SyncHistoryRepository

  constructor(
    apiClient: SkillsmithApiClient,
    skillRepo: SkillRepository,
    syncConfigRepo: SyncConfigRepository,
    syncHistoryRepo: SyncHistoryRepository
  ) {
    this.apiClient = apiClient
    this.skillRepo = skillRepo
    this.syncConfigRepo = syncConfigRepo
    this.syncHistoryRepo = syncHistoryRepo
  }

  /**
   * Run sync operation
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const { force = false, dryRun = false, pageSize = 100, onProgress } = options

    const startTime = Date.now()
    const errors: string[] = []
    let skillsAdded = 0
    let skillsUpdated = 0
    let skillsUnchanged = 0
    let totalProcessed = 0

    // Start history tracking (skip for dry run)
    const runId = dryRun ? null : this.syncHistoryRepo.startRun()

    try {
      // Check if offline
      if (this.apiClient.isOffline()) {
        throw new Error('API client is in offline mode. Cannot sync.')
      }

      // Get last sync time for differential sync
      const config = this.syncConfigRepo.getConfig()
      const lastSyncAt = force ? null : config.lastSyncAt

      onProgress?.({
        phase: 'connecting',
        current: 0,
        total: 0,
        skillsProcessed: 0,
        skillsChanged: 0,
        message: 'Checking API health...',
      })

      // Health check
      const health = await this.apiClient.checkHealth()
      if (health.status === 'unhealthy') {
        throw new Error('API is unhealthy. Try again later.')
      }

      onProgress?.({
        phase: 'fetching',
        current: 0,
        total: 0,
        skillsProcessed: 0,
        skillsChanged: 0,
        message: lastSyncAt ? `Fetching changes since ${lastSyncAt}` : 'Fetching all skills...',
      })

      // Fetch all skills from API with pagination
      let offset = 0
      let hasMore = true
      const allSkills: ApiSearchResult[] = []

      // API requires min 2 char query - use multiple broad queries to cover more skills
      // These common terms appear in most skill names/descriptions
      const searchQueries = ['git', 'code', 'dev', 'test', 'npm', 'api', 'cli', 'doc']
      const seenIds = new Set<string>()

      for (const searchQuery of searchQueries) {
        offset = 0
        hasMore = true

        while (hasMore) {
          try {
            const response = await this.apiClient.search({
              query: searchQuery,
              limit: pageSize,
              offset,
            })

            const skills = response.data

            // Deduplicate skills across queries
            for (const skill of skills) {
              if (!seenIds.has(skill.id)) {
                seenIds.add(skill.id)
                allSkills.push(skill)
              }
            }

            onProgress?.({
              phase: 'fetching',
              current: allSkills.length,
              total: 0, // Unknown total
              skillsProcessed: 0,
              skillsChanged: 0,
              message: `Fetched ${allSkills.length} skills...`,
            })

            // Check if there are more results
            hasMore = skills.length === pageSize
            offset += pageSize
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            errors.push(`Fetch error at offset ${offset}: ${message}`)
            // Continue with what we have if we got some results
            if (allSkills.length > 0) {
              hasMore = false
            } else {
              throw error
            }
          }
        }
      }

      onProgress?.({
        phase: 'comparing',
        current: 0,
        total: allSkills.length,
        skillsProcessed: 0,
        skillsChanged: 0,
        message: 'Comparing with local database...',
      })

      // Filter for changed skills if doing differential sync
      // SMI-1577: Handle optional updated_at field
      // Skills without timestamps are skipped in differential sync (caught by full sync)
      const skillsToProcess = lastSyncAt
        ? allSkills.filter((skill) => {
            if (!skill.updated_at) {
              // Skip skills without timestamps in differential sync
              return false
            }
            return new Date(skill.updated_at) > new Date(lastSyncAt)
          })
        : allSkills

      totalProcessed = allSkills.length

      onProgress?.({
        phase: 'upserting',
        current: 0,
        total: skillsToProcess.length,
        skillsProcessed: totalProcessed,
        skillsChanged: skillsToProcess.length,
        message: `Processing ${skillsToProcess.length} changed skills...`,
      })

      // Upsert changed skills
      if (!dryRun && skillsToProcess.length > 0) {
        const stats = await this.upsertSkills(skillsToProcess, (current) => {
          onProgress?.({
            phase: 'upserting',
            current,
            total: skillsToProcess.length,
            skillsProcessed: totalProcessed,
            skillsChanged: skillsToProcess.length,
            message: `Upserting skill ${current}/${skillsToProcess.length}...`,
          })
        })

        skillsAdded = stats.added
        skillsUpdated = stats.updated
        skillsUnchanged = stats.unchanged
      } else if (dryRun) {
        // In dry run, count what would be added/updated
        for (const skill of skillsToProcess) {
          const existing = this.skillRepo.findById(skill.id)
          if (existing) {
            skillsUpdated++
          } else {
            skillsAdded++
          }
        }
        skillsUnchanged = allSkills.length - skillsToProcess.length
      } else {
        skillsUnchanged = allSkills.length
      }

      const durationMs = Date.now() - startTime

      // Update sync state (skip for dry run)
      if (!dryRun) {
        const syncTimestamp = new Date().toISOString()
        this.syncConfigRepo.setLastSync(syncTimestamp, skillsAdded + skillsUpdated)

        if (runId) {
          if (errors.length > 0) {
            this.syncHistoryRepo.completeRunPartial(
              runId,
              { skillsAdded, skillsUpdated, skillsUnchanged },
              errors.join('; ')
            )
          } else {
            this.syncHistoryRepo.completeRun(runId, {
              skillsAdded,
              skillsUpdated,
              skillsUnchanged,
            })
          }
        }
      }

      onProgress?.({
        phase: 'complete',
        current: skillsToProcess.length,
        total: skillsToProcess.length,
        skillsProcessed: totalProcessed,
        skillsChanged: skillsAdded + skillsUpdated,
        message: 'Sync complete',
      })

      return {
        success: errors.length === 0,
        skillsAdded,
        skillsUpdated,
        skillsUnchanged,
        totalProcessed,
        errors,
        durationMs,
        dryRun,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message)

      // Record failure (skip for dry run)
      if (!dryRun) {
        this.syncConfigRepo.setLastSyncError(message)
        if (runId) {
          this.syncHistoryRepo.failRun(runId, message)
        }
      }

      return {
        success: false,
        skillsAdded,
        skillsUpdated,
        skillsUnchanged,
        totalProcessed,
        errors,
        durationMs: Date.now() - startTime,
        dryRun,
      }
    }
  }

  /**
   * Upsert skills into local database
   */
  private async upsertSkills(
    skills: ApiSearchResult[],
    onProgress?: (current: number) => void
  ): Promise<UpsertStats> {
    let added = 0
    let updated = 0
    let unchanged = 0

    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i]
      const existing = this.skillRepo.findById(skill.id)

      if (existing) {
        // Check if actually changed
        if (existing.updatedAt !== skill.updated_at) {
          this.skillRepo.update(skill.id, {
            name: skill.name,
            description: skill.description ?? undefined,
            author: skill.author ?? undefined,
            repoUrl: skill.repo_url ?? undefined,
            qualityScore: skill.quality_score ?? undefined,
            trustTier: skill.trust_tier,
            tags: skill.tags,
          })
          updated++
        } else {
          unchanged++
        }
      } else {
        this.skillRepo.create({
          id: skill.id,
          name: skill.name,
          description: skill.description ?? undefined,
          author: skill.author ?? undefined,
          repoUrl: skill.repo_url ?? undefined,
          qualityScore: skill.quality_score ?? undefined,
          trustTier: skill.trust_tier,
          tags: skill.tags,
        })
        added++
      }

      onProgress?.(i + 1)
    }

    return { added, updated, unchanged }
  }

  /**
   * Get sync status summary
   */
  getStatus(): {
    config: ReturnType<SyncConfigRepository['getConfig']>
    lastRun: ReturnType<SyncHistoryRepository['getLastSuccessful']>
    isRunning: boolean
    isDue: boolean
  } {
    return {
      config: this.syncConfigRepo.getConfig(),
      lastRun: this.syncHistoryRepo.getLastSuccessful(),
      isRunning: this.syncHistoryRepo.isRunning(),
      isDue: this.syncConfigRepo.isSyncDue(),
    }
  }
}
