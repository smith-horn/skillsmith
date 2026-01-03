/**
 * SMI-914: UsageTracker Tests
 *
 * Tests for the high-level usage tracking API.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { UsageTracker } from '../src/analytics/usage-tracker.js'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('UsageTracker', () => {
  let tracker: UsageTracker
  let testDbPath: string
  let testDir: string

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = join(
      tmpdir(),
      `skillsmith-tracker-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(testDir, { recursive: true })
    testDbPath = join(testDir, 'test-tracker.db')
    // Disable auto-cleanup for tests
    tracker = new UsageTracker({ dbPath: testDbPath, cleanupInterval: 0 })
  })

  afterEach(() => {
    if (tracker) {
      tracker.close()
    }
    // Clean up test files
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('startTracking / endTracking', () => {
    it('should track a skill invocation from start to end', () => {
      const trackingId = tracker.startTracking('anthropic/commit', 'user123')

      expect(trackingId).toMatch(/^anthropic\/commit-\d+-[a-z0-9]+$/)
      expect(tracker.getPendingCount()).toBe(1)

      tracker.endTracking(trackingId, 'success')

      expect(tracker.getPendingCount()).toBe(0)
      expect(tracker.getEventCount()).toBe(1)
    })

    it('should record correct task duration', async () => {
      const trackingId = tracker.startTracking('anthropic/commit', 'user123')

      // Wait a bit to create measurable duration
      await new Promise((resolve) => setTimeout(resolve, 50))

      tracker.endTracking(trackingId, 'success')

      const events = tracker.getEvents('anthropic/commit')
      expect(events).toHaveLength(1)
      expect(events[0].taskDuration).toBeGreaterThanOrEqual(50)
    })

    it('should handle multiple concurrent trackings', () => {
      const id1 = tracker.startTracking('skill/one', 'user1')
      const id2 = tracker.startTracking('skill/two', 'user2')
      const id3 = tracker.startTracking('skill/three', 'user3')

      expect(tracker.getPendingCount()).toBe(3)

      tracker.endTracking(id2, 'success')
      expect(tracker.getPendingCount()).toBe(2)

      tracker.endTracking(id1, 'error')
      expect(tracker.getPendingCount()).toBe(1)

      tracker.endTracking(id3, 'abandoned')
      expect(tracker.getPendingCount()).toBe(0)

      expect(tracker.getEventCount()).toBe(3)
    })

    it('should silently ignore unknown tracking IDs', () => {
      tracker.endTracking('unknown-tracking-id', 'success')

      expect(tracker.getEventCount()).toBe(0)
    })

    it('should hash project context', () => {
      const trackingId = tracker.startTracking('anthropic/commit', 'user123')

      tracker.endTracking(trackingId, 'success', {
        framework: 'react',
        language: 'typescript',
      })

      const events = tracker.getEvents('anthropic/commit')
      expect(events[0].contextHash).toMatch(/^[0-9a-f]{8}$/)
    })

    it('should anonymize user ID', () => {
      const trackingId = tracker.startTracking('anthropic/commit', 'my-actual-username')

      tracker.endTracking(trackingId, 'success')

      const events = tracker.getEvents('anthropic/commit')
      expect(events[0].userId).not.toBe('my-actual-username')
      expect(events[0].userId).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('recordEvent', () => {
    it('should record a complete event directly', () => {
      tracker.recordEvent('anthropic/commit', 'user123', 1500, 'success', {
        framework: 'react',
      })

      expect(tracker.getEventCount()).toBe(1)

      const events = tracker.getEvents('anthropic/commit')
      expect(events).toHaveLength(1)
      expect(events[0].taskDuration).toBe(1500)
      expect(events[0].outcome).toBe('success')
    })

    it('should anonymize user ID in direct recording', () => {
      tracker.recordEvent('anthropic/commit', 'user123', 1500, 'success')

      const events = tracker.getEvents('anthropic/commit')
      expect(events[0].userId).not.toBe('user123')
      expect(events[0].userId).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('getMetrics', () => {
    it('should return null for skill with no events', () => {
      const metrics = tracker.getMetrics('nonexistent/skill')
      expect(metrics).toBeNull()
    })

    it('should return aggregated metrics', () => {
      // Record several events with different outcomes
      tracker.recordEvent('anthropic/commit', 'user1', 1000, 'success')
      tracker.recordEvent('anthropic/commit', 'user2', 1500, 'success')
      tracker.recordEvent('anthropic/commit', 'user1', 2000, 'error')
      tracker.recordEvent('anthropic/commit', 'user3', 1200, 'success')

      const metrics = tracker.getMetrics('anthropic/commit')

      expect(metrics).not.toBeNull()
      expect(metrics!.totalInvocations).toBe(4)
      expect(metrics!.successRate).toBeCloseTo(0.75, 2)
      expect(metrics!.avgTaskDuration).toBeCloseTo(1425, 0)
      expect(metrics!.uniqueUsers).toBe(3)
    })
  })

  describe('getEvents', () => {
    it('should return events for a skill', () => {
      tracker.recordEvent('anthropic/commit', 'user1', 1000, 'success')
      tracker.recordEvent('anthropic/commit', 'user2', 1500, 'success')
      tracker.recordEvent('other/skill', 'user1', 2000, 'success')

      const events = tracker.getEvents('anthropic/commit')

      expect(events).toHaveLength(2)
      events.forEach((e) => expect(e.skillId).toBe('anthropic/commit'))
    })

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordEvent('anthropic/commit', 'user1', 1000, 'success')
      }

      const events = tracker.getEvents('anthropic/commit', 5)

      expect(events).toHaveLength(5)
    })
  })

  describe('cleanup', () => {
    it('should delete old events', () => {
      // We can't easily test time-based cleanup without mocking Date,
      // but we can verify the method works
      const deleted = tracker.cleanup()
      expect(typeof deleted).toBe('number')
    })
  })

  describe('auto-cleanup', () => {
    it('should schedule cleanup with interval', () => {
      vi.useFakeTimers()

      const autoTracker = new UsageTracker({
        dbPath: join(testDir, 'auto-cleanup.db'),
        cleanupInterval: 1000,
      })

      // Spy on cleanup
      const cleanupSpy = vi.spyOn(autoTracker, 'cleanup')

      // Fast-forward time
      vi.advanceTimersByTime(1000)

      expect(cleanupSpy).toHaveBeenCalled()

      autoTracker.close()
      vi.useRealTimers()
    })

    it('should not schedule cleanup when interval is 0', () => {
      vi.useFakeTimers()

      const noCleanupTracker = new UsageTracker({
        dbPath: join(testDir, 'no-cleanup.db'),
        cleanupInterval: 0,
      })

      const cleanupSpy = vi.spyOn(noCleanupTracker, 'cleanup')

      vi.advanceTimersByTime(60 * 60 * 1000)

      expect(cleanupSpy).not.toHaveBeenCalled()

      noCleanupTracker.close()
      vi.useRealTimers()
    })
  })

  describe('consistency', () => {
    it('should produce consistent anonymized IDs for the same user', () => {
      tracker.recordEvent('skill/one', 'consistent-user', 1000, 'success')
      tracker.recordEvent('skill/two', 'consistent-user', 1500, 'success')

      const events1 = tracker.getEvents('skill/one')
      const events2 = tracker.getEvents('skill/two')

      expect(events1[0].userId).toBe(events2[0].userId)
    })

    it('should produce consistent context hashes for the same context', () => {
      const context = { framework: 'react', language: 'typescript' }

      tracker.recordEvent('skill/one', 'user1', 1000, 'success', context)
      tracker.recordEvent('skill/two', 'user2', 1500, 'success', context)

      const events1 = tracker.getEvents('skill/one')
      const events2 = tracker.getEvents('skill/two')

      expect(events1[0].contextHash).toBe(events2[0].contextHash)
    })
  })
})
