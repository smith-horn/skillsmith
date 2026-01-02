/**
 * SMI-920: UsageTracker Tests
 *
 * Tests for usage tracking functionality including:
 * - Session tracking start/end
 * - Stale session cleanup
 * - dispose() cleanup
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { UsageTracker } from '../../src/analytics/usage-tracker.js'

describe('UsageTracker', () => {
  let tracker: UsageTracker

  beforeEach(() => {
    // Use in-memory database for tests
    tracker = new UsageTracker({ dbPath: ':memory:' })
  })

  afterEach(() => {
    tracker.dispose()
  })

  describe('session tracking', () => {
    it('should start and end tracking correctly', () => {
      const trackingId = tracker.startTracking('test/skill', 'user-1')

      expect(trackingId).toBeTruthy()
      expect(tracker.getPendingCount()).toBe(1)

      tracker.endTracking(trackingId, 'success')

      expect(tracker.getPendingCount()).toBe(0)
    })

    it('should handle multiple concurrent sessions', () => {
      const id1 = tracker.startTracking('skill-1', 'user-1')
      const id2 = tracker.startTracking('skill-2', 'user-2')
      const id3 = tracker.startTracking('skill-3', 'user-1')

      expect(tracker.getPendingCount()).toBe(3)

      tracker.endTracking(id2, 'success')
      expect(tracker.getPendingCount()).toBe(2)

      tracker.endTracking(id1, 'error')
      tracker.endTracking(id3, 'abandoned')
      expect(tracker.getPendingCount()).toBe(0)
    })

    it('should silently ignore unknown tracking IDs', () => {
      tracker.endTracking('non-existent-id', 'success')
      expect(tracker.getPendingCount()).toBe(0)
    })
  })

  describe('stale session cleanup', () => {
    it('should clean up sessions after timeout', () => {
      // Mock Date.now to control time
      const originalDateNow = Date.now
      let currentTime = 1000000

      vi.spyOn(Date, 'now').mockImplementation(() => currentTime)

      // Start a session
      tracker.startTracking('test/skill', 'user-1')
      expect(tracker.getPendingCount()).toBe(1)

      // Advance time past the 1 hour timeout
      currentTime += 60 * 60 * 1000 + 1000 // 1 hour + 1 second

      // Start another session to trigger cleanup
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      tracker.startTracking('another/skill', 'user-2')

      // The stale session should be cleaned up
      expect(tracker.getPendingCount()).toBe(1) // Only the new session remains
      expect(consoleWarnSpy).toHaveBeenCalledWith('[usage-tracker] Cleaned up 1 stale sessions')

      consoleWarnSpy.mockRestore()
      vi.spyOn(Date, 'now').mockRestore()
      Date.now = originalDateNow
    })

    it('should not clean up sessions that are still within timeout', () => {
      const originalDateNow = Date.now
      let currentTime = 1000000

      vi.spyOn(Date, 'now').mockImplementation(() => currentTime)

      tracker.startTracking('test/skill', 'user-1')
      expect(tracker.getPendingCount()).toBe(1)

      // Advance time but not past the timeout
      currentTime += 30 * 60 * 1000 // 30 minutes

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      tracker.startTracking('another/skill', 'user-2')

      // Both sessions should remain
      expect(tracker.getPendingCount()).toBe(2)
      expect(consoleWarnSpy).not.toHaveBeenCalled()

      consoleWarnSpy.mockRestore()
      vi.spyOn(Date, 'now').mockRestore()
      Date.now = originalDateNow
    })

    it('should clean up multiple stale sessions at once', () => {
      const originalDateNow = Date.now
      let currentTime = 1000000

      vi.spyOn(Date, 'now').mockImplementation(() => currentTime)

      // Start multiple sessions
      tracker.startTracking('skill-1', 'user-1')
      tracker.startTracking('skill-2', 'user-2')
      tracker.startTracking('skill-3', 'user-3')
      expect(tracker.getPendingCount()).toBe(3)

      // Advance time past timeout
      currentTime += 60 * 60 * 1000 + 1000

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      tracker.startTracking('new/skill', 'user-4')

      expect(tracker.getPendingCount()).toBe(1)
      expect(consoleWarnSpy).toHaveBeenCalledWith('[usage-tracker] Cleaned up 3 stale sessions')

      consoleWarnSpy.mockRestore()
      vi.spyOn(Date, 'now').mockRestore()
      Date.now = originalDateNow
    })
  })

  describe('dispose', () => {
    it('should clear the session cleanup interval', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval')

      const testTracker = new UsageTracker({ dbPath: ':memory:' })
      testTracker.dispose()

      // Should have cleared at least the session cleanup timer
      expect(clearIntervalSpy).toHaveBeenCalled()

      clearIntervalSpy.mockRestore()
    })

    it('should be callable multiple times without error', () => {
      const testTracker = new UsageTracker({ dbPath: ':memory:' })

      expect(() => {
        testTracker.dispose()
        testTracker.dispose()
      }).not.toThrow()
    })

    it('should be an alias for close', () => {
      const testTracker = new UsageTracker({ dbPath: ':memory:' })
      const closeSpy = vi.spyOn(testTracker, 'close')

      testTracker.dispose()

      expect(closeSpy).toHaveBeenCalled()
      closeSpy.mockRestore()
    })
  })

  describe('recordEvent', () => {
    it('should record events directly without tracking', () => {
      tracker.recordEvent('test/skill', 'user-1', 1000, 'success', { framework: 'react' })

      const events = tracker.getEvents('test/skill')
      expect(events).toHaveLength(1)
      expect(events[0].skillId).toBe('test/skill')
      expect(events[0].taskDuration).toBe(1000)
      expect(events[0].outcome).toBe('success')
    })
  })

  describe('getMetrics', () => {
    it('should return null for skill with no events', () => {
      const metrics = tracker.getMetrics('non-existent/skill')
      expect(metrics).toBeNull()
    })

    it('should return metrics for skill with events', () => {
      tracker.recordEvent('test/skill', 'user-1', 500, 'success')
      tracker.recordEvent('test/skill', 'user-2', 600, 'success')
      tracker.recordEvent('test/skill', 'user-1', 400, 'error')

      const metrics = tracker.getMetrics('test/skill')

      expect(metrics).not.toBeNull()
      expect(metrics!.totalInvocations).toBe(3)
    })
  })
})
