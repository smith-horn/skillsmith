/**
 * SyncEngine Tests
 *
 * Tests for the core sync engine with mocked dependencies.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../../src/db/schema.js'
import { SyncConfigRepository } from '../../src/repositories/SyncConfigRepository.js'
import { SyncHistoryRepository } from '../../src/repositories/SyncHistoryRepository.js'
import { SkillRepository } from '../../src/repositories/SkillRepository.js'
import { SyncEngine } from '../../src/sync/SyncEngine.js'
import type { SkillVersionRepository } from '../../src/repositories/SkillVersionRepository.js'
import type { DatabaseType } from '../../src/db/schema.js'
import type { SkillsmithApiClient, ApiSearchResult } from '../../src/api/client.js'

/** Shape of the args `SyncEngine` passes to `apiClient.syncRegistry()`. */
type SyncRegistryCallArgs = { limit?: number; offset?: number; since?: string }

/**
 * Create a mock SkillVersionRepository for testing.
 * All methods return resolved promises so SyncEngine can call recordVersion
 * after each upsert without errors.
 */
export function createMockSkillVersionRepo(): SkillVersionRepository {
  return {
    recordVersion: vi.fn().mockResolvedValue(undefined),
    pruneVersions: vi.fn().mockResolvedValue(undefined),
    getLatestVersion: vi.fn().mockResolvedValue(null),
    getVersionHistory: vi.fn().mockResolvedValue([]),
    getVersionByHash: vi.fn().mockResolvedValue(null),
  } as unknown as SkillVersionRepository
}

/**
 * Create a mock skill for testing
 * Note: quality_score must be between 0 and 1 (database constraint)
 */
export function createMockSkill(
  id: string,
  updatedAt: string = new Date().toISOString()
): ApiSearchResult {
  return {
    id,
    name: `Skill ${id}`,
    description: `Description for ${id}`,
    author: 'test-author',
    repo_url: `https://github.com/test/${id}`,
    quality_score: 0.85, // Must be 0-1 range (database constraint)
    trust_tier: 'community',
    tags: ['test'],
    stars: 50,
    installable: true,
    created_at: updatedAt,
    updated_at: updatedAt,
  }
}

/**
 * Create a mock API client with customizable behavior.
 *
 * SyncEngine fetches via `syncRegistry()` (the Team/Enterprise bulk
 * registry-enumeration endpoint, SMI-6197) rather than the old 8-broad-query
 * abuse of `search()` — this mock paginates the same `skills` fixture array
 * against `syncRegistry`'s `{ limit, offset, since }` signature. It does NOT
 * filter by `since` itself (SyncEngine's own client-side
 * `updated_at > lastSyncAt` filter is what's under test in the differential
 * sync tests below) — `since` forwarding is asserted separately via the mock's
 * call arguments.
 */
export function createMockApiClient(
  config: {
    offline?: boolean
    healthStatus?: 'healthy' | 'degraded' | 'unhealthy'
    skills?: ApiSearchResult[]
    throwOnFetch?: Error
  } = {}
): SkillsmithApiClient {
  const { offline = false, healthStatus = 'healthy', skills = [], throwOnFetch } = config

  const syncRegistryMock = vi
    .fn()
    .mockImplementation(async ({ limit = 100, offset = 0, since }: SyncRegistryCallArgs = {}) => {
      if (throwOnFetch) {
        throw throwOnFetch
      }
      const pageSkills = skills.slice(offset, offset + limit)
      return {
        data: pageSkills,
        meta: { limit, offset, since: since ?? null },
      }
    })

  return {
    isOffline: vi.fn().mockReturnValue(offline),
    checkHealth: vi.fn().mockResolvedValue({ status: healthStatus }),
    search: vi.fn(),
    syncRegistry: syncRegistryMock,
    getSkill: vi.fn(),
    getHealthStatus: vi.fn(),
  } as unknown as SkillsmithApiClient
}

