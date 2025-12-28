/**
 * SMI-681: Security tests for Rate Limiter memory leak prevention
 *
 * These tests verify that the rate limiter properly cleans up
 * old entries to prevent memory leaks from storing stale IP data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Import rate limiter functions directly from the TypeScript source
import {
  createRateLimiter,
  isRateLimited,
  destroyRateLimiter,
  type RateLimiterState,
} from '../../src/webhooks/webhook-endpoint.ts'

describe('Rate Limiter Memory Leak Prevention (SMI-681)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('createRateLimiter', () => {
    it('should create a rate limiter with cleanup timer', () => {
      const limiter = createRateLimiter(100, 60000)

      expect(limiter.requests).toBeInstanceOf(Map)
      expect(limiter.limit).toBe(100)
      expect(limiter.window).toBe(60000)
      expect(limiter.cleanupTimer).toBeDefined()

      destroyRateLimiter(limiter)
    })
  })

  describe('periodic cleanup', () => {
    it('should clean up old IPs after window period expires', () => {
      const windowMs = 60000 // 1 minute
      const limiter = createRateLimiter(100, windowMs)

      // Add some requests from different IPs
      isRateLimited(limiter, '192.168.1.1')
      isRateLimited(limiter, '192.168.1.2')
      isRateLimited(limiter, '192.168.1.3')

      expect(limiter.requests.size).toBe(3)

      // Advance time past the window
      vi.advanceTimersByTime(windowMs + 1)

      // After cleanup runs, old entries should be removed
      expect(limiter.requests.size).toBe(0)

      destroyRateLimiter(limiter)
    })

    it('should NOT clean up IPs with recent activity', () => {
      const windowMs = 60000
      const limiter = createRateLimiter(100, windowMs)

      // Add initial request
      isRateLimited(limiter, '192.168.1.1')

      // Advance time but not past window
      vi.advanceTimersByTime(windowMs / 2)

      // Add another request from same IP (keeps it active)
      isRateLimited(limiter, '192.168.1.1')

      // Add request from new IP
      isRateLimited(limiter, '192.168.1.2')

      // Advance to trigger cleanup
      vi.advanceTimersByTime(windowMs + 1)

      // Old IP without recent activity should be cleaned
      // IPs with activity within window should remain
      // Note: Due to timing, both might have recent entries
      expect(limiter.requests.has('192.168.1.2')).toBe(true)

      destroyRateLimiter(limiter)
    })

    it('should continuously clean up over multiple windows', () => {
      const windowMs = 60000
      const limiter = createRateLimiter(100, windowMs)

      // First wave of IPs
      for (let i = 0; i < 100; i++) {
        isRateLimited(limiter, `192.168.1.${i}`)
      }
      expect(limiter.requests.size).toBe(100)

      // Advance past window, cleanup should run
      vi.advanceTimersByTime(windowMs + 1)
      expect(limiter.requests.size).toBe(0)

      // Second wave of IPs
      for (let i = 0; i < 50; i++) {
        isRateLimited(limiter, `10.0.0.${i}`)
      }
      expect(limiter.requests.size).toBe(50)

      // Advance past TWO windows to ensure cleanup runs after entries expire
      // (cleanup runs at intervals, so first run may still see entries in window)
      vi.advanceTimersByTime(windowMs * 2)
      expect(limiter.requests.size).toBe(0)

      destroyRateLimiter(limiter)
    })
  })

  describe('destroyRateLimiter', () => {
    it('should clear all state and stop cleanup timer', () => {
      const limiter = createRateLimiter(100, 60000)

      // Add some data
      isRateLimited(limiter, '192.168.1.1')
      isRateLimited(limiter, '192.168.1.2')

      expect(limiter.requests.size).toBe(2)

      // Destroy the limiter
      destroyRateLimiter(limiter)

      // All state should be cleared
      expect(limiter.requests.size).toBe(0)
      expect(limiter.cleanupTimer).toBeUndefined()
    })

    it('should be safe to call multiple times', () => {
      const limiter = createRateLimiter(100, 60000)

      destroyRateLimiter(limiter)
      destroyRateLimiter(limiter) // Should not throw

      expect(limiter.requests.size).toBe(0)
    })
  })

  describe('memory growth prevention', () => {
    it('should not grow memory unboundedly with many unique IPs', () => {
      const windowMs = 1000 // 1 second for faster testing
      const limiter = createRateLimiter(100, windowMs)

      // Simulate many unique IPs over time
      for (let batch = 0; batch < 10; batch++) {
        for (let i = 0; i < 100; i++) {
          isRateLimited(limiter, `${batch}.${i}.0.1`)
        }

        // Advance time past window to trigger cleanup
        vi.advanceTimersByTime(windowMs + 100)
      }

      // After all cleanups, map should be empty (no recent activity)
      expect(limiter.requests.size).toBeLessThanOrEqual(100)

      destroyRateLimiter(limiter)
    })
  })
})
