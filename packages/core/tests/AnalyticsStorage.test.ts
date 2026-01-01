/**
 * SMI-914: AnalyticsStorage Tests
 *
 * Tests for SQLite storage of skill usage events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AnalyticsStorage } from '../src/analytics/storage.js'
import type { SkillUsageEvent } from '../src/analytics/types.js'
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('AnalyticsStorage', () => {
  let storage: AnalyticsStorage
  let testDbPath: string
  let testDir: string

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = join(tmpdir(), `skillsmith-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    testDbPath = join(testDir, 'test-analytics.db')
    storage = new AnalyticsStorage(testDbPath)
  })

  afterEach(() => {
    if (storage) {
      storage.close()
    }
    // Clean up test files
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('recordEvent', () => {
    it('should record a usage event', () => {
      const event: SkillUsageEvent = {
        skillId: 'anthropic/commit',
        userId: 'abc123def456',
        timestamp: Date.now(),
        taskDuration: 1500,
        outcome: 'success',
        contextHash: 'a1b2c3d4',
      }

      storage.recordEvent(event)

      const count = storage.getEventCount()
      expect(count).toBe(1)
    })

    it('should record multiple events', () => {
      for (let i = 0; i < 5; i++) {
        storage.recordEvent({
          skillId: 'anthropic/commit',
          userId: `user${i}`,
          timestamp: Date.now() + i,
          taskDuration: 1000 + i * 100,
          outcome: i % 2 === 0 ? 'success' : 'error',
          contextHash: 'context1',
        })
      }

      const count = storage.getEventCount()
      expect(count).toBe(5)
    })

    it('should handle all outcome types', () => {
      const outcomes: Array<'success' | 'error' | 'abandoned'> = ['success', 'error', 'abandoned']

      for (const outcome of outcomes) {
        storage.recordEvent({
          skillId: 'test/skill',
          userId: 'user1',
          timestamp: Date.now(),
          taskDuration: 1000,
          outcome,
          contextHash: 'context1',
        })
      }

      const outcomeCounts = storage.getOutcomeCounts()
      expect(outcomeCounts.success).toBe(1)
      expect(outcomeCounts.error).toBe(1)
      expect(outcomeCounts.abandoned).toBe(1)
    })
  })

  describe('getEventsForSkill', () => {
    it('should return events for a specific skill', () => {
      storage.recordEvent({
        skillId: 'anthropic/commit',
        userId: 'user1',
        timestamp: Date.now(),
        taskDuration: 1000,
        outcome: 'success',
        contextHash: 'context1',
      })

      storage.recordEvent({
        skillId: 'anthropic/review',
        userId: 'user1',
        timestamp: Date.now(),
        taskDuration: 2000,
        outcome: 'success',
        contextHash: 'context1',
      })

      const events = storage.getEventsForSkill('anthropic/commit')

      expect(events).toHaveLength(1)
      expect(events[0].skillId).toBe('anthropic/commit')
    })

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        storage.recordEvent({
          skillId: 'anthropic/commit',
          userId: 'user1',
          timestamp: Date.now() + i,
          taskDuration: 1000,
          outcome: 'success',
          contextHash: 'context1',
        })
      }

      const events = storage.getEventsForSkill('anthropic/commit', 5)

      expect(events).toHaveLength(5)
    })

    it('should return events in reverse chronological order', () => {
      const baseTime = Date.now()

      for (let i = 0; i < 3; i++) {
        storage.recordEvent({
          skillId: 'anthropic/commit',
          userId: 'user1',
          timestamp: baseTime + i * 1000,
          taskDuration: 1000,
          outcome: 'success',
          contextHash: 'context1',
        })
      }

      const events = storage.getEventsForSkill('anthropic/commit')

      expect(events[0].timestamp).toBeGreaterThan(events[1].timestamp)
      expect(events[1].timestamp).toBeGreaterThan(events[2].timestamp)
    })
  })

  describe('getMetricsForSkill', () => {
    it('should return null for skill with no events', () => {
      const metrics = storage.getMetricsForSkill('nonexistent/skill')
      expect(metrics).toBeNull()
    })

    it('should calculate correct metrics', () => {
      // Record 10 events: 8 success, 2 error
      for (let i = 0; i < 10; i++) {
        storage.recordEvent({
          skillId: 'anthropic/commit',
          userId: `user${i % 3}`, // 3 unique users
          timestamp: Date.now() + i,
          taskDuration: 1000 + i * 100, // 1000, 1100, 1200, ...
          outcome: i < 8 ? 'success' : 'error',
          contextHash: 'context1',
        })
      }

      const metrics = storage.getMetricsForSkill('anthropic/commit')

      expect(metrics).not.toBeNull()
      expect(metrics!.skillId).toBe('anthropic/commit')
      expect(metrics!.totalInvocations).toBe(10)
      expect(metrics!.successRate).toBeCloseTo(0.8, 2)
      expect(metrics!.avgTaskDuration).toBeCloseTo(1450, 0) // Average of 1000-1900
      expect(metrics!.uniqueUsers).toBe(3)
      expect(metrics!.lastUsed).toBeGreaterThan(0)
    })

    it('should handle 100% success rate', () => {
      storage.recordEvent({
        skillId: 'anthropic/commit',
        userId: 'user1',
        timestamp: Date.now(),
        taskDuration: 1000,
        outcome: 'success',
        contextHash: 'context1',
      })

      const metrics = storage.getMetricsForSkill('anthropic/commit')

      expect(metrics!.successRate).toBe(1)
    })

    it('should handle 0% success rate', () => {
      storage.recordEvent({
        skillId: 'anthropic/commit',
        userId: 'user1',
        timestamp: Date.now(),
        taskDuration: 1000,
        outcome: 'error',
        contextHash: 'context1',
      })

      const metrics = storage.getMetricsForSkill('anthropic/commit')

      expect(metrics!.successRate).toBe(0)
    })
  })

  describe('cleanup', () => {
    it('should delete events older than 30 days', () => {
      const now = Date.now()
      const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000

      // Add old event
      storage.recordEvent({
        skillId: 'anthropic/commit',
        userId: 'user1',
        timestamp: thirtyOneDaysAgo,
        taskDuration: 1000,
        outcome: 'success',
        contextHash: 'context1',
      })

      // Add recent event
      storage.recordEvent({
        skillId: 'anthropic/commit',
        userId: 'user2',
        timestamp: now,
        taskDuration: 1000,
        outcome: 'success',
        contextHash: 'context1',
      })

      expect(storage.getEventCount()).toBe(2)

      const deleted = storage.cleanup()

      expect(deleted).toBe(1)
      expect(storage.getEventCount()).toBe(1)
    })

    it('should not delete events within 30 days', () => {
      const now = Date.now()
      const twentyNineDaysAgo = now - 29 * 24 * 60 * 60 * 1000

      storage.recordEvent({
        skillId: 'anthropic/commit',
        userId: 'user1',
        timestamp: twentyNineDaysAgo,
        taskDuration: 1000,
        outcome: 'success',
        contextHash: 'context1',
      })

      const deleted = storage.cleanup()

      expect(deleted).toBe(0)
      expect(storage.getEventCount()).toBe(1)
    })

    it('should return 0 when no events to delete', () => {
      const deleted = storage.cleanup()
      expect(deleted).toBe(0)
    })
  })

  describe('getOutcomeCounts', () => {
    it('should return empty object when no events', () => {
      const counts = storage.getOutcomeCounts()
      expect(Object.keys(counts)).toHaveLength(0)
    })

    it('should count outcomes correctly', () => {
      storage.recordEvent({
        skillId: 'test/skill',
        userId: 'user1',
        timestamp: Date.now(),
        taskDuration: 1000,
        outcome: 'success',
        contextHash: 'context1',
      })

      storage.recordEvent({
        skillId: 'test/skill',
        userId: 'user1',
        timestamp: Date.now(),
        taskDuration: 1000,
        outcome: 'success',
        contextHash: 'context1',
      })

      storage.recordEvent({
        skillId: 'test/skill',
        userId: 'user1',
        timestamp: Date.now(),
        taskDuration: 1000,
        outcome: 'error',
        contextHash: 'context1',
      })

      const counts = storage.getOutcomeCounts()

      expect(counts.success).toBe(2)
      expect(counts.error).toBe(1)
    })
  })
})