describe('SyncEngine', () => {
  let db: DatabaseType
  let syncConfigRepo: SyncConfigRepository
  let syncHistoryRepo: SyncHistoryRepository
  let skillRepo: SkillRepository

  beforeEach(() => {
    db = createDatabase(':memory:')
    syncConfigRepo = new SyncConfigRepository(db)
    syncHistoryRepo = new SyncHistoryRepository(db)
    skillRepo = new SkillRepository(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('constructor', () => {
    it('should create sync engine with all dependencies', () => {
      const apiClient = createMockApiClient()
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )
      expect(engine).toBeDefined()
    })
  })

  describe('sync - offline and health checks', () => {
    it('should fail when API client is offline', async () => {
      const apiClient = createMockApiClient({ offline: true })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const result = await engine.sync()

      expect(result.success).toBe(false)
      expect(result.errors).toContain('API client is in offline mode. Cannot sync.')
    })

    it('should fail when API health check fails', async () => {
      const apiClient = createMockApiClient({ healthStatus: 'unhealthy' })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const result = await engine.sync()

      expect(result.success).toBe(false)
      expect(result.errors).toContain('API is unhealthy. Try again later.')
    })
  })

  describe('sync - basic functionality', () => {
    it('should successfully sync skills from API', async () => {
      const skills = [
        createMockSkill('test/skill-1'),
        createMockSkill('test/skill-2'),
        createMockSkill('test/skill-3'),
      ]
      const apiClient = createMockApiClient({ skills })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      expect(result.skillsAdded).toBe(3)
      expect(result.skillsUpdated).toBe(0)
      expect(result.skillsUnchanged).toBe(0)
      expect(result.totalProcessed).toBe(3)
      expect(result.errors).toHaveLength(0)
    })

    it('should detect updates to existing skills', async () => {
      // Pre-populate database with a skill
      skillRepo.create({
        id: 'test/skill-1',
        name: 'Old Name',
        trustTier: 'community',
        tags: ['old'],
      })

      // API returns updated version with new updated_at
      const skills = [createMockSkill('test/skill-1', new Date(Date.now() + 1000).toISOString())]
      const apiClient = createMockApiClient({ skills })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      expect(result.skillsAdded).toBe(0)
      expect(result.skillsUpdated).toBe(1)
    })

    it('should skip unchanged skills when timestamps match', async () => {
      const timestamp = new Date().toISOString()

      // Pre-populate database with a skill
      skillRepo.create({
        id: 'test/skill-1',
        name: 'Skill test/skill-1',
        trustTier: 'community',
        tags: ['test'],
      })

      // Manually set the same timestamp as what API will return
      db.prepare('UPDATE skills SET updated_at = ? WHERE id = ?').run(timestamp, 'test/skill-1')

      // API returns skill with same timestamp
      const skills = [createMockSkill('test/skill-1', timestamp)]
      const apiClient = createMockApiClient({ skills })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      expect(result.skillsUnchanged).toBe(1)
      expect(result.skillsUpdated).toBe(0)
      expect(result.skillsAdded).toBe(0)
    })
  })

  describe('sync - differential sync', () => {
    it('should perform differential sync when lastSyncAt exists', async () => {
      // Set last sync to 1 hour ago
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      syncConfigRepo.setLastSync(oneHourAgo.toISOString(), 0)

      // Create skills: one old (before lastSync), one new (after lastSync)
      const oldSkill = createMockSkill(
        'test/old-skill',
        new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      )
      const newSkill = createMockSkill('test/new-skill', new Date().toISOString())

      const apiClient = createMockApiClient({ skills: [oldSkill, newSkill] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      // Only the new skill should be added (old one filtered out by differential)
      expect(result.skillsAdded).toBe(1)
      expect(result.totalProcessed).toBe(2) // Both fetched
    })

    it('should perform full sync with force option', async () => {
      // Set last sync recently
      const now = new Date().toISOString()
      syncConfigRepo.setLastSync(now, 0)

      // Create skills with old timestamps that would normally be filtered
      const skills = [
        createMockSkill('test/skill-1', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
        createMockSkill('test/skill-2', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
      ]
      const apiClient = createMockApiClient({ skills })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const result = await engine.sync({ force: true })

      expect(result.success).toBe(true)
      expect(result.skillsAdded).toBe(2) // All skills processed because force=true
    })
  })

  describe('sync - dry run', () => {
    it('should not modify database in dry run mode', async () => {
      const skills = [createMockSkill('test/skill-1')]
      const apiClient = createMockApiClient({ skills })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const result = await engine.sync({ dryRun: true })

      expect(result.success).toBe(true)
      expect(result.dryRun).toBe(true)
      expect(result.skillsAdded).toBe(1)

      // Verify skill was NOT actually added
      const skill = skillRepo.findById('test/skill-1')
      expect(skill).toBeNull()

      // Verify no history entry was created
      const history = syncHistoryRepo.getHistory()
      expect(history).toHaveLength(0)
    })
  })

  describe('sync - progress callback', () => {
    it('should call onProgress callback with phases', async () => {
      const skills = [createMockSkill('test/skill-1')]
      const apiClient = createMockApiClient({ skills })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const progressCalls: string[] = []
      const onProgress = vi.fn((progress) => {
        progressCalls.push(progress.phase)
      })

      await engine.sync({ onProgress })

      expect(onProgress).toHaveBeenCalled()
      expect(progressCalls).toContain('connecting')
      expect(progressCalls).toContain('fetching')
      expect(progressCalls).toContain('comparing')
      // upserting and complete should be called for successful sync with skills
      expect(progressCalls.some((p) => p === 'upserting' || p === 'complete')).toBe(true)
    })
  })

  describe('sync - pagination', () => {
    it('should handle pagination correctly', async () => {
      // Create 150 skills (more than one page of 100)
      const skills = Array.from({ length: 150 }, (_, i) => createMockSkill(`test/skill-${i}`))
      const apiClient = createMockApiClient({ skills })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const result = await engine.sync({ pageSize: 100 })

      expect(result.success).toBe(true)
      expect(result.skillsAdded).toBe(150)
      expect(result.totalProcessed).toBe(150)
      // SyncEngine now scans registry-sync's single id-ordered enumeration:
      // 2 pages (100 + 50) instead of the old 8-query × 2-page = 16 calls.
      expect(apiClient.syncRegistry as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2)
    })
  })

  describe('sync - since forwarding', () => {
    it('omits `since` when force=true, even with a lastSyncAt on record', async () => {
      const lastSyncAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      syncConfigRepo.setLastSync(lastSyncAt, 0)

      const apiClient = createMockApiClient({ skills: [createMockSkill('test/skill-1')] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      await engine.sync({ force: true })

      const syncRegistryMock = apiClient.syncRegistry as ReturnType<typeof vi.fn>
      expect(syncRegistryMock).toHaveBeenCalledWith(expect.objectContaining({ since: undefined }))
    })

    it('forwards lastSyncAt as `since` on a non-forced sync', async () => {
      const lastSyncAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      syncConfigRepo.setLastSync(lastSyncAt, 0)

      const apiClient = createMockApiClient({ skills: [createMockSkill('test/skill-1')] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      await engine.sync()

      const syncRegistryMock = apiClient.syncRegistry as ReturnType<typeof vi.fn>
      expect(syncRegistryMock).toHaveBeenCalledWith(expect.objectContaining({ since: lastSyncAt }))
    })

    it('omits `since` on a non-forced sync with no lastSyncAt on record', async () => {
      const apiClient = createMockApiClient({ skills: [createMockSkill('test/skill-1')] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      await engine.sync()

      const syncRegistryMock = apiClient.syncRegistry as ReturnType<typeof vi.fn>
      expect(syncRegistryMock).toHaveBeenCalledWith(expect.objectContaining({ since: undefined }))
    })
  })

  // ===========================================================================
  // SMI-6343 Wave 2: real content_hash recording (never a metadata proxy)
  // ===========================================================================
  describe('recordVersion — real content hash, never a metadata proxy', () => {
    it('records the registry real content_hash on create, not a metadata proxy', async () => {
      const skillVersionRepo = createMockSkillVersionRepo()
      const skill: ApiSearchResult = {
        ...createMockSkill('test/hash-on-create'),
        content_hash: 'realsha256contenthash1',
      }
      const apiClient = createMockApiClient({ skills: [skill] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        skillVersionRepo
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      expect(skillVersionRepo.recordVersion).toHaveBeenCalledWith(
        'test/hash-on-create',
        'realsha256contenthash1'
      )
    })

    it('records the registry real content_hash on update, not a metadata proxy', async () => {
      skillRepo.create({
        id: 'test/hash-on-update',
        name: 'Old Name',
        trustTier: 'community',
        tags: ['old'],
      })

      const skillVersionRepo = createMockSkillVersionRepo()
      const skill: ApiSearchResult = {
        ...createMockSkill('test/hash-on-update', new Date(Date.now() + 1000).toISOString()),
        content_hash: 'realsha256contenthash2',
      }
      const apiClient = createMockApiClient({ skills: [skill] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        skillVersionRepo
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      expect(result.skillsUpdated).toBe(1)
      expect(skillVersionRepo.recordVersion).toHaveBeenCalledWith(
        'test/hash-on-update',
        'realsha256contenthash2'
      )
    })

    it('skips recordVersion entirely when the registry provides no content_hash (create path)', async () => {
      const skillVersionRepo = createMockSkillVersionRepo()
      // createMockSkill() does not set content_hash.
      const apiClient = createMockApiClient({ skills: [createMockSkill('test/no-hash-create')] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        skillVersionRepo
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      expect(result.skillsAdded).toBe(1)
      expect(skillVersionRepo.recordVersion).not.toHaveBeenCalled()
    })

    it('skips recordVersion entirely when the registry provides no content_hash (update path)', async () => {
      skillRepo.create({
        id: 'test/no-hash-update',
        name: 'Old Name',
        trustTier: 'community',
        tags: ['old'],
      })

      const skillVersionRepo = createMockSkillVersionRepo()
      const skill = createMockSkill(
        'test/no-hash-update',
        new Date(Date.now() + 1000).toISOString()
      )
      const apiClient = createMockApiClient({ skills: [skill] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        skillVersionRepo
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      expect(result.skillsUpdated).toBe(1)
      expect(skillVersionRepo.recordVersion).not.toHaveBeenCalled()
    })

    it('records the registry content_hash for an UNCHANGED skill (adversarial-review regression)', async () => {
      // The bug this guards: recordVersion() originally lived only inside
      // the branch where existing.updatedAt !== skill.updated_at, so a
      // skill whose metadata hasn't changed since last sync would never
      // regain a skill_versions row after migration v18's purge —
      // contradicting the migration's own "fully rebuilds on the next
      // registry sync" claim for the common case where most of the catalog
      // doesn't change every sync.
      const timestamp = new Date().toISOString()
      skillRepo.create({
        id: 'test/unchanged-hash',
        name: 'Skill test/unchanged-hash',
        trustTier: 'community',
        tags: ['test'],
      })
      db.prepare('UPDATE skills SET updated_at = ? WHERE id = ?').run(
        timestamp,
        'test/unchanged-hash'
      )

      const skillVersionRepo = createMockSkillVersionRepo()
      const skill: ApiSearchResult = {
        ...createMockSkill('test/unchanged-hash', timestamp),
        content_hash: 'realsha256contenthash-unchanged',
      }
      const apiClient = createMockApiClient({ skills: [skill] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        skillVersionRepo
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      expect(result.skillsUnchanged).toBe(1)
      expect(result.skillsUpdated).toBe(0)
      expect(skillVersionRepo.recordVersion).toHaveBeenCalledWith(
        'test/unchanged-hash',
        'realsha256contenthash-unchanged'
      )
    })

    it('does not record a version for a locally-imported skill even when unchanged', async () => {
      // SMI-4665's local-import skip must still be honored — the fix above
      // widens WHEN recordVersion runs, but must not reach past the
      // pre-existing `existing.source === 'local'` early-continue.
      const timestamp = new Date().toISOString()
      skillRepo.create({
        id: 'test/local-unchanged',
        name: 'Local Skill',
        trustTier: 'community',
        tags: ['test'],
        source: 'local',
      })
      db.prepare('UPDATE skills SET updated_at = ? WHERE id = ?').run(
        timestamp,
        'test/local-unchanged'
      )

      const skillVersionRepo = createMockSkillVersionRepo()
      const skill: ApiSearchResult = {
        ...createMockSkill('test/local-unchanged', timestamp),
        content_hash: 'realsha256contenthash-local',
      }
      const apiClient = createMockApiClient({ skills: [skill] })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        skillVersionRepo
      )

      const result = await engine.sync()

      expect(result.success).toBe(true)
      expect(skillVersionRepo.recordVersion).not.toHaveBeenCalled()
    })
  })
})
