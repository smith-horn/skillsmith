/**
 * SMI-2756: Wave 3 — CacheManager tests
 *
 * CacheManager uses an async factory pattern (CacheManager.create(config)).
 * Tests cover: create/close lifecycle, get/set/has/delete, invalidateAll,
 * onInvalidate listener, getStats shape, and generateKey/parseKey symmetry.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { CacheManager } from '../src/cache/CacheManager.js'

describe('CacheManager', () => {
  let manager: CacheManager

  afterEach(() => {
    try {
      manager?.close()
    } catch {
      // already closed
    }
  })

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('returns a CacheManager instance', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      expect(manager).toBeDefined()
      expect(typeof manager.get).toBe('function')
    })

    it('constructor always throws (use create instead)', () => {
      expect(() => new CacheManager()).toThrow(/Cannot construct synchronously/)
    })
  })

  // -------------------------------------------------------------------------
  // get / set / has / delete
  // -------------------------------------------------------------------------

  describe('get / set / has / delete', () => {
    it('returns undefined for a cache miss', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      const result = manager.get({ query: 'missing' })
      expect(result).toBeUndefined()
    })

    it('stores and retrieves results', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      const opts = { query: 'typescript', limit: 10 }
      const fakeResults = [{ id: '1', name: 'TypeScript Skill', score: 0.9 }]

      manager.set(opts, fakeResults as never, 1)
      const cached = manager.get(opts)

      expect(cached).toBeDefined()
      expect(cached?.totalCount).toBe(1)
    })

    it('has returns true after set', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      const opts = { query: 'react' }

      manager.set(opts, [], 0)

      expect(manager.has(opts)).toBe(true)
    })

    it('delete removes the entry', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      const opts = { query: 'python' }

      manager.set(opts, [], 0)
      expect(manager.has(opts)).toBe(true)

      manager.delete(opts)
      expect(manager.has(opts)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // invalidateAll
  // -------------------------------------------------------------------------

  describe('invalidateAll', () => {
    it('clears all cached entries', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      manager.set({ query: 'a' }, [], 0)
      manager.set({ query: 'b' }, [], 0)

      manager.invalidateAll()

      expect(manager.has({ query: 'a' })).toBe(false)
      expect(manager.has({ query: 'b' })).toBe(false)
    })

    it('fires registered onInvalidate listeners', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      let callCount = 0
      manager.onInvalidate(() => {
        callCount++
      })
      manager.onInvalidate(() => {
        callCount++
      })

      manager.invalidateAll()

      expect(callCount).toBe(2)
    })

    it('onInvalidate unsubscribe prevents future calls', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      let callCount = 0
      const unsubscribe = manager.onInvalidate(() => {
        callCount++
      })

      unsubscribe()
      manager.invalidateAll()

      expect(callCount).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // getStats
  // -------------------------------------------------------------------------

  describe('getStats', () => {
    it('returns stats with expected shape', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      const stats = manager.getStats()

      expect(typeof stats.totalHits).toBe('number')
      expect(typeof stats.totalMisses).toBe('number')
      expect(stats.queryFrequencies).toBeDefined()
      expect(typeof stats.queryFrequencies.popular).toBe('number')
      expect(typeof stats.queryFrequencies.standard).toBe('number')
      expect(typeof stats.queryFrequencies.rare).toBe('number')
      expect(stats.backgroundRefresh).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // generateKey / parseKey
  // -------------------------------------------------------------------------

  describe('generateKey / parseKey', () => {
    it('generates a stable key for the same options', () => {
      const key1 = CacheManager.generateKey({ query: 'test', limit: 20 })
      const key2 = CacheManager.generateKey({ query: 'test', limit: 20 })
      expect(key1).toBe(key2)
    })

    it('normalises query case in the key', () => {
      const key1 = CacheManager.generateKey({ query: 'TypeScript' })
      const key2 = CacheManager.generateKey({ query: 'typescript' })
      expect(key1).toBe(key2)
    })

    it('parseKey returns null for non-matching string', () => {
      expect(CacheManager.parseKey('not-a-cache-key')).toBeNull()
    })

    it('parseKey round-trips a generated key', () => {
      const opts = { query: 'vitest', filters: { tier: 'verified' }, limit: 10, offset: 0 }
      const key = CacheManager.generateKey(opts)
      const parsed = CacheManager.parseKey(key)

      expect(parsed).not.toBeNull()
      expect(parsed?.query).toBe('vitest')
      expect(parsed?.limit).toBe(10)
      expect(parsed?.offset).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // getOrCompute
  // -------------------------------------------------------------------------

  describe('getOrCompute', () => {
    it('calls compute only once for the same key on cache miss then hit', async () => {
      manager = await CacheManager.create({ enableBackgroundRefresh: false })
      let callCount = 0
      const compute = async () => {
        callCount++
        return { results: [], totalCount: 0 }
      }

      const opts = { query: 'dedupe-test' }
      await manager.getOrCompute(opts, compute)
      await manager.getOrCompute(opts, compute)

      // compute should only be called on the first miss
      expect(callCount).toBe(1)
    })
  })
})
