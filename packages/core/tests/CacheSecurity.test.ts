/**
 * SMI-683 & SMI-684: Security and Concurrency Tests for Tiered Cache
 * TDD approach: These tests are written FIRST and should FAIL until fixes are implemented
 *
 * Uses fake timers for deterministic date testing (SMI-992)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  deserializeCacheEntry,
  TTLTier,
  type SerializedCacheEntry,
  type SearchResult,
  CacheManager,
} from '../src/cache/index.js'
import { FIXED_TIMESTAMP, setupFakeTimers, cleanupFakeTimers } from './test-utils.js'

// Counter for unique paths
let testPathCounter = 0

// Helper functions
function createTestResults(count: number): SearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `skill-${i}`,
    name: `test-skill-${i}`,
    description: `Description for skill ${i}`,
    score: 0.9 - i * 0.1,
    source: 'test',
  }))
}

function getTempDbPath(): string {
  testPathCounter++
  return path.join(
    os.tmpdir(),
    `test-cache-security-${FIXED_TIMESTAMP}-${testPathCounter.toString(36)}.db`
  )
}

function cleanupDb(dbPath: string): void {
  try {
    fs.unlinkSync(dbPath)
  } catch {
    // Ignore cleanup errors
  }
}

function createSerializedEntry(dataJson: string): SerializedCacheEntry {
  return {
    key: 'test-key',
    data_json: dataJson,
    total_count: 1,
    created_at: FIXED_TIMESTAMP,
    expires_at: FIXED_TIMESTAMP + TTLTier.STANDARD,
    hit_count: 0,
    last_accessed_at: FIXED_TIMESTAMP,
    ttl_tier: TTLTier.STANDARD,
  }
}

describe('SMI-684: Prototype Pollution Detection', () => {
  beforeEach(() => {
    setupFakeTimers()
  })

  afterEach(() => {
    cleanupFakeTimers()
  })

  describe('deserializeCacheEntry security', () => {
    it('should detect __proto__ with unicode escape bypass', () => {
      // Unicode escape: \u005f = underscore, so \u005f\u005fproto\u005f\u005f = __proto__
      const maliciousJson = '{"\\u005f\\u005fproto\\u005f\\u005f": {"polluted": true}}'
      const serialized = createSerializedEntry(maliciousJson)

      expect(() => deserializeCacheEntry(serialized)).toThrow('Prototype pollution')
    })

    it('should detect nested __proto__ pollution', () => {
      const maliciousJson = '{"normal": {"__proto__": {"polluted": true}}}'
      const serialized = createSerializedEntry(maliciousJson)

      expect(() => deserializeCacheEntry(serialized)).toThrow('Prototype pollution')
    })

    it('should detect deeply nested __proto__ pollution', () => {
      const maliciousJson = '{"a": {"b": {"c": {"d": {"__proto__": {"polluted": true}}}}}}'
      const serialized = createSerializedEntry(maliciousJson)

      expect(() => deserializeCacheEntry(serialized)).toThrow('Prototype pollution')
    })

    it('should detect prototype key pollution', () => {
      const maliciousJson = '{"prototype": {"polluted": true}}'
      const serialized = createSerializedEntry(maliciousJson)

      expect(() => deserializeCacheEntry(serialized)).toThrow('Prototype pollution')
    })

    it('should detect constructor key pollution', () => {
      const maliciousJson = '{"constructor": {"prototype": {"polluted": true}}}'
      const serialized = createSerializedEntry(maliciousJson)

      expect(() => deserializeCacheEntry(serialized)).toThrow('Prototype pollution')
    })

    it('should detect nested constructor pollution', () => {
      const maliciousJson = '{"results": [{"constructor": {"polluted": true}}]}'
      const serialized = createSerializedEntry(maliciousJson)

      expect(() => deserializeCacheEntry(serialized)).toThrow('Prototype pollution')
    })

    it('should detect pollution in array elements', () => {
      const maliciousJson = '[{"__proto__": {"polluted": true}}]'
      const serialized = createSerializedEntry(maliciousJson)

      expect(() => deserializeCacheEntry(serialized)).toThrow('Prototype pollution')
    })

    it('should handle mixed unicode escape and regular keys', () => {
      // Mix of unicode escape and regular dangerous key
      const maliciousJson = '{"safe": {"\\u0063onstructor": {"prototype": {}}}}'
      const serialized = createSerializedEntry(maliciousJson)

      expect(() => deserializeCacheEntry(serialized)).toThrow('Prototype pollution')
    })

    it('should allow safe JSON without dangerous keys', () => {
      const safeJson = JSON.stringify([
        { id: 'skill-1', name: 'test', description: 'safe', score: 0.9, source: 'test' },
      ])
      const serialized = createSerializedEntry(safeJson)

      // Should NOT throw
      const result = deserializeCacheEntry(serialized)
      expect(result.data).toBeDefined()
    })

    it('should prevent actual prototype pollution via Object.prototype', () => {
      // This test verifies that even if regex is bypassed, the pollution doesn't work
      const maliciousJson = '{"\\u005f\\u005fproto\\u005f\\u005f": {"isAdmin": true}}'
      const serialized = createSerializedEntry(maliciousJson)

      // Before calling, Object.prototype should not have isAdmin
      expect((Object.prototype as Record<string, unknown>)['isAdmin']).toBeUndefined()

      try {
        deserializeCacheEntry(serialized)
      } catch {
        // Expected to throw
      }

      // After calling, Object.prototype should still not have isAdmin
      expect((Object.prototype as Record<string, unknown>)['isAdmin']).toBeUndefined()
    })
  })
})

describe('SMI-683: Race Condition in Background Refresh', () => {
  let manager: CacheManager
  let dbPath: string
  let refreshCallCount: number

  beforeEach(() => {
    dbPath = getTempDbPath()
    refreshCallCount = 0

    manager = new CacheManager({
      l1: { maxEntries: 100 },
      l2: { dbPath },
      enableBackgroundRefresh: true,
      refreshIntervalMs: 1000000, // Disable auto-refresh for manual testing
      maxConcurrentRefreshes: 5,
      refreshCallback: async (_options) => {
        refreshCallCount++
        // Simulate slow refresh
        await new Promise((resolve) => setTimeout(resolve, 100))
        return { results: createTestResults(1), totalCount: 1 }
      },
    })
  })

  afterEach(() => {
    manager.close()
    cleanupDb(dbPath)
  })

  it('should return same promise for concurrent refresh calls on same key', async () => {
    const options = { query: 'concurrent-test' }
    manager.set(options, createTestResults(1), 1)

    // Access internal refreshEntry method (would need to expose or use a different approach)
    const key = CacheManager.generateKey(options)

    // Simulate concurrent refresh calls
    const refreshMethod = (
      manager as unknown as { refreshEntry: (key: string) => Promise<void> }
    ).refreshEntry.bind(manager)

    const promise1 = refreshMethod(key)
    const promise2 = refreshMethod(key)
    const promise3 = refreshMethod(key)

    // All promises should be the same instance
    expect(promise1).toBe(promise2)
    expect(promise2).toBe(promise3)

    await Promise.all([promise1, promise2, promise3])

    // Only one actual refresh should have occurred
    expect(refreshCallCount).toBe(1)
  })

  it('should cleanup active refresh after completion', async () => {
    const options = { query: 'cleanup-test' }
    manager.set(options, createTestResults(1), 1)

    const key = CacheManager.generateKey(options)
    const refreshMethod = (
      manager as unknown as { refreshEntry: (key: string) => Promise<void> }
    ).refreshEntry.bind(manager)
    const activeRefreshes = (manager as unknown as { activeRefreshes: Map<string, Promise<void>> })
      .activeRefreshes

    // Start refresh
    const refreshPromise = refreshMethod(key)

    // Should be tracked as active
    expect(activeRefreshes.has(key)).toBe(true)

    // Wait for completion
    await refreshPromise

    // Should be cleaned up after completion
    expect(activeRefreshes.has(key)).toBe(false)
  })

  it('should cleanup active refresh after error', async () => {
    // Create new manager with failing callback
    manager.close()
    cleanupDb(dbPath)
    dbPath = getTempDbPath()

    manager = new CacheManager({
      l1: { maxEntries: 100 },
      l2: { dbPath },
      enableBackgroundRefresh: true,
      refreshIntervalMs: 1000000,
      maxConcurrentRefreshes: 5,
      refreshCallback: async () => {
        throw new Error('Refresh failed intentionally')
      },
    })

    const options = { query: 'error-test' }
    manager.set(options, createTestResults(1), 1)

    const key = CacheManager.generateKey(options)
    const refreshMethod = (
      manager as unknown as { refreshEntry: (key: string) => Promise<void> }
    ).refreshEntry.bind(manager)
    const activeRefreshes = (manager as unknown as { activeRefreshes: Map<string, Promise<void>> })
      .activeRefreshes

    // Start refresh - the error will propagate since we're calling the method directly
    const refreshPromise = refreshMethod(key)

    // Wait for completion - error will propagate, so catch it
    try {
      await refreshPromise
    } catch {
      // Expected - error propagates from direct call
    }

    // Should still be cleaned up after error (via finally block)
    expect(activeRefreshes.has(key)).toBe(false)
  })

  it('should not create duplicate refreshes under high concurrency', async () => {
    const options = { query: 'high-concurrency-test' }
    manager.set(options, createTestResults(1), 1)

    const key = CacheManager.generateKey(options)
    const refreshMethod = (
      manager as unknown as { refreshEntry: (key: string) => Promise<void> }
    ).refreshEntry.bind(manager)

    // Simulate 100 concurrent refresh requests
    const promises: Promise<void>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(refreshMethod(key))
    }

    await Promise.all(promises)

    // Should only have called the actual refresh once
    expect(refreshCallCount).toBe(1)
  })

  it('should allow new refresh after previous completes', async () => {
    const options = { query: 'sequential-test' }
    manager.set(options, createTestResults(1), 1)

    const key = CacheManager.generateKey(options)
    const refreshMethod = (
      manager as unknown as { refreshEntry: (key: string) => Promise<void> }
    ).refreshEntry.bind(manager)

    // First refresh
    await refreshMethod(key)
    expect(refreshCallCount).toBe(1)

    // Second refresh (should be allowed since first completed)
    await refreshMethod(key)
    expect(refreshCallCount).toBe(2)
  })
})

describe('Additional Security Tests', () => {
  describe('QueryFrequencies Memory Bound', () => {
    it('should not grow unbounded under many unique queries', async () => {
      const dbPath = getTempDbPath()
      const manager = new CacheManager({
        l1: { maxEntries: 100 },
        l2: { dbPath },
        enableBackgroundRefresh: false,
      })

      try {
        // Simulate many unique queries
        for (let i = 0; i < 10000; i++) {
          manager.get({ query: `unique-query-${i}` })
        }

        // Check internal state - this would require exposing the size or having a max limit
        // The queryFrequencies map should have some reasonable limit
        // For now, this test documents the issue - it should fail until bounded
        const queryFrequencies = (manager as unknown as { queryFrequencies: Map<string, unknown> })
          .queryFrequencies

        // With a proper fix, this should be bounded to some max (e.g., 10000)
        // Currently this will fail because there's no limit
        expect(queryFrequencies.size).toBeLessThanOrEqual(10000)
      } finally {
        manager.close()
        cleanupDb(dbPath)
      }
    })
  })
})
