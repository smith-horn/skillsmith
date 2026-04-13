/**
 * SMI-4120: Client LRU cache integration tests.
 *
 * Covers the wiring in client.ts + client.cache.ts — hits, misses, per-call
 * no-store, env kill-switch, and stable cache key for getRecommendations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SkillsmithApiClient } from '../../src/api/client.js'
import { ApiCache } from '../../src/api/cache.js'

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

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    delete process.env.SKILLSMITH_DISABLE_CLIENT_CACHE
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
})
