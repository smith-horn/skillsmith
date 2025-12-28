/**
 * Tests for CacheService and TTLManager (SMI-630)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CacheService, TTLManager, CacheType } from '../src/cache/index.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('TTLManager', () => {
  let ttlManager: TTLManager

  beforeEach(() => {
    ttlManager = new TTLManager()
  })

  describe('default TTL values', () => {
    it('should have 1 hour TTL for search results', () => {
      expect(ttlManager.getTTL(CacheType.SEARCH_RESULTS)).toBe(3600)
    })

    it('should have 24 hour TTL for skill details', () => {
      expect(ttlManager.getTTL(CacheType.SKILL_DETAILS)).toBe(86400)
    })

    it('should have 4 hour TTL for popular queries', () => {
      expect(ttlManager.getTTL(CacheType.POPULAR_QUERIES)).toBe(14400)
    })

    it('should have 30 minute TTL for suggestions', () => {
      expect(ttlManager.getTTL(CacheType.SUGGESTIONS)).toBe(1800)
    })

    it('should have 2 hour TTL for similar skills', () => {
      expect(ttlManager.getTTL(CacheType.SIMILAR_SKILLS)).toBe(7200)
    })
  })

  describe('TTL overrides', () => {
    it('should accept TTL overrides in constructor', () => {
      const customManager = new TTLManager({
        [CacheType.SEARCH_RESULTS]: { ttl: 7200 }, // 2 hours
      })

      expect(customManager.getTTL(CacheType.SEARCH_RESULTS)).toBe(7200)
      // Other values should remain default
      expect(customManager.getTTL(CacheType.SKILL_DETAILS)).toBe(86400)
    })

    it('should update config at runtime', () => {
      ttlManager.updateConfig(CacheType.SEARCH_RESULTS, { ttl: 1800 })
      expect(ttlManager.getTTL(CacheType.SEARCH_RESULTS)).toBe(1800)
    })
  })

  describe('expiration checking', () => {
    it('should correctly identify expired entries', () => {
      const oneHourAgo = Date.now() - 3600 * 1000 - 1000 // 1 hour + 1 second ago
      expect(ttlManager.isExpired(CacheType.SEARCH_RESULTS, oneHourAgo)).toBe(true)
    })

    it('should correctly identify non-expired entries', () => {
      const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000 // 30 minutes ago
      expect(ttlManager.isExpired(CacheType.SEARCH_RESULTS, thirtyMinutesAgo)).toBe(false)
    })

    it('should calculate correct expiration time', () => {
      const now = Date.now()
      const expiresAt = ttlManager.getExpirationTime(CacheType.SEARCH_RESULTS)

      // Should be approximately 1 hour from now
      expect(expiresAt).toBeGreaterThan(now + 3599 * 1000)
      expect(expiresAt).toBeLessThan(now + 3601 * 1000)
    })
  })

  describe('L2 persistence settings', () => {
    it('should persist search results to L2', () => {
      expect(ttlManager.shouldPersistToL2(CacheType.SEARCH_RESULTS)).toBe(true)
    })

    it('should not persist suggestions to L2', () => {
      expect(ttlManager.shouldPersistToL2(CacheType.SUGGESTIONS)).toBe(false)
    })
  })

  describe('custom key TTLs', () => {
    it('should allow custom TTL for key patterns', () => {
      ttlManager.setCustomTTL('user:', { ttl: 60, persistToL2: false })

      expect(ttlManager.getTTLForKey('user:123')).toBe(60)
      expect(ttlManager.getTTLForKey('search:test')).toBe(3600) // falls back to CUSTOM default
    })
  })

  describe('getAllConfigs', () => {
    it('should return all config entries', () => {
      const configs = ttlManager.getAllConfigs()

      expect(configs).toHaveProperty(CacheType.SEARCH_RESULTS)
      expect(configs).toHaveProperty(CacheType.SKILL_DETAILS)
      expect(configs).toHaveProperty(CacheType.POPULAR_QUERIES)
    })
  })
})

describe('CacheService', () => {
  let cacheService: CacheService
  let dbPath: string

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), 'test-cacheservice-' + Date.now() + '.db')
    cacheService = new CacheService({
      l1MaxSize: 10,
      l2Options: { dbPath, ttlSeconds: 3600 },
    })
  })

  afterEach(() => {
    cacheService.close()
    try {
      fs.unlinkSync(dbPath)
    } catch {
      // File may not exist
    }
  })

  describe('search results caching', () => {
    it('should cache and retrieve search results', () => {
      const results = [
        { id: '1', name: 'test-skill', description: 'A test', score: 0.9, source: 'github' },
      ]

      cacheService.setSearchResults('react', { source: 'github' }, results, 1)
      const cached = cacheService.getSearchResults('react', { source: 'github' })

      expect(cached).toBeDefined()
      expect(cached?.results).toEqual(results)
      expect(cached?.totalCount).toBe(1)
    })

    it('should return undefined for cache miss', () => {
      const cached = cacheService.getSearchResults('nonexistent', {})
      expect(cached).toBeUndefined()
    })

    it('should track hit/miss statistics', () => {
      const results = [{ id: '1', name: 'test', description: '', score: 0.5, source: 'test' }]

      // Miss
      cacheService.getSearchResults('miss', {})

      // Set
      cacheService.setSearchResults('hit', {}, results, 1)

      // Hit
      cacheService.getSearchResults('hit', {})
      cacheService.getSearchResults('hit', {})

      const stats = cacheService.getStats()
      expect(stats.l1.hits).toBe(2)
      expect(stats.l1.misses).toBe(1)
    })
  })

  describe('skill details caching', () => {
    it('should cache and retrieve skill details', () => {
      const details = { id: 'skill-1', name: 'Test Skill', version: '1.0.0' }

      cacheService.setSkillDetails('skill-1', details)
      const cached = cacheService.getSkillDetails<typeof details>('skill-1')

      expect(cached).toBeDefined()
    })
  })

  describe('popular queries caching', () => {
    it('should cache and retrieve popular queries', () => {
      const queries = ['react', 'typescript', 'testing']

      cacheService.setPopularQueries(queries)
      const cached = cacheService.getPopularQueries()

      expect(cached).toBeDefined()
    })
  })

  describe('cache invalidation', () => {
    it('should invalidate all entries', () => {
      const results = [{ id: '1', name: 'test', description: '', score: 0.5, source: 'test' }]

      cacheService.setSearchResults('query1', {}, results, 1)
      cacheService.setSearchResults('query2', {}, results, 1)

      expect(cacheService.has('search:query1:{}')).toBe(true)

      cacheService.invalidateAll()

      expect(cacheService.getSearchResults('query1', {})).toBeUndefined()
      expect(cacheService.getSearchResults('query2', {})).toBeUndefined()
    })

    it('should invalidate entries by type', () => {
      const results = [{ id: '1', name: 'test', description: '', score: 0.5, source: 'test' }]

      cacheService.setSearchResults('query', {}, results, 1)
      cacheService.setPopularQueries(['react'])

      cacheService.invalidateByType(CacheType.SEARCH_RESULTS)

      expect(cacheService.getSearchResults('query', {})).toBeUndefined()
      expect(cacheService.getPopularQueries()).toBeDefined()
    })

    it('should delete specific entries', () => {
      const results = [{ id: '1', name: 'test', description: '', score: 0.5, source: 'test' }]

      cacheService.setSearchResults('query', {}, results, 1)

      const deleted = cacheService.delete('search:query:{}')

      expect(deleted).toBe(true)
      expect(cacheService.getSearchResults('query', {})).toBeUndefined()
    })
  })

  describe('TTL expiration', () => {
    it('should expire entries based on TTL', () => {
      vi.useFakeTimers()

      const results = [{ id: '1', name: 'test', description: '', score: 0.5, source: 'test' }]

      cacheService.setSearchResults('query', {}, results, 1)
      expect(cacheService.getSearchResults('query', {})).toBeDefined()

      // Advance time by 1 hour + 1 second
      vi.advanceTimersByTime(3601 * 1000)

      expect(cacheService.getSearchResults('query', {})).toBeUndefined()

      vi.useRealTimers()
    })
  })

  describe('pruning', () => {
    it('should prune expired entries', () => {
      vi.useFakeTimers()

      const results = [{ id: '1', name: 'test', description: '', score: 0.5, source: 'test' }]

      cacheService.setSearchResults('query', {}, results, 1)

      // Advance time past TTL
      vi.advanceTimersByTime(3601 * 1000)

      const pruned = cacheService.prune()
      expect(pruned).toBeGreaterThan(0)

      vi.useRealTimers()
    })
  })

  describe('LRU eviction', () => {
    it('should evict least recently used entries when L1 is full', () => {
      const smallCache = new CacheService({
        l1MaxSize: 3,
      })

      // Fill cache beyond capacity
      for (let i = 0; i < 5; i++) {
        smallCache.set(`key${i}`, { value: i }, CacheType.CUSTOM)
      }

      const stats = smallCache.getStats()
      expect(stats.l1.size).toBeLessThanOrEqual(3)
    })
  })

  describe('statistics', () => {
    it('should return comprehensive stats', () => {
      const stats = cacheService.getStats()

      expect(stats).toHaveProperty('l1')
      expect(stats).toHaveProperty('l2')
      expect(stats).toHaveProperty('ttlConfigs')

      expect(stats.l1).toHaveProperty('hits')
      expect(stats.l1).toHaveProperty('misses')
      expect(stats.l1).toHaveProperty('hitRate')
      expect(stats.l1).toHaveProperty('size')

      expect(stats.ttlConfigs).toHaveProperty(CacheType.SEARCH_RESULTS)
    })
  })

  describe('TTL manager access', () => {
    it('should provide access to TTL manager', () => {
      const ttlManager = cacheService.getTTLManager()
      expect(ttlManager).toBeInstanceOf(TTLManager)
    })

    it('should allow TTL configuration changes', () => {
      const ttlManager = cacheService.getTTLManager()
      ttlManager.updateConfig(CacheType.SEARCH_RESULTS, { ttl: 7200 })

      expect(ttlManager.getTTL(CacheType.SEARCH_RESULTS)).toBe(7200)
    })
  })
})

describe('CacheService without L2', () => {
  let cacheService: CacheService

  beforeEach(() => {
    cacheService = new CacheService({
      l1MaxSize: 10,
      // No L2 options - L1 only mode
    })
  })

  it('should work with L1 only', () => {
    const results = [{ id: '1', name: 'test', description: '', score: 0.5, source: 'test' }]

    cacheService.setSearchResults('query', {}, results, 1)
    const cached = cacheService.getSearchResults('query', {})

    expect(cached).toBeDefined()
    expect(cached?.results).toEqual(results)
  })

  it('should report null for L2 stats', () => {
    const stats = cacheService.getStats()
    expect(stats.l2).toBeNull()
  })
})
