/**
 * SMI-4120: Client LRU cache integration tests.
 *
 * Covers the wiring in client.ts + client.cache.ts — hits, misses, per-call
 * no-store, env kill-switch, and stable cache key for getRecommendations.
 *
 * SMI-6796: Closes three gaps — order-dependent env teardown, untested TTL
 * expiry, and untested eviction-at-maxEntries behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SkillsmithApiClient } from '../../src/api/client.js'
import { ApiCache, DEFAULT_TTL } from '../../src/api/cache.js'

const SAMPLE_SEARCH_RESPONSE = {
  data: [
    {
      id: 'a/one',
      name: 'one',
      description: null,
      author: 'a',
      quality_score: 0.9,
      trust_tier: 'verified',
      tags: [],
    },
  ],
  meta: { total: 1, limit: 20, offset: 0, query: 'go' },
}

const SAMPLE_SKILL_RESPONSE = {
  data: {
    id: 'a/one',
    name: 'one',
    description: null,
    author: 'a',
    quality_score: 0.9,
    trust_tier: 'verified',
    tags: [],
  },
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('SMI-4120: Client response cache', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let prevDisableCache: string | undefined

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    // SMI-6796: Snapshot whatever the environment held BEFORE this test ran
    // (absent, or inherited from the shell) so afterEach can restore that
    // exact prior state instead of unconditionally deleting it.
    prevDisableCache = process.env.SKILLSMITH_DISABLE_CLIENT_CACHE
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    // SMI-6796: Restore the PRIOR value rather than always deleting. An
    // unconditional `delete` here destroys a value inherited from the
    // environment on the very first test that runs, and every later test in
    // this file then runs as if the variable had never been set — an
    // order-dependent teardown. Restoring exactly what this test observed on
    // entry keeps every test's teardown independent of run order.
    if (prevDisableCache === undefined) {
      delete process.env.SKILLSMITH_DISABLE_CLIENT_CACHE
    } else {
      process.env.SKILLSMITH_DISABLE_CLIENT_CACHE = prevDisableCache
    }
  })

  it('serves second identical search from cache', async () => {
    fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SEARCH_RESPONSE))
    const client = new SkillsmithApiClient({ baseUrl: 'http://x' })

    const first = await client.search({ query: 'go' })
    const second = await client.search({ query: 'go' })

    expect(first).toEqual(second)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('different queries miss cache independently', async () => {
    fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SEARCH_RESPONSE))
    const client = new SkillsmithApiClient({ baseUrl: 'http://x' })

    await client.search({ query: 'go' })
    await client.search({ query: 'rust' })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('per-call { cache: "no-store" } bypasses both read and write', async () => {
    fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SEARCH_RESPONSE))
    const client = new SkillsmithApiClient({ baseUrl: 'http://x' })

    await client.search({ query: 'go' }, { cache: 'no-store' })
    await client.search({ query: 'go' }, { cache: 'no-store' })
    await client.search({ query: 'go' })

    // Two no-store calls + one cacheable miss = 3 fetches
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    // Cache should now hold the cacheable one
    const cached = await client.search({ query: 'go' })
    expect(cached).toEqual(SAMPLE_SEARCH_RESPONSE)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('SKILLSMITH_DISABLE_CLIENT_CACHE=1 disables cache entirely', async () => {
    process.env.SKILLSMITH_DISABLE_CLIENT_CACHE = '1'
    fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SEARCH_RESPONSE))
    const client = new SkillsmithApiClient({ baseUrl: 'http://x' })

    expect(client.getResponseCache()).toBeNull()

    await client.search({ query: 'go' })
    await client.search({ query: 'go' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('config.cache = false disables cache', async () => {
    fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SEARCH_RESPONSE))
    const client = new SkillsmithApiClient({ baseUrl: 'http://x', cache: false })

    expect(client.getResponseCache()).toBeNull()
    await client.search({ query: 'go' })
    await client.search({ query: 'go' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('accepts an externally-provided ApiCache instance', async () => {
    const external = new ApiCache({ enableStats: true })
    fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SEARCH_RESPONSE))
    const client = new SkillsmithApiClient({ baseUrl: 'http://x', cache: external })

    expect(client.getResponseCache()).toBe(external)
    await client.search({ query: 'go' })
    await client.search({ query: 'go' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(external.getStats().hits).toBe(1)
  })

  it('getSkill caches independently per id', async () => {
    fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SKILL_RESPONSE))
    const client = new SkillsmithApiClient({ baseUrl: 'http://x' })

    await client.getSkill('a/one')
    await client.getSkill('a/one')
    await client.getSkill('b/two')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('getRecommendations cache key is stable across stack order', async () => {
    fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SEARCH_RESPONSE))
    const client = new SkillsmithApiClient({ baseUrl: 'http://x' })

    await client.getRecommendations({ stack: ['go', 'rust'] })
    await client.getRecommendations({ stack: ['rust', 'go'] })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('getSkill per-call no-store bypasses cache', async () => {
    fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SKILL_RESPONSE))
    const client = new SkillsmithApiClient({ baseUrl: 'http://x' })

    await client.getSkill('a/one')
    await client.getSkill('a/one', { cache: 'no-store' })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  // SMI-6796: TTL expiry was untested anywhere in the repo — deleting
  // ApiCache.get()'s `Date.now() > entry.expiresAt` check left no failing
  // assertion. vitest's fake timers do NOT patch `node:timers/promises`, and
  // `vi.getTimerCount()` reads 0 while a pending `delay()` is outstanding —
  // but they DO give a frozen, freely-movable `Date.now()`, which is exactly
  // the mechanism cache.ts's expiry check reads. So these tests move the
  // mocked clock with `vi.setSystemTime()` (which does not fire any pending
  // timer callbacks — see ApiCache.get()'s own timeout/abort machinery in
  // client.ts, which is never triggered by this) and assert on cache
  // behavior, never on elapsed wall-clock time or a duration threshold.
  describe('TTL expiry', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('ApiCache.get() stops serving an entry once Date.now() passes its expiresAt', () => {
      vi.useFakeTimers()
      const cache = new ApiCache({ defaultTtl: 1000 })
      cache.set('k', 'v')

      // One millisecond before expiresAt: Date.now() > entry.expiresAt is
      // false, so the entry is still served.
      vi.setSystemTime(Date.now() + 999)
      expect(cache.get<string>('k')).toBe('v')

      // Two milliseconds later Date.now() > entry.expiresAt now holds: the
      // entry is treated as a miss and removed from the cache.
      vi.setSystemTime(Date.now() + 2)
      expect(cache.get<string>('k')).toBeUndefined()
      expect(cache.has('k')).toBe(false)
    })

    it('an expired search response is not served from the client cache — it re-fetches', async () => {
      vi.useFakeTimers()
      fetchSpy.mockImplementation(async () => mockJsonResponse(SAMPLE_SEARCH_RESPONSE))
      const client = new SkillsmithApiClient({ baseUrl: 'http://x' })

      await client.search({ query: 'go' })
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Still inside the search TTL (DEFAULT_TTL.search, 1 hour): served
      // from cache, no second fetch.
      vi.setSystemTime(Date.now() + DEFAULT_TTL.search - 1)
      await client.search({ query: 'go' })
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // One millisecond past the TTL: the cached entry is now expired and a
      // fresh fetch is required. Without the expiry check in
      // ApiCache.get(), this would still be served from cache and the
      // fetch count would stay at 1 forever.
      vi.setSystemTime(Date.now() + 2)
      await client.search({ query: 'go' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })

  // SMI-6796: evictLeastUsed() evicts the entry with the lowest hitCount,
  // which is NOT least-recently-used despite the method's name — pin that
  // actual behavior, not the name.
  describe('eviction at maxEntries', () => {
    it('evicts the lowest-hitCount entry, not the least-recently-used one', () => {
      const cache = new ApiCache({ maxEntries: 2, enableStats: true })
      cache.set('a', 'A')
      cache.set('b', 'B')

      // Rack up hits on 'a' ...
      cache.get('a')
      cache.get('a')
      cache.get('a')

      // ... then touch 'b' LAST, so 'b' is the most-recently-used entry
      // while still holding the lowest hitCount (1 vs 3). A true LRU policy
      // would evict 'a' (the least recently touched); evictLeastUsed()
      // evicts by lowest hitCount instead, so 'b' goes despite being the
      // most recently accessed.
      cache.get('b')

      cache.set('c', 'C') // size (2) >= maxEntries (2): triggers eviction

      expect(cache.has('b')).toBe(false) // lowest hitCount (1) — evicted
      expect(cache.has('a')).toBe(true) // higher hitCount (3) — kept
      expect(cache.has('c')).toBe(true) // just inserted
      expect(cache.getStats().evictions).toBe(1)
    })
  })
})
