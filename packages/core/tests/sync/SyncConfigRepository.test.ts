/**
 * SyncConfigRepository Tests
 *
 * Tests for sync configuration management.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../../src/db/schema.js'
import {
  SyncConfigRepository,
  FREQUENCY_INTERVALS,
} from '../../src/repositories/SyncConfigRepository.js'
import type { DatabaseType } from '../../src/db/schema.js'

describe('SyncConfigRepository', () => {
  let db: DatabaseType
  let repo: SyncConfigRepository

  beforeEach(() => {
    db = createDatabase(':memory:')
    repo = new SyncConfigRepository(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('getConfig', () => {
    it('should return default config on fresh database', () => {
      const config = repo.getConfig()

      expect(config.id).toBe('default')
      expect(config.enabled).toBe(true)
      expect(config.frequency).toBe('daily')
      expect(config.intervalMs).toBe(FREQUENCY_INTERVALS.daily)
      expect(config.lastSyncAt).toBeNull()
      expect(config.nextSyncAt).toBeNull()
      expect(config.lastSyncCount).toBe(0)
      expect(config.lastSyncError).toBeNull()
    })

    it('should return updated config after changes', () => {
      repo.disable()
      const config = repo.getConfig()

      expect(config.enabled).toBe(false)
    })
  })

  describe('updateConfig', () => {
    it('should update enabled status', () => {
      repo.updateConfig({ enabled: false })
      expect(repo.getConfig().enabled).toBe(false)

      repo.updateConfig({ enabled: true })
      expect(repo.getConfig().enabled).toBe(true)
    })

    it('should update frequency and recalculate interval', () => {
      repo.updateConfig({ frequency: 'weekly' })
      const config = repo.getConfig()

      expect(config.frequency).toBe('weekly')
      expect(config.intervalMs).toBe(FREQUENCY_INTERVALS.weekly)
    })

    it('should recalculate nextSyncAt when frequency changes and lastSyncAt exists', () => {
      const lastSync = new Date().toISOString()
      repo.setLastSync(lastSync, 10)

      repo.updateConfig({ frequency: 'weekly' })
      const config = repo.getConfig()

      expect(config.nextSyncAt).not.toBeNull()
      const expectedNext = new Date(new Date(lastSync).getTime() + FREQUENCY_INTERVALS.weekly)
      expect(new Date(config.nextSyncAt!).getTime()).toBe(expectedNext.getTime())
    })
  })

  describe('enable/disable', () => {
    it('should enable auto-sync', () => {
      repo.disable()
      expect(repo.getConfig().enabled).toBe(false)

      repo.enable()
      expect(repo.getConfig().enabled).toBe(true)
    })

    it('should disable auto-sync', () => {
      expect(repo.getConfig().enabled).toBe(true)

      repo.disable()
      expect(repo.getConfig().enabled).toBe(false)
    })
  })

  describe('setFrequency', () => {
    it('should set frequency to daily', () => {
      repo.setFrequency('weekly')
      repo.setFrequency('daily')

      const config = repo.getConfig()
      expect(config.frequency).toBe('daily')
      expect(config.intervalMs).toBe(FREQUENCY_INTERVALS.daily)
    })

    it('should set frequency to weekly', () => {
      repo.setFrequency('weekly')

      const config = repo.getConfig()
      expect(config.frequency).toBe('weekly')
      expect(config.intervalMs).toBe(FREQUENCY_INTERVALS.weekly)
    })
  })

  describe('setLastSync', () => {
    it('should update lastSyncAt and lastSyncCount', () => {
      const timestamp = new Date().toISOString()
      repo.setLastSync(timestamp, 42)

      const config = repo.getConfig()
      expect(config.lastSyncAt).toBe(timestamp)
      expect(config.lastSyncCount).toBe(42)
      expect(config.lastSyncError).toBeNull()
    })

    it('should calculate nextSyncAt based on interval', () => {
      const timestamp = new Date().toISOString()
      repo.setLastSync(timestamp, 10)

      const config = repo.getConfig()
      expect(config.nextSyncAt).not.toBeNull()

      const expectedNext = new Date(new Date(timestamp).getTime() + FREQUENCY_INTERVALS.daily)
      expect(new Date(config.nextSyncAt!).getTime()).toBe(expectedNext.getTime())
    })

    it('should clear lastSyncError on successful sync', () => {
      repo.setLastSyncError('Previous error')
      expect(repo.getConfig().lastSyncError).toBe('Previous error')

      repo.setLastSync(new Date().toISOString(), 5)
      expect(repo.getConfig().lastSyncError).toBeNull()
    })
  })

  describe('setLastSyncError', () => {
    it('should store error message', () => {
      repo.setLastSyncError('Connection failed')

      expect(repo.getConfig().lastSyncError).toBe('Connection failed')
    })
  })

  describe('clearError', () => {
    it('should clear stored error', () => {
      repo.setLastSyncError('Some error')
      expect(repo.getConfig().lastSyncError).toBe('Some error')

      repo.clearError()
      expect(repo.getConfig().lastSyncError).toBeNull()
    })
  })

  describe('isSyncDue', () => {
    it('should return true if never synced', () => {
      expect(repo.isSyncDue()).toBe(true)
    })

    it('should return true if nextSyncAt has passed', () => {
      // Set last sync to 2 days ago
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
      repo.setLastSync(twoDaysAgo, 10)

      // With daily frequency, sync should be due
      expect(repo.isSyncDue()).toBe(true)
    })

    it('should return false if nextSyncAt is in the future', () => {
      // Set last sync to now
      const now = new Date().toISOString()
      repo.setLastSync(now, 10)

      // With daily frequency, next sync is 24 hours away
      expect(repo.isSyncDue()).toBe(false)
    })
  })

  describe('calculateNextSync', () => {
    it('should add interval to last sync time', () => {
      const lastSync = '2026-01-15T12:00:00.000Z'
      const nextSync = repo.calculateNextSync(lastSync, FREQUENCY_INTERVALS.daily)

      const expected = new Date(new Date(lastSync).getTime() + FREQUENCY_INTERVALS.daily)
      expect(nextSync).toBe(expected.toISOString())
    })
  })
})
