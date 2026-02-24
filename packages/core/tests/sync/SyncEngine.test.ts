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

/**
 * Create a mock SkillVersionRepository for testing.
 * All methods return resolved promises so SyncEngine can call recordVersion
 * after each upsert without errors.
 */
function createMockSkillVersionRepo(): SkillVersionRepository {
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
function createMockSkill(
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
 * Create a mock API client with customizable behavior
 */
function createMockApiClient(
  config: {
    offline?: boolean
    healthStatus?: 'healthy' | 'degraded' | 'unhealthy'
    skills?: ApiSearchResult[]
    throwOnSearch?: Error
  } = {}
): SkillsmithApiClient {
  const { offline = false, healthStatus = 'healthy', skills = [], throwOnSearch } = config

  const searchMock = vi.fn().mockImplementation(async ({ limit = 100, offset = 0 }) => {
    if (throwOnSearch) {
      throw throwOnSearch
    }
    const pageSkills = skills.slice(offset, offset + limit)
    return {
      data: pageSkills,
      total: skills.length,
      limit,
      offset,
    }
  })

  return {
    isOffline: vi.fn().mockReturnValue(offline),
    checkHealth: vi.fn().mockResolvedValue({ status: healthStatus }),
    search: searchMock,
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
      // SyncEngine uses 8 different search queries to cover more skills
      // Each query paginates through results: 8 queries × 2 pages (100 + 50) = 16 calls
      // Skills are deduplicated across queries
      expect(apiClient.search as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(16)
    })
  })

  describe('sync - history tracking', () => {
    it('should record sync history on success', async () => {
      const skills = [createMockSkill('test/skill-1')]
      const apiClient = createMockApiClient({ skills })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      await engine.sync()

      const history = syncHistoryRepo.getHistory()
      expect(history).toHaveLength(1)
      expect(history[0].status).toBe('success')
      expect(history[0].skillsAdded).toBe(1)
    })

    it('should record sync history on failure', async () => {
      const apiClient = createMockApiClient({
        throwOnSearch: new Error('Network failure'),
      })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      await engine.sync()

      const history = syncHistoryRepo.getHistory()
      expect(history).toHaveLength(1)
      expect(history[0].status).toBe('failed')
      expect(history[0].errorMessage).toContain('Network failure')
    })

    it('should update sync config on success', async () => {
      const skills = [createMockSkill('test/skill-1')]
      const apiClient = createMockApiClient({ skills })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      await engine.sync()

      const config = syncConfigRepo.getConfig()
      expect(config.lastSyncAt).not.toBeNull()
      expect(config.lastSyncCount).toBe(1)
      expect(config.lastSyncError).toBeNull()
    })

    it('should set error in config on failure', async () => {
      const apiClient = createMockApiClient({ offline: true })
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      await engine.sync()

      const config = syncConfigRepo.getConfig()
      expect(config.lastSyncError).toBe('API client is in offline mode. Cannot sync.')
    })
  })

  describe('getStatus', () => {
    it('should return sync status summary', () => {
      const apiClient = createMockApiClient()
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const status = engine.getStatus()

      expect(status).toHaveProperty('config')
      expect(status).toHaveProperty('lastRun')
      expect(status).toHaveProperty('isRunning')
      expect(status).toHaveProperty('isDue')
    })

    it('should show sync is due when never synced', () => {
      const apiClient = createMockApiClient()
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      const status = engine.getStatus()

      expect(status.isDue).toBe(true)
      expect(status.lastRun).toBeNull()
    })

    it('should reflect running state', async () => {
      const apiClient = createMockApiClient()
      const engine = new SyncEngine(
        apiClient,
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        createMockSkillVersionRepo()
      )

      // Start a run manually
      syncHistoryRepo.startRun()

      const status = engine.getStatus()
      expect(status.isRunning).toBe(true)
    })
  })
})
