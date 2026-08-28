/**
 * API Client — search() URL parameter tests
 *
 * SMI-5427: Verifies that safe_only and max_risk query params are forwarded
 * to the skills-search edge function when the corresponding SearchOptions
 * fields are set, and are omitted when they are not set.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SkillsmithApiClient } from './client.js'

const ORIGINAL_FETCH = globalThis.fetch

/** Build a minimal valid search response matching SearchResponseSchema. */
function makeSearchResponse(items: unknown[] = []): Response {
  return new Response(
    JSON.stringify({
      data: items,
      meta: { total: items.length, limit: 20, offset: 0 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

describe('SMI-5427: ApiClient.search() URL parameter forwarding', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let capturedUrl: string

  beforeEach(() => {
    capturedUrl = ''
    fetchMock = vi.fn((url: string) => {
      capturedUrl = url
      return Promise.resolve(makeSearchResponse())
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch =
      fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch = ORIGINAL_FETCH
    vi.clearAllMocks()
  })

  it('omits safe_only when safeOnly is not set', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test' })
    expect(capturedUrl).not.toContain('safe_only')
  })

  it('omits safe_only when safeOnly is false', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test', safeOnly: false })
    expect(capturedUrl).not.toContain('safe_only')
  })

  it('sends safe_only=true when safeOnly is true', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test', safeOnly: true })
    expect(capturedUrl).toContain('safe_only=true')
  })

  it('omits max_risk when maxRiskScore is undefined', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test' })
    expect(capturedUrl).not.toContain('max_risk')
  })

  it('sends max_risk when maxRiskScore is set to 0', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test', maxRiskScore: 0 })
    expect(capturedUrl).toContain('max_risk=0')
  })

  it('sends max_risk with correct value when maxRiskScore is set', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test', maxRiskScore: 30 })
    expect(capturedUrl).toContain('max_risk=30')
  })

  it('sends both safe_only and max_risk when both options are set', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'security', safeOnly: true, maxRiskScore: 25 })
    expect(capturedUrl).toContain('safe_only=true')
    expect(capturedUrl).toContain('max_risk=25')
  })

  it('still includes standard params alongside security filters', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'auth', limit: 5, safeOnly: true, maxRiskScore: 50 })
    expect(capturedUrl).toContain('query=auth')
    expect(capturedUrl).toContain('limit=5')
    expect(capturedUrl).toContain('safe_only=true')
    expect(capturedUrl).toContain('max_risk=50')
  })
})

describe('SMI-5929: ApiClient.search() compatibility param forwarding', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let capturedUrl: string

  beforeEach(() => {
    capturedUrl = ''
    fetchMock = vi.fn((url: string) => {
      capturedUrl = url
      return Promise.resolve(makeSearchResponse())
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch =
      fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch = ORIGINAL_FETCH
    vi.clearAllMocks()
  })

  it('omits compatibility when not set', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test' })
    expect(capturedUrl).not.toContain('compatibility')
  })

  it('omits compatibility when the array is empty', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test', compatibility: [] })
    expect(capturedUrl).not.toContain('compatibility')
  })

  it('sends a single slug', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test', compatibility: ['cursor'] })
    expect(capturedUrl).toContain('compatibility=cursor')
  })

  it('sends multiple slugs as CSV', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.search({ query: 'test', compatibility: ['cursor', 'claude-code'] })
    expect(capturedUrl).toContain(encodeURIComponent('cursor,claude-code'))
  })
})

