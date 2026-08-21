/**
 * license-status-client tests (SMI-6098, umbrella SMI-6085).
 *
 * Mirrors audit-notify-client.test.ts's mock shape (token-credentials leaf
 * module + global fetch).
 *
 * UC-1: no credentials -> SessionTierAuthError, no fetch.
 * UC-2: expired credentials -> refresh path runs, new token used.
 * UC-3: 200 authenticated:true/false bodies returned verbatim.
 * UC-4: 429/5xx -> SessionTierTransientError.
 * UC-5: network throw / unreadable / malformed body -> SessionTierTransientError.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/token-credentials.js', () => ({
  loadCredentials: vi.fn(),
  refreshAccessToken: vi.fn(),
  storeCredentials: vi.fn(),
}))

import {
  loadCredentials,
  refreshAccessToken,
  storeCredentials,
} from '../config/token-credentials.js'
import {
  resolveSessionTier,
  SessionTierAuthError,
  SessionTierTransientError,
} from './license-status-client.js'

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const futureCreds = {
  accessToken: 'at_valid',
  refreshToken: 'rt_valid',
  expiresAt: Date.now() + 3_600_000,
  version: 2 as const,
}

describe('license-status-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('UC-1: throws SessionTierAuthError when no credentials are stored — no fetch', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(null)
    await expect(resolveSessionTier()).rejects.toBeInstanceOf(SessionTierAuthError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('UC-2: refreshes an about-to-expire token and sends with the new token', async () => {
    vi.mocked(loadCredentials).mockResolvedValue({
      ...futureCreds,
      accessToken: 'at_stale',
      expiresAt: Date.now() + 1_000, // within the 60s skew -> refresh
    })
    vi.mocked(refreshAccessToken).mockResolvedValue({ ...futureCreds, accessToken: 'at_fresh' })
    fetchMock.mockResolvedValue(
      jsonResponse(
        { data: { authenticated: true, tier: 'team', rateLimit: 120, userId: 'u1' } },
        200
      )
    )

    const res = await resolveSessionTier()

    expect(res).toEqual({ authenticated: true, tier: 'team', rateLimit: 120, userId: 'u1' })
    expect(storeCredentials).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at_fresh')
  })

  it('UC-3a: 200 authenticated:true -> returned verbatim', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(
      jsonResponse(
        { data: { authenticated: true, tier: 'enterprise', rateLimit: 1000, userId: 'u2' } },
        200
      )
    )
    await expect(resolveSessionTier()).resolves.toEqual({
      authenticated: true,
      tier: 'enterprise',
      rateLimit: 1000,
      userId: 'u2',
    })
  })

  it('UC-3b: 200 authenticated:false -> returned verbatim (definitive, not thrown)', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ data: { authenticated: false } }, 200))
    await expect(resolveSessionTier()).resolves.toEqual({ authenticated: false })
  })

  it('UC-4a: HTTP 429 -> SessionTierTransientError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({}, 429))
    await expect(resolveSessionTier()).rejects.toBeInstanceOf(SessionTierTransientError)
  })

  it('UC-4b: HTTP 500 -> SessionTierTransientError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    await expect(resolveSessionTier()).rejects.toBeInstanceOf(SessionTierTransientError)
  })

  it('UC-5a: fetch throws (network error) -> SessionTierTransientError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    await expect(resolveSessionTier()).rejects.toBeInstanceOf(SessionTierTransientError)
  })

  it('UC-5b: unreadable body -> SessionTierTransientError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(resolveSessionTier()).rejects.toBeInstanceOf(SessionTierTransientError)
  })

  it('UC-5c: 200 with an unexpected/missing data shape -> SessionTierTransientError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ nope: true }, 200))
    await expect(resolveSessionTier()).rejects.toBeInstanceOf(SessionTierTransientError)
  })

  it('UC-5d: authenticated:true with a missing tier -> SessionTierTransientError, never a silent community result', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ data: { authenticated: true } }, 200))
    await expect(resolveSessionTier()).rejects.toBeInstanceOf(SessionTierTransientError)
  })

  it('UC-5e: authenticated:true with an unrecognized tier -> SessionTierTransientError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { authenticated: true, tier: 'platinum' } }, 200)
    )
    await expect(resolveSessionTier()).rejects.toBeInstanceOf(SessionTierTransientError)
  })

  it('UC-6a: the request carries an AbortSignal (timeout wiring present)', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ data: { authenticated: false } }, 200))
    await resolveSessionTier()
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('UC-6b: a stalled request is aborted after the timeout and reported as transient', async () => {
    vi.useFakeTimers()
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal
          signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.')
            err.name = 'AbortError'
            reject(err)
          })
        })
    )

    const promise = resolveSessionTier()
    const assertion = expect(promise).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    vi.useRealTimers()
  })
})
