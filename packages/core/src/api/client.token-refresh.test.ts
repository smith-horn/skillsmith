/**
 * client.token-refresh tests (SMI-4402)
 * TR-1: tryRefreshToken — succeeds when credentials exist and refresh succeeds
 * TR-2: tryRefreshToken — returns null when loadCredentials returns null
 * TR-3: tryRefreshToken — returns null when refreshAccessToken returns null
 * TR-4: loadStoredAccessToken — returns accessToken when credentials exist
 * TR-5: loadStoredAccessToken — returns null when no credentials stored
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config/token-credentials.js', () => ({
  loadCredentials: vi.fn(),
  refreshAccessToken: vi.fn(),
  storeCredentials: vi.fn(),
}))

describe('client.token-refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TR-1: tryRefreshToken returns new accessToken on success', async () => {
    const { loadCredentials, refreshAccessToken, storeCredentials } =
      await import('../config/token-credentials.js')
    const { tryRefreshToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue({
      accessToken: 'old_at',
      refreshToken: 'old_rt',
      expiresAt: Date.now() - 1000,
      version: 2,
    })
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: 'new_at',
      refreshToken: 'new_rt',
      expiresAt: Date.now() + 3600000,
      version: 2,
    })
    vi.mocked(storeCredentials).mockResolvedValue(undefined)

    const result = await tryRefreshToken()

    expect(result).toBe('new_at')
    expect(refreshAccessToken).toHaveBeenCalledWith('old_rt')
    expect(storeCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'new_at', version: 2 })
    )
  })

  it('TR-2: tryRefreshToken returns null when no credentials stored', async () => {
    const { loadCredentials } = await import('../config/token-credentials.js')
    const { tryRefreshToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue(null)

    const result = await tryRefreshToken()
    expect(result).toBeNull()
  })

  it('TR-3: tryRefreshToken returns null when refreshAccessToken fails', async () => {
    const { loadCredentials, refreshAccessToken } = await import('../config/token-credentials.js')
    const { tryRefreshToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue({
      accessToken: 'old_at',
      refreshToken: 'expired_rt',
      expiresAt: Date.now() - 1000,
      version: 2,
    })
    vi.mocked(refreshAccessToken).mockResolvedValue(null)

    const result = await tryRefreshToken()
    expect(result).toBeNull()
  })

  it('TR-4: loadStoredAccessToken returns accessToken when credentials exist', async () => {
    const { loadCredentials } = await import('../config/token-credentials.js')
    const { loadStoredAccessToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue({
      accessToken: 'stored_at',
      refreshToken: 'stored_rt',
      expiresAt: Date.now() + 3600000,
      version: 2,
    })

    const result = await loadStoredAccessToken()
    expect(result).toBe('stored_at')
  })

  it('TR-5: loadStoredAccessToken returns null when no credentials stored', async () => {
    const { loadCredentials } = await import('../config/token-credentials.js')
    const { loadStoredAccessToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue(null)

    const result = await loadStoredAccessToken()
    expect(result).toBeNull()
  })
})