/** Build a minimal valid registry-sync response matching SearchResponseSchema. */
function makeRegistrySyncResponse(items: unknown[] = []): Response {
  return new Response(
    JSON.stringify({
      data: items,
      meta: { limit: 100, offset: 0, since: null },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

/** Build a minimal valid stats response matching StatsResponseSchema. */
function makeStatsResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      data: {
        skillCount: 42,
        githubTotal: 100,
        lastUpdated: '2026-08-26T00:00:00.000Z',
        ...overrides,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

function makeErrorResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('ApiClient.syncRegistry() URL parameter forwarding', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let capturedUrl: string

  beforeEach(() => {
    capturedUrl = ''
    fetchMock = vi.fn((url: string) => {
      capturedUrl = url
      return Promise.resolve(makeRegistrySyncResponse())
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch =
      fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch = ORIGINAL_FETCH
    vi.clearAllMocks()
  })

  it('calls the /registry-sync endpoint', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.syncRegistry()
    expect(capturedUrl).toContain('/registry-sync?')
  })

  it('omits limit, offset, and since when no options are passed', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.syncRegistry()
    expect(capturedUrl).not.toContain('limit=')
    expect(capturedUrl).not.toContain('offset=')
    expect(capturedUrl).not.toContain('since=')
  })

  it('sends limit when provided', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.syncRegistry({ limit: 50 })
    expect(capturedUrl).toContain('limit=50')
  })

  it('sends offset when provided', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.syncRegistry({ offset: 200 })
    expect(capturedUrl).toContain('offset=200')
  })

  it('sends since when provided', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.syncRegistry({ since: '2026-08-01T00:00:00.000Z' })
    expect(capturedUrl).toContain(`since=${encodeURIComponent('2026-08-01T00:00:00.000Z')}`)
  })

  it('sends all three params together', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.syncRegistry({ limit: 25, offset: 75, since: '2026-08-01T00:00:00.000Z' })
    expect(capturedUrl).toContain('limit=25')
    expect(capturedUrl).toContain('offset=75')
    expect(capturedUrl).toContain(`since=${encodeURIComponent('2026-08-01T00:00:00.000Z')}`)
  })
})

describe('ApiClient.syncRegistry() response handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch =
      fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch = ORIGINAL_FETCH
    vi.clearAllMocks()
  })

  it('parses a successful response including registry-sync-only fields', async () => {
    const row = {
      id: 'skill-1',
      name: 'commit',
      description: 'A commit skill',
      author: 'anthropic',
      repo_url: 'https://github.com/anthropic/commit',
      quality_score: 90,
      trust_tier: 'verified',
      tags: ['git'],
      quarantined: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    }
    fetchMock.mockImplementation(() => Promise.resolve(makeRegistrySyncResponse([row])))

    const client = new SkillsmithApiClient({ offlineMode: false, cache: false })
    const result = await client.syncRegistry({ limit: 10 })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toMatchObject({
      id: 'skill-1',
      name: 'commit',
      quarantined: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    })
  })

  it('surfaces a 403 tier_not_entitled error as a non-retryable ApiClientError', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        makeErrorResponse(
          {
            error: 'Registry sync requires a Team or Enterprise subscription',
            details: { code: 'tier_not_entitled', currentTier: 'community' },
          },
          403
        )
      )
    )

    const client = new SkillsmithApiClient({ offlineMode: false, cache: false, maxRetries: 1 })
    let caught: unknown
    try {
      await client.syncRegistry()
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(
      'Registry sync requires a Team or Enterprise subscription'
    )
    // Non-retryable 4xx — exactly one fetch call.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('ApiClient.getStats()', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let capturedUrl: string

  beforeEach(() => {
    capturedUrl = ''
    fetchMock = vi.fn((url: string) => {
      capturedUrl = url
      return Promise.resolve(makeStatsResponse())
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch =
      fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch = ORIGINAL_FETCH
    vi.clearAllMocks()
  })

  it('calls the /stats endpoint with no query params', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false })
    await client.getStats()
    expect(capturedUrl).toContain('/stats')
    expect(capturedUrl).not.toContain('detailed')
  })

  it('parses a successful response', async () => {
    const client = new SkillsmithApiClient({ offlineMode: false, cache: false })
    const result = await client.getStats()
    expect(result.data).toEqual({
      skillCount: 42,
      githubTotal: 100,
      lastUpdated: '2026-08-26T00:00:00.000Z',
    })
  })

  it('surfaces a 500 server error as an ApiClientError', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeErrorResponse({ error: 'Failed to retrieve stats' }, 500))
    )

    const client = new SkillsmithApiClient({ offlineMode: false, cache: false, maxRetries: 0 })
    let caught: unknown
    try {
      await client.getStats()
    } catch (err) {
      caught = err
    }

    // 5xx responses are retryable, so request() reports the generic
    // "Server error: <status>" message rather than the body's `error` field
    // (which is only surfaced for non-retryable 4xx — see the 403 test above).
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('Server error: 500')
  })
})
