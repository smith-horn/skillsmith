/**
 * Rate Limiter Tests - SMI-730
 *
 * Comprehensive tests for token bucket rate limiting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  RateLimiter,
  InMemoryRateLimitStorage,
  RATE_LIMIT_PRESETS,
  createRateLimiterFromPreset,
  type RateLimitConfig,
  type RateLimitStorage,
  type RateLimitMetrics,
} from '../src/security/RateLimiter.js'

describe('RateLimiter - Token Bucket Algorithm', () => {
  let limiter: RateLimiter
  let storage: InMemoryRateLimitStorage

  beforeEach(() => {
    storage = new InMemoryRateLimitStorage()
  })

  afterEach(() => {
    storage.dispose()
    if (limiter) {
      limiter.dispose()
    }
  })

  describe('Basic Rate Limiting', () => {
    it('should allow requests within limit', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // First 10 requests should succeed
      for (let i = 0; i < 10; i++) {
        const result = await limiter.checkLimit('test-key')
        expect(result.allowed).toBe(true)
        expect(result.remaining).toBe(9 - i)
      }
    })

    it('should deny requests exceeding limit', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 5,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Use up all tokens
      for (let i = 0; i < 5; i++) {
        await limiter.checkLimit('test-key')
      }

      // Next request should be denied
      const result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
      expect(result.retryAfterMs).toBeGreaterThan(0)
      expect(result.resetAt).toBeDefined()
    })

    it('should track different keys independently', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 3,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Use all tokens for key1
      for (let i = 0; i < 3; i++) {
        await limiter.checkLimit('key1')
      }

      // key1 should be rate limited
      const result1 = await limiter.checkLimit('key1')
      expect(result1.allowed).toBe(false)

      // key2 should still have tokens
      const result2 = await limiter.checkLimit('key2')
      expect(result2.allowed).toBe(true)
    })
  })

  describe('Token Refill', () => {
    it('should refill tokens over time', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 10, // 10 tokens per second
          windowMs: 60000,
        },
        storage
      )

      // Use all tokens
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit('test-key')
      }

      // Should be rate limited
      let result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(false)

      // Wait 500ms (should refill ~5 tokens)
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Should have ~5 tokens now
      result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBeGreaterThanOrEqual(3)
      expect(result.remaining).toBeLessThanOrEqual(5)
    })

    it('should not exceed max tokens on refill', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 5,
          refillRate: 10, // Fast refill
          windowMs: 60000,
        },
        storage
      )

      // Use one token
      await limiter.checkLimit('test-key')

      // Wait for refill
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Check remaining - should cap at maxTokens
      const result = await limiter.checkLimit('test-key')
      expect(result.remaining).toBeLessThanOrEqual(4)
    })
  })

  describe('Token Cost', () => {
    it('should consume multiple tokens per request', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Request costing 5 tokens
      const result1 = await limiter.checkLimit('test-key', 5)
      expect(result1.allowed).toBe(true)
      expect(result1.remaining).toBe(5)

      // Request costing 3 tokens
      const result2 = await limiter.checkLimit('test-key', 3)
      expect(result2.allowed).toBe(true)
      expect(result2.remaining).toBe(2)

      // Request costing 5 tokens - should fail
      const result3 = await limiter.checkLimit('test-key', 5)
      expect(result3.allowed).toBe(false)
      expect(result3.remaining).toBe(2)
    })

    it('should calculate correct retry time for high cost', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 2, // 2 tokens per second
          windowMs: 60000,
        },
        storage
      )

      // Use all tokens
      await limiter.checkLimit('test-key', 10)

      // Request costing 4 tokens - need to wait ~2 seconds
      const result = await limiter.checkLimit('test-key', 4)
      expect(result.allowed).toBe(false)
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(1900)
      expect(result.retryAfterMs).toBeLessThanOrEqual(2100)
    })
  })

  describe('Reset Functionality', () => {
    it('should reset rate limit for a key', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 3,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Use all tokens
      for (let i = 0; i < 3; i++) {
        await limiter.checkLimit('test-key')
      }

      // Should be rate limited
      let result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(false)

      // Reset
      await limiter.reset('test-key')

      // Should have full tokens again
      result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(2)
    })
  })

  describe('State Inspection', () => {
    it('should return current bucket state', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Make some requests
      await limiter.checkLimit('test-key')
      await limiter.checkLimit('test-key')

      // Get state
      const state = await limiter.getState('test-key')
      expect(state).toBeDefined()
      expect(state?.tokens).toBeCloseTo(8, 0)
      expect(state?.lastRefill).toBeGreaterThan(0)
    })

    it('should return null for non-existent key', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      const state = await limiter.getState('non-existent')
      expect(state).toBeNull()
    })
  })

  describe('Error Handling', () => {
    it('should gracefully handle storage errors with fail-open (default)', async () => {
      // Mock storage that throws errors
      const errorStorage: RateLimitStorage = {
        get: vi.fn().mockRejectedValue(new Error('Storage error')),
        set: vi.fn().mockRejectedValue(new Error('Storage error')),
        delete: vi.fn().mockRejectedValue(new Error('Storage error')),
      }

      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        errorStorage
      )

      // Should allow request despite error (graceful degradation)
      const result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(10)
      expect(result.limit).toBe(10)
    })

    it('should deny requests with fail-closed mode on storage errors', async () => {
      // Mock storage that throws errors
      const errorStorage: RateLimitStorage = {
        get: vi.fn().mockRejectedValue(new Error('Storage error')),
        set: vi.fn().mockRejectedValue(new Error('Storage error')),
        delete: vi.fn().mockRejectedValue(new Error('Storage error')),
      }

      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
          failMode: 'closed',
        },
        errorStorage
      )

      // Should deny request due to fail-closed mode
      const result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
      expect(result.limit).toBe(10)
      expect(result.retryAfterMs).toBe(60000)
      expect(result.resetAt).toBeDefined()
    })

    it('should explicitly allow requests with fail-open mode on storage errors', async () => {
      // Mock storage that throws errors
      const errorStorage: RateLimitStorage = {
        get: vi.fn().mockRejectedValue(new Error('Storage error')),
        set: vi.fn().mockRejectedValue(new Error('Storage error')),
        delete: vi.fn().mockRejectedValue(new Error('Storage error')),
      }

      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
          failMode: 'open',
        },
        errorStorage
      )

      // Should allow request due to fail-open mode
      const result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(10)
      expect(result.limit).toBe(10)
    })

    it('should use fail-closed for STRICT preset', async () => {
      // Mock storage that throws errors
      const errorStorage: RateLimitStorage = {
        get: vi.fn().mockRejectedValue(new Error('Storage error')),
        set: vi.fn().mockRejectedValue(new Error('Storage error')),
        delete: vi.fn().mockRejectedValue(new Error('Storage error')),
      }

      limiter = new RateLimiter(RATE_LIMIT_PRESETS.STRICT, errorStorage)

      // STRICT preset uses fail-closed, so should deny on error
      const result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(false)
    })

    it('should use fail-open for STANDARD preset', async () => {
      // Mock storage that throws errors
      const errorStorage: RateLimitStorage = {
        get: vi.fn().mockRejectedValue(new Error('Storage error')),
        set: vi.fn().mockRejectedValue(new Error('Storage error')),
        delete: vi.fn().mockRejectedValue(new Error('Storage error')),
      }

      limiter = new RateLimiter(RATE_LIMIT_PRESETS.STANDARD, errorStorage)

      // STANDARD preset uses fail-open, so should allow on error
      const result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(true)
    })
  })

  describe('Key Prefix', () => {
    it('should use custom key prefix', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
          keyPrefix: 'custom',
        },
        storage
      )

      await limiter.checkLimit('test-key')

      const stats = storage.getStats()
      expect(stats.keys[0]).toContain('custom:test-key')
    })
  })

  describe('Presets', () => {
    it('should create limiter from STRICT preset', () => {
      limiter = createRateLimiterFromPreset('STRICT', storage)
      expect(limiter).toBeInstanceOf(RateLimiter)
    })

    it('should create limiter from STANDARD preset', () => {
      limiter = createRateLimiterFromPreset('STANDARD', storage)
      expect(limiter).toBeInstanceOf(RateLimiter)
    })

    it('should create limiter from RELAXED preset', () => {
      limiter = createRateLimiterFromPreset('RELAXED', storage)
      expect(limiter).toBeInstanceOf(RateLimiter)
    })

    it('should create limiter from GENEROUS preset', () => {
      limiter = createRateLimiterFromPreset('GENEROUS', storage)
      expect(limiter).toBeInstanceOf(RateLimiter)
    })

    it('should create limiter from HIGH_THROUGHPUT preset', () => {
      limiter = createRateLimiterFromPreset('HIGH_THROUGHPUT', storage)
      expect(limiter).toBeInstanceOf(RateLimiter)
    })

    it('should enforce STRICT limits correctly', async () => {
      limiter = createRateLimiterFromPreset('STRICT', storage)

      // STRICT allows 10 requests per minute
      for (let i = 0; i < 10; i++) {
        const result = await limiter.checkLimit('test-key')
        expect(result.allowed).toBe(true)
      }

      // 11th request should fail
      const result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(false)
    })
  })

  describe('Metrics Tracking - SMI-752', () => {
    it('should accumulate metrics for allowed requests', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Make 5 allowed requests
      for (let i = 0; i < 5; i++) {
        await limiter.checkLimit('test-key')
      }

      const metrics = limiter.getMetrics('test-key') as RateLimitMetrics
      expect(metrics).toBeDefined()
      expect(metrics.allowed).toBe(5)
      expect(metrics.blocked).toBe(0)
      expect(metrics.errors).toBe(0)
      expect(metrics.lastReset).toBeInstanceOf(Date)
    })

    it('should accumulate metrics for blocked requests', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 3,
          refillRate: 0.1,
          windowMs: 60000,
        },
        storage
      )

      // Make 3 allowed requests
      for (let i = 0; i < 3; i++) {
        await limiter.checkLimit('test-key')
      }

      // Make 2 blocked requests
      await limiter.checkLimit('test-key')
      await limiter.checkLimit('test-key')

      const metrics = limiter.getMetrics('test-key') as RateLimitMetrics
      expect(metrics.allowed).toBe(3)
      expect(metrics.blocked).toBe(2)
      expect(metrics.errors).toBe(0)
    })

    it('should include metrics in result', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 5,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      const result = await limiter.checkLimit('test-key')
      expect(result.metrics).toBeDefined()
      expect(result.metrics?.allowed).toBe(1)
    })

    it('should track errors in metrics', async () => {
      const errorStorage: RateLimitStorage = {
        get: vi.fn().mockRejectedValue(new Error('Storage error')),
        set: vi.fn().mockRejectedValue(new Error('Storage error')),
        delete: vi.fn().mockRejectedValue(new Error('Storage error')),
      }

      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
          failMode: 'open',
        },
        errorStorage
      )

      // Make 3 requests that will error
      for (let i = 0; i < 3; i++) {
        await limiter.checkLimit('test-key')
      }

      const metrics = limiter.getMetrics('test-key') as RateLimitMetrics
      expect(metrics.errors).toBe(3)
      // Fail-open counts as allowed
      expect(metrics.allowed).toBe(3)
    })

    it('should getMetrics() return all metrics when no key specified', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Make requests for multiple keys
      await limiter.checkLimit('key1')
      await limiter.checkLimit('key1')
      await limiter.checkLimit('key2')
      await limiter.checkLimit('key3')

      const allMetrics = limiter.getMetrics() as Map<string, RateLimitMetrics>
      expect(allMetrics).toBeInstanceOf(Map)
      expect(allMetrics.size).toBe(3)
      expect(allMetrics.get('key1')?.allowed).toBe(2)
      expect(allMetrics.get('key2')?.allowed).toBe(1)
      expect(allMetrics.get('key3')?.allowed).toBe(1)
    })

    it('should resetMetrics() clear data for specific key', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Make requests
      await limiter.checkLimit('key1')
      await limiter.checkLimit('key2')

      // Reset only key1
      limiter.resetMetrics('key1')

      expect(limiter.getMetrics('key1')).toBeUndefined()
      expect(limiter.getMetrics('key2')).toBeDefined()
    })

    it('should resetMetrics() clear all data when no key specified', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Make requests for multiple keys
      await limiter.checkLimit('key1')
      await limiter.checkLimit('key2')
      await limiter.checkLimit('key3')

      // Reset all
      limiter.resetMetrics()

      const allMetrics = limiter.getMetrics() as Map<string, RateLimitMetrics>
      expect(allMetrics.size).toBe(0)
    })

    it('should call onLimitExceeded callback when limit is exceeded', async () => {
      const onLimitExceeded = vi.fn()

      limiter = new RateLimiter(
        {
          maxTokens: 3,
          refillRate: 0.1,
          windowMs: 60000,
          onLimitExceeded,
        },
        storage
      )

      // Use up all tokens
      for (let i = 0; i < 3; i++) {
        await limiter.checkLimit('test-key')
      }

      // This should trigger the callback
      await limiter.checkLimit('test-key')

      expect(onLimitExceeded).toHaveBeenCalledTimes(1)
      expect(onLimitExceeded).toHaveBeenCalledWith(
        'test-key',
        expect.objectContaining({
          allowed: 3,
          blocked: 1,
          errors: 0,
        })
      )
    })

    it('should call onLimitExceeded callback on each exceeded request', async () => {
      const onLimitExceeded = vi.fn()

      limiter = new RateLimiter(
        {
          maxTokens: 2,
          refillRate: 0.01,
          windowMs: 60000,
          onLimitExceeded,
        },
        storage
      )

      // Use up all tokens
      await limiter.checkLimit('test-key')
      await limiter.checkLimit('test-key')

      // These should trigger callbacks
      await limiter.checkLimit('test-key')
      await limiter.checkLimit('test-key')
      await limiter.checkLimit('test-key')

      expect(onLimitExceeded).toHaveBeenCalledTimes(3)
    })

    it('should not call onLimitExceeded for allowed requests', async () => {
      const onLimitExceeded = vi.fn()

      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
          onLimitExceeded,
        },
        storage
      )

      // Make allowed requests
      for (let i = 0; i < 5; i++) {
        await limiter.checkLimit('test-key')
      }

      expect(onLimitExceeded).not.toHaveBeenCalled()
    })

    it('should clear metrics on dispose', async () => {
      limiter = new RateLimiter(
        {
          maxTokens: 10,
          refillRate: 1,
          windowMs: 60000,
        },
        storage
      )

      // Make requests
      await limiter.checkLimit('test-key')

      // Dispose should clear metrics
      limiter.dispose()

      const allMetrics = limiter.getMetrics() as Map<string, RateLimitMetrics>
      expect(allMetrics.size).toBe(0)
    })
  })
})

describe('InMemoryRateLimitStorage', () => {
  let storage: InMemoryRateLimitStorage

  beforeEach(() => {
    storage = new InMemoryRateLimitStorage()
  })

  afterEach(() => {
    storage.dispose()
  })

  describe('Basic Operations', () => {
    it('should store and retrieve bucket', async () => {
      const bucket = {
        tokens: 10,
        lastRefill: Date.now(),
        firstRequest: Date.now(),
      }

      await storage.set('test-key', bucket, 60000)
      const retrieved = await storage.get('test-key')

      expect(retrieved).toEqual(bucket)
    })

    it('should return null for non-existent key', async () => {
      const result = await storage.get('non-existent')
      expect(result).toBeNull()
    })

    it('should delete key', async () => {
      const bucket = {
        tokens: 10,
        lastRefill: Date.now(),
        firstRequest: Date.now(),
      }

      await storage.set('test-key', bucket, 60000)
      await storage.delete('test-key')

      const result = await storage.get('test-key')
      expect(result).toBeNull()
    })

    it('should clear all keys', async () => {
      const bucket = {
        tokens: 10,
        lastRefill: Date.now(),
        firstRequest: Date.now(),
      }

      await storage.set('key1', bucket, 60000)
      await storage.set('key2', bucket, 60000)

      await storage.clear?.()

      const stats = storage.getStats()
      expect(stats.size).toBe(0)
    })
  })

  describe('TTL and Expiration', () => {
    it('should expire entries after TTL', async () => {
      const bucket = {
        tokens: 10,
        lastRefill: Date.now(),
        firstRequest: Date.now(),
      }

      // Set with 100ms TTL
      await storage.set('test-key', bucket, 100)

      // Should exist immediately
      let result = await storage.get('test-key')
      expect(result).toEqual(bucket)

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Should be expired
      result = await storage.get('test-key')
      expect(result).toBeNull()
    })

    it('should clean up expired entries periodically', async () => {
      // Create storage with fast cleanup (100ms)
      const fastStorage = new InMemoryRateLimitStorage(100)

      const bucket = {
        tokens: 10,
        lastRefill: Date.now(),
        firstRequest: Date.now(),
      }

      // Add multiple entries with short TTL
      await fastStorage.set('key1', bucket, 50)
      await fastStorage.set('key2', bucket, 50)
      await fastStorage.set('key3', bucket, 50)

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200))

      const stats = fastStorage.getStats()
      expect(stats.size).toBe(0)

      fastStorage.dispose()
    })
  })

  describe('Statistics', () => {
    it('should return accurate stats', async () => {
      const bucket = {
        tokens: 10,
        lastRefill: Date.now(),
        firstRequest: Date.now(),
      }

      await storage.set('key1', bucket, 60000)
      await storage.set('key2', bucket, 60000)

      const stats = storage.getStats()
      expect(stats.size).toBe(2)
      expect(stats.keys).toContain('key1')
      expect(stats.keys).toContain('key2')
    })
  })
})

describe('Rate Limiting Scenarios', () => {
  let storage: InMemoryRateLimitStorage

  beforeEach(() => {
    storage = new InMemoryRateLimitStorage()
  })

  afterEach(() => {
    storage.dispose()
  })

  describe('API Endpoint Rate Limiting', () => {
    it('should limit search API requests per IP', async () => {
      const limiter = new RateLimiter(RATE_LIMIT_PRESETS.STANDARD, storage)

      const ip = '192.168.1.1'

      // Simulate 30 search requests (at limit)
      for (let i = 0; i < 30; i++) {
        const result = await limiter.checkLimit(`ip:${ip}`)
        expect(result.allowed).toBe(true)
      }

      // 31st request should be denied
      const result = await limiter.checkLimit(`ip:${ip}`)
      expect(result.allowed).toBe(false)
      expect(result.retryAfterMs).toBeGreaterThan(0)
    })

    it('should limit install operations per user', async () => {
      // Stricter limits for install operations
      const limiter = new RateLimiter(
        {
          maxTokens: 5,
          refillRate: 5 / 60, // 5 per minute
          windowMs: 60000,
        },
        storage
      )

      const userId = 'user-123'

      // User can install 5 skills
      for (let i = 0; i < 5; i++) {
        const result = await limiter.checkLimit(`user:${userId}:install`)
        expect(result.allowed).toBe(true)
      }

      // 6th install should be denied
      const result = await limiter.checkLimit(`user:${userId}:install`)
      expect(result.allowed).toBe(false)
    })
  })

  describe('Source Adapter Rate Limiting', () => {
    it('should limit GitHub API requests', async () => {
      const limiter = new RateLimiter(
        {
          maxTokens: 60,
          refillRate: 1, // 60 per minute
          windowMs: 60000,
        },
        storage
      )

      // Simulate batch of API calls
      for (let i = 0; i < 60; i++) {
        const result = await limiter.checkLimit('adapter:github')
        expect(result.allowed).toBe(true)
      }

      // Next call should be rate limited
      const result = await limiter.checkLimit('adapter:github')
      expect(result.allowed).toBe(false)
    })

    it('should limit raw URL fetches', async () => {
      const limiter = new RateLimiter(RATE_LIMIT_PRESETS.STANDARD, storage)

      // Simulate URL fetches
      for (let i = 0; i < 30; i++) {
        const result = await limiter.checkLimit('adapter:raw-url')
        expect(result.allowed).toBe(true)
      }

      const result = await limiter.checkLimit('adapter:raw-url')
      expect(result.allowed).toBe(false)
    })
  })

  describe('Burst Traffic', () => {
    it('should allow burst within token capacity', async () => {
      // Use fake timers to prevent token refill during parallel execution
      vi.useFakeTimers()

      const limiter = new RateLimiter(
        {
          maxTokens: 20,
          refillRate: 5, // Refill slowly
          windowMs: 60000,
        },
        storage
      )

      // Burst of 20 requests - should all succeed
      // Use sequential execution to ensure deterministic token consumption
      for (let i = 0; i < 20; i++) {
        const result = await limiter.checkLimit('test-key')
        expect(result.allowed).toBe(true)
      }

      // 21st should fail (all tokens consumed)
      const result = await limiter.checkLimit('test-key')
      expect(result.allowed).toBe(false)

      vi.useRealTimers()
    })
  })
})
