/**
 * SyncEngine - Core sync logic for registry synchronization
 *
 * Implements differential sync by comparing local database state with
 * the live Skillsmith registry API. Fetches only changed skills based
 * on updated_at timestamps.
 */

import { createHash } from 'crypto'
import type { SkillsmithApiClient, ApiSearchResult } from '../api/client.js'
import type { SkillRepository } from '../repositories/SkillRepository.js'
import type { SyncConfigRepository } from '../repositories/SyncConfigRepository.js'
import type { SyncHistoryRepository } from '../repositories/SyncHistoryRepository.js'
import type { SkillVersionRepository } from '../repositories/SkillVersionRepository.js'
import type { AdvisoryRepository } from '../repositories/AdvisoryRepository.js'

/**
 * Hash a content string using SHA-256 and return the hex digest.
 *
 * NOTE: Duplicated from packages/mcp-server/src/tools/install.conflict-helpers.ts
 * to avoid a circular dependency (core → mcp-server). Implementation is identical.
 * If the hashing algorithm is ever changed it must be updated in both locations.
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

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
  /**
   * Abort signal (SMI-5649). Checked at loop and pre-write boundaries so a
   * shutdown quiesce can stop an in-flight sync before it writes against a
   * db that is about to be closed. Every driver write is synchronous, so
   * once the signal is aborted, no new write ever begins — this is what
   * makes it safe for the coordinator to proceed to `db.close()` once its
   * bounded quiesce timeout elapses, even if this method hasn't returned yet.
   */
  signal?: AbortSignal
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
  private skillVersionRepo: SkillVersionRepository
  private advisoryRepo: AdvisoryRepository | null

  constructor(
    apiClient: SkillsmithApiClient,
    skillRepo: SkillRepository,
    syncConfigRepo: SyncConfigRepository,
    syncHistoryRepo: SyncHistoryRepository,
    skillVersionRepo: SkillVersionRepository,
    advisoryRepo?: AdvisoryRepository | null
  ) {
    this.apiClient = apiClient
    this.skillRepo = skillRepo
    this.syncConfigRepo = syncConfigRepo
    this.syncHistoryRepo = syncHistoryRepo
    this.skillVersionRepo = skillVersionRepo
    this.advisoryRepo = advisoryRepo ?? null
  }

  /**
   * Stub: sync advisories from the registry.
   *
   * The server-side advisory endpoint does not exist yet. This method logs
   * a diagnostic message and returns immediately. It will be wired to the
   * actual endpoint in a future wave when the registry ships advisory data.
   */
  private syncAdvisories(): void {
    if (this.advisoryRepo) {
      // Advisory sync endpoint not yet available server-side.
      // This stub will be replaced when the endpoint ships.
      console.debug('[skillsmith] Advisory sync: no endpoint configured yet')
    }
  }

  /**
   * Run sync operation
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const { force = false, dryRun = false, pageSize = 100, onProgress, signal } = options

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

      // Fetch all skills from the registry-sync endpoint (Team/Enterprise
      // bulk enumeration, SMI-6197) with pagination. This replaces the old
      // mechanism that abused the public search endpoint with 8 hardcoded
      // broad queries deduplicated by skill id — registry-sync is a plain
      // id-ordered scan of the whole table, so every row is visited exactly
      // once by construction and no cross-page dedup bookkeeping is needed.
      //
      // `since` is applied server-side: omitted entirely on a forced sync,
      // otherwise set to `lastSyncAt` when one exists. The client-side
      // `updated_at > lastSyncAt` filter below is left in place as a
      // harmless defense-in-depth double-check against server-pre-filtered
      // data (it should now typically be a no-op).
      let offset = 0
      let hasMore = true
      const allSkills: ApiSearchResult[] = []
      const since = force ? undefined : (lastSyncAt ?? undefined)

      while (hasMore) {
        // SMI-5649: stop paginating once aborted.
        if (signal?.aborted) {
          hasMore = false
          break
        }
        try {
          const response = await this.apiClient.syncRegistry({
            limit: pageSize,
            offset,
            since,
          })

          const skills = response.data
          allSkills.push(...skills)

          onProgress?.({
            phase: 'fetching',
            current: allSkills.length,
            total: 0, // Unknown total — registry-sync doesn't return a grand count
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
      // SMI-5649: if aborted before any writes began, skip the upsert
      // entirely and report as if nothing changed — never start a partial
      // write once the shutdown quiesce has signaled abort.
      if (signal?.aborted) {
        skillsUnchanged = allSkills.length
      } else if (!dryRun && skillsToProcess.length > 0) {
        const stats = await this.upsertSkills(
          skillsToProcess,
          (current) => {
            onProgress?.({
              phase: 'upserting',
              current,
              total: skillsToProcess.length,
              skillsProcessed: totalProcessed,
              skillsChanged: skillsToProcess.length,
              message: `Upserting skill ${current}/${skillsToProcess.length}...`,
            })
          },
          signal
        )

        skillsAdded = stats.added
        skillsUpdated = stats.updated
        skillsUnchanged = stats.unchanged
      } else if (dryRun) {
        // In dry run, count what would be added/updated.
        // SMI-4665: rows where `source === 'local'` are reported as unchanged
        // because the live path will skip them — keeps the dry-run summary
        // honest about what `sync --force` would actually do.
        for (const skill of skillsToProcess) {
          const existing = this.skillRepo.findById(skill.id)
          if (existing) {
            if (existing.source === 'local') {
              skillsUnchanged++
            } else {
              skillsUpdated++
            }
          } else {
            skillsAdded++
          }
        }
        skillsUnchanged += allSkills.length - skillsToProcess.length
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

      // Stub: advisory sync (no endpoint yet — logs diagnostic only)
      if (!dryRun) {
        this.syncAdvisories()
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
    onProgress?: (current: number) => void,
    signal?: AbortSignal
  ): Promise<UpsertStats> {
    let added = 0
    let updated = 0
    let unchanged = 0

    for (let i = 0; i < skills.length; i++) {
      // SMI-5649: stop before the next skill once aborted. Each
      // already-issued skillRepo.create/update + recordVersion call above
      // this point is already committed — we simply don't start another.
      if (signal?.aborted) break
      const skill = skills[i]
      const existing = this.skillRepo.findById(skill.id)

      if (existing) {
        // SMI-4665: never overwrite a row that was imported from the local
        // filesystem. The author iterates on a SKILL.md on disk; a registry
        // sync (especially `sync --force`) must not silently replace it.
        // Counts toward `unchanged` to keep the result tally honest.
        if (existing.source === 'local') {
          unchanged++
          onProgress?.(i + 1)
          continue
        }

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

          // Record version hash after successful update
          const contentProxy = JSON.stringify({
            id: skill.id,
            name: skill.name,
            description: skill.description ?? null,
            updated_at: skill.updated_at ?? null,
          })
          await this.skillVersionRepo.recordVersion(skill.id, hashContent(contentProxy))
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

        // Record version hash after successful create
        const contentProxy = JSON.stringify({
          id: skill.id,
          name: skill.name,
          description: skill.description ?? null,
          updated_at: skill.updated_at ?? null,
        })
        await this.skillVersionRepo.recordVersion(skill.id, hashContent(contentProxy))
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
