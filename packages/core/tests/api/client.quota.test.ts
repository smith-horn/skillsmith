/**
 * API Client — Monthly Quota 429 handling
 * @module tests/api/client.quota.test
 *
 * SMI-4463: Verifies the client distinguishes a monthly-quota-exceeded 429
 * (body `error: 'monthly_quota_exceeded'`) from the per-minute rate-limit
 * 429 (different body shape) and surfaces it as a non-retryable
 * `SkillsmithError` with code `NETWORK_QUOTA_EXCEEDED`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SkillsmithApiClient } from '../../src/api/client.js'
import { SkillsmithError, ErrorCodes } from '../../src/errors.js'

const ORIGINAL_FETCH = globalThis.fetch

function quotaResponseBuilder(body: unknown, status: number = 429): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
}

describe('SMI-4463: monthly_quota_exceeded 429 handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    // Stub on both global and globalThis to cover both module bindings.
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch =
      fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    ;(global as unknown as { fetch: typeof globalThis.fetch }).fetch = ORIGINAL_FETCH
    vi.clearAllMocks()
  })

  it('throws SkillsmithError with NETWORK_QUOTA_EXCEEDED on monthly_quota_exceeded body', async () => {
    const resetsAt = new Date(Date.now() + 5 * 86400000).toISOString()
    const buildResponse = quotaResponseBuilder({
      error: 'monthly_quota_exceeded',
      message: 'Monthly limit reached',
      limit: 1000,
      used: 1000,
      resetsAt,
      tier: 'community',
    })
    fetchMock.mockImplementation(() => Promise.resolve(buildResponse()))

    const client = new SkillsmithApiClient({
      baseUrl: 'https://example.test',
      maxRetries: 1,
      cache: false,
    })
    let caught: unknown
    try {
      await client.search({ query: 'react' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SkillsmithError)
    const e = caught as SkillsmithError
    expect(e.code).toBe(ErrorCodes.NETWORK_QUOTA_EXCEEDED)
    expect(e.message).toContain('Monthly quota reached (1000/1000 community tier)')
    expect(e.message).toContain('Upgrade: https://skillsmith.app/pricing')
    expect(e.details).toMatchObject({
      used: 1000,
      limit: 1000,
      tier: 'community',
      resetsAt,
    })
  })

  it('does NOT retry on monthly_quota_exceeded — single fetch only', async () => {
    const buildResponse = quotaResponseBuilder({
      error: 'monthly_quota_exceeded',
      limit: 1000,
      used: 1000,
      resetsAt: new Date(Date.now() + 86400000).toISOString(),
      tier: 'community',
    })
    fetchMock.mockImplementation(() => Promise.resolve(buildResponse()))

    const client = new SkillsmithApiClient({
      baseUrl: 'https://example.test',
      maxRetries: 5,
      cache: false,
    })
    await client.search({ query: 'react' }).catch(() => undefined)
    // Even with maxRetries=5, the quota error bypasses retry: exactly one call.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('per-minute rate-limit 429 (rate_limit_exceeded body) surfaces as ApiClientError — disambiguator is the body field', async () => {
    // Pre-existing client behavior: all 429s without monthly_quota_exceeded
    // body fall through the 4xx-not-retryable branch as ApiClientError. The
    // important contract for SMI-4463 is that quota errors do NOT collapse
    // into this generic bucket — they get a distinct SkillsmithError code.
    const rl = quotaResponseBuilder({
      error: 'rate_limit_exceeded',
      message: 'Too many requests',
    })
    fetchMock.mockImplementation(() => Promise.resolve(rl()))

    const client = new SkillsmithApiClient({
      baseUrl: 'https://example.test',
      maxRetries: 1,
      cache: false,
    })
    let caught: unknown
    try {
      await client.search({ query: 'react' })
    } catch (err) {
      caught = err
    }
    // Not a SkillsmithError — that's the SMI-4463 disambiguator working.
    expect(caught).toBeDefined()
    expect(caught).not.toBeInstanceOf(SkillsmithError)
    // Distinct error type with the original wire message preserved.
    expect((caught as Error).message).toBe('rate_limit_exceeded')
  })

  it('handles missing optional fields gracefully (no resetsAt) and still emits NETWORK_QUOTA_EXCEEDED', async () => {
    const buildResponse = quotaResponseBuilder({
      error: 'monthly_quota_exceeded',
      limit: 1000,
      used: 1000,
      tier: 'community',
    })
    fetchMock.mockImplementation(() => Promise.resolve(buildResponse()))

    const client = new SkillsmithApiClient({
      baseUrl: 'https://example.test',
      maxRetries: 1,
      cache: false,
    })
    let caught: unknown
    try {
      await client.search({ query: 'react' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SkillsmithError)
    const e = caught as SkillsmithError
    expect(e.code).toBe(ErrorCodes.NETWORK_QUOTA_EXCEEDED)
    expect(e.message).toContain('Monthly quota reached')
    expect(e.message).toContain('Upgrade:')
  })
})
