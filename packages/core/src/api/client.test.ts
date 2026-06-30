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
