/**
 * SMI-2754: API Client Health Check Tests
 *
 * Tests for checkApiHealth function covering all 8 branches:
 * 1. offlineMode: true → synthetic healthy, no fetch
 * 2. fetch succeeds, JSON has version
 * 3. fetch succeeds, JSON missing version → defaults to '1.0.0'
 * 4. fetch succeeds but response.json() throws → inner catch
 * 5. response.ok = false, status >= 500 → 'unhealthy'
 * 6. response.ok = false, status < 500 (e.g. 429) → 'degraded'
 * 7. fetch throws (network error) → outer catch → 'unhealthy'
 * 8. AbortController timeout fires → 'unhealthy'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkApiHealth } from '../../src/api/client.health.js'

const BASE_URL = 'https://api.skillsmith.app'
const ANON_KEY = 'test-anon-key'

describe('checkApiHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns healthy immediately when offlineMode is true without calling fetch', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await checkApiHealth(BASE_URL, ANON_KEY, true)

    expect(result.status).toBe('healthy')
    expect(result.version).toBe('offline')
    expect(typeof result.timestamp).toBe('string')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns healthy with version from JSON when fetch succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', version: '2.1.0' }),
      })
    )

    const result = await checkApiHealth(BASE_URL, ANON_KEY, false)

    expect(result.status).toBe('healthy')
    expect(result.version).toBe('2.1.0')
    expect(typeof result.timestamp).toBe('string')
  })

  it('defaults version to 1.0.0 when JSON body is missing version field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }), // no version property
      })
    )

    const result = await checkApiHealth(BASE_URL, ANON_KEY, false)

    expect(result.status).toBe('healthy')
    expect(result.version).toBe('1.0.0')
  })

  it('returns healthy with 1.0.0 when response.json() throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      })
    )

    const result = await checkApiHealth(BASE_URL, ANON_KEY, false)

    expect(result.status).toBe('healthy')
    expect(result.version).toBe('1.0.0')
  })

  it('returns unhealthy when response is not OK and status >= 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      })
    )

    const result = await checkApiHealth(BASE_URL, ANON_KEY, false)

    expect(result.status).toBe('unhealthy')
    expect(result.version).toBe('unknown')
  })

  it('returns degraded when response is not OK and status < 500 (e.g. 429)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({}),
      })
    )

    const result = await checkApiHealth(BASE_URL, ANON_KEY, false)

    expect(result.status).toBe('degraded')
    expect(result.version).toBe('unknown')
  })

  it('returns unhealthy when fetch throws a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network failure')))

    const result = await checkApiHealth(BASE_URL, ANON_KEY, false)

    expect(result.status).toBe('unhealthy')
    expect(result.version).toBe('unknown')
  })

  it('returns unhealthy when AbortController timeout fires before fetch resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(
        (_url: string, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            if (options?.signal) {
              options.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted')
                err.name = 'AbortError'
                reject(err)
              })
            }
          })
      )
    )

    const promise = checkApiHealth(BASE_URL, ANON_KEY, false)
    // Advance past the 5000ms timeout
    vi.advanceTimersByTime(6000)
    const result = await promise

    expect(result.status).toBe('unhealthy')
    expect(result.version).toBe('unknown')
  })
})
