/**
 * SyncHistoryRepository Tests
 *
 * Tests for sync history tracking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../../src/db/schema.js'
import { SyncHistoryRepository } from '../../src/repositories/SyncHistoryRepository.js'
import type { DatabaseType } from '../../src/db/schema.js'

describe('SyncHistoryRepository', () => {
  let db: DatabaseType
  let repo: SyncHistoryRepository

  beforeEach(() => {
    db = createDatabase(':memory:')
    repo = new SyncHistoryRepository(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('startRun', () => {
    it('should create a new run with running status', () => {
      const runId = repo.startRun()

      expect(runId).toMatch(/^sync-\d{14}-[a-z0-9]+$/)

      const entry = repo.getById(runId)
      expect(entry).not.toBeNull()
      expect(entry!.status).toBe('running')
      expect(entry!.startedAt).toBeTruthy()
      expect(entry!.completedAt).toBeNull()
    })

    it('should generate unique IDs', () => {
      const id1 = repo.startRun()
      const id2 = repo.startRun()

      expect(id1).not.toBe(id2)
    })
  })

  describe('completeRun', () => {
    it('should mark run as success with results', () => {
      const runId = repo.startRun()

      repo.completeRun(runId, {
        skillsAdded: 10,
        skillsUpdated: 5,
        skillsUnchanged: 100,
      })

      const entry = repo.getById(runId)
      expect(entry!.status).toBe('success')
      expect(entry!.skillsAdded).toBe(10)
      expect(entry!.skillsUpdated).toBe(5)
      expect(entry!.skillsUnchanged).toBe(100)
      expect(entry!.completedAt).toBeTruthy()
      expect(entry!.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should throw if run not found', () => {
      expect(() => {
        repo.completeRun('nonexistent-id', {
          skillsAdded: 0,
          skillsUpdated: 0,
          skillsUnchanged: 0,
        })
      }).toThrow('Sync run not found')
    })
  })

  describe('completeRunPartial', () => {
    it('should mark run as partial with error message', () => {
      const runId = repo.startRun()

      repo.completeRunPartial(
        runId,
        { skillsAdded: 5, skillsUpdated: 2, skillsUnchanged: 50 },
        'Some skills failed to sync'
      )

      const entry = repo.getById(runId)
      expect(entry!.status).toBe('partial')
      expect(entry!.errorMessage).toBe('Some skills failed to sync')
      expect(entry!.skillsAdded).toBe(5)
    })
  })

  describe('failRun', () => {
    it('should mark run as failed with error', () => {
      const runId = repo.startRun()

      repo.failRun(runId, 'Connection timeout')

      const entry = repo.getById(runId)
      expect(entry!.status).toBe('failed')
      expect(entry!.errorMessage).toBe('Connection timeout')
      expect(entry!.completedAt).toBeTruthy()
    })

    it('should throw if run not found', () => {
      expect(() => {
        repo.failRun('nonexistent-id', 'error')
      }).toThrow('Sync run not found')
    })
  })

  describe('getById', () => {
    it('should return entry by ID', () => {
      const runId = repo.startRun()
      const entry = repo.getById(runId)

      expect(entry).not.toBeNull()
      expect(entry!.id).toBe(runId)
    })

    it('should return null for nonexistent ID', () => {
      const entry = repo.getById('nonexistent')
      expect(entry).toBeNull()
    })
  })

  describe('getHistory', () => {
    it('should return empty array if no history', () => {
      const history = repo.getHistory()
      expect(history).toEqual([])
    })

    it('should return entries in reverse chronological order', () => {
      // Create first run with older timestamp
      const id1 = repo.startRun()
      repo.completeRun(id1, { skillsAdded: 1, skillsUpdated: 0, skillsUnchanged: 0 })

      // Manually adjust timestamp to ensure ordering
      const oneSecondAgo = new Date(Date.now() - 1000).toISOString()
      db.prepare('UPDATE sync_history SET started_at = ? WHERE id = ?').run(oneSecondAgo, id1)

      const id2 = repo.startRun()
      repo.completeRun(id2, { skillsAdded: 2, skillsUpdated: 0, skillsUnchanged: 0 })

      const history = repo.getHistory()
      expect(history.length).toBe(2)
      expect(history[0].skillsAdded).toBe(2) // Most recent first
      expect(history[1].skillsAdded).toBe(1)
    })

    it('should respect limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        const id = repo.startRun()
        repo.completeRun(id, { skillsAdded: i, skillsUpdated: 0, skillsUnchanged: 0 })
      }

      const history = repo.getHistory(3)
      expect(history.length).toBe(3)
    })
  })

  describe('getLastSuccessful', () => {
    it('should return null if no successful runs', () => {
      const id = repo.startRun()
      repo.failRun(id, 'error')

      expect(repo.getLastSuccessful()).toBeNull()
    })

    it('should return last successful run', () => {
      const id1 = repo.startRun()
      repo.completeRun(id1, { skillsAdded: 10, skillsUpdated: 0, skillsUnchanged: 0 })

      const id2 = repo.startRun()
      repo.failRun(id2, 'error')

      const last = repo.getLastSuccessful()
      expect(last).not.toBeNull()
      expect(last!.id).toBe(id1)
      expect(last!.skillsAdded).toBe(10)
    })
  })

  describe('getRunning', () => {
    it('should return empty array if no running', () => {
      expect(repo.getRunning()).toEqual([])
    })

    it('should return running entries', () => {
      const id1 = repo.startRun()
      const id2 = repo.startRun()
      repo.completeRun(id2, { skillsAdded: 0, skillsUpdated: 0, skillsUnchanged: 0 })

      const running = repo.getRunning()
      expect(running.length).toBe(1)
      expect(running[0].id).toBe(id1)
    })
  })

  describe('isRunning', () => {
    it('should return false if no running syncs', () => {
      expect(repo.isRunning()).toBe(false)
    })

    it('should return true if sync is running', () => {
      repo.startRun()
      expect(repo.isRunning()).toBe(true)
    })
  })

  describe('cleanup', () => {
    it('should remove old entries', () => {
      // Create an entry and manually set old date
      const id = repo.startRun()
      repo.completeRun(id, { skillsAdded: 0, skillsUpdated: 0, skillsUnchanged: 0 })

      // Update started_at to 60 days ago
      const sixtyDaysAgo = new Date()
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)
      db.prepare('UPDATE sync_history SET started_at = ? WHERE id = ?').run(
        sixtyDaysAgo.toISOString(),
        id
      )

      const deleted = repo.cleanup(30)
      expect(deleted).toBe(1)
      expect(repo.getById(id)).toBeNull()
    })
  })

  describe('count', () => {
    it('should return 0 for empty history', () => {
      expect(repo.count()).toBe(0)
    })

    it('should return correct count', () => {
      repo.startRun()
      repo.startRun()
      repo.startRun()

      expect(repo.count()).toBe(3)
    })
  })

  describe('getStats', () => {
    it('should return zeros for empty history', () => {
      const stats = repo.getStats()

      expect(stats.totalRuns).toBe(0)
      // SQLite SUM returns null for empty sets, which is handled by the implementation
      expect(stats.successfulRuns).toBe(0)
      expect(stats.failedRuns).toBe(0)
      expect(stats.lastSuccessAt).toBeNull()
      expect(stats.averageDurationMs).toBeNull()
    })

    it('should calculate stats correctly', () => {
      // Success
      const id1 = repo.startRun()
      repo.completeRun(id1, { skillsAdded: 10, skillsUpdated: 5, skillsUnchanged: 100 })

      // Success
      const id2 = repo.startRun()
      repo.completeRun(id2, { skillsAdded: 5, skillsUpdated: 2, skillsUnchanged: 50 })

      // Failed
      const id3 = repo.startRun()
      repo.failRun(id3, 'error')

      const stats = repo.getStats()

      expect(stats.totalRuns).toBe(3)
      expect(stats.successfulRuns).toBe(2)
      expect(stats.failedRuns).toBe(1)
      expect(stats.lastSuccessAt).toBeTruthy()
      // averageDurationMs may be 0 or a small positive number
      expect(stats.averageDurationMs === null || stats.averageDurationMs >= 0).toBe(true)
    })
  })
})
