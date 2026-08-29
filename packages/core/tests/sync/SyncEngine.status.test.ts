/**
 * SyncEngine Tests — history tracking + getStatus
 *
 * Split from SyncEngine.test.ts (pre-existing at 508 lines, over the
 * 500-LOC file-size gate, before any SMI-5649 changes) to bring both files
 * under the limit. Reuses that file's mock factories (createMockSkill,
 * createMockApiClient, createMockSkillVersionRepo — exported there).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../../src/db/schema.js'
import { SyncConfigRepository } from '../../src/repositories/SyncConfigRepository.js'
import { SyncHistoryRepository } from '../../src/repositories/SyncHistoryRepository.js'
import { SkillRepository } from '../../src/repositories/SkillRepository.js'
import { SyncEngine } from '../../src/sync/SyncEngine.js'
import type { DatabaseType } from '../../src/db/schema.js'
import {
  createMockSkillVersionRepo,
  createMockSkill,
  createMockApiClient,
} from './SyncEngine.test.js'

describe('SyncEngine - history tracking + getStatus', () => {
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
        throwOnFetch: new Error('Network failure'),
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
