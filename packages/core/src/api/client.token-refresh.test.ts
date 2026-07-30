// SMI-4402 TR-1..5: tryRefreshToken (success/null-creds/null-refresh) + loadStoredAccessToken (success/null)
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

// SMI-5905 Wave 1: resolveFreshAccessToken() — extracted from team-resolver.ts's
// resolveUserAccessToken() (TOKEN_EXPIRY_SKEW_MS=60s). team-resolver.ts now delegates to this
// function unchanged, so these cases are the authoritative coverage for the skew logic.
describe('resolveFreshAccessToken (SMI-5905)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('RFT-1: returns accessToken directly when well within expiry (no refresh)', async () => {
    const { loadCredentials, refreshAccessToken } = await import('../config/token-credentials.js')
    const { resolveFreshAccessToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue({
      accessToken: 'fresh_at',
      refreshToken: 'fresh_rt',
      expiresAt: Date.now() + 3_600_000, // 1h out — far outside the 60s skew window
      version: 2,
    })

    const result = await resolveFreshAccessToken()

    expect(result).toBe('fresh_at')
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('RFT-2: returns null when no credentials are stored (no refresh attempted)', async () => {
    const { loadCredentials, refreshAccessToken } = await import('../config/token-credentials.js')
    const { resolveFreshAccessToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue(null)

    const result = await resolveFreshAccessToken()

    expect(result).toBeNull()
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('RFT-3: expiry-skew boundary — refreshes within the 60s skew window', async () => {
    const { loadCredentials, refreshAccessToken, storeCredentials } =
      await import('../config/token-credentials.js')
    const { resolveFreshAccessToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue({
      accessToken: 'about_to_expire_at',
      refreshToken: 'still_valid_rt',
      expiresAt: Date.now() + 30_000, // 30s out — inside the 60s skew window
      version: 2,
    })
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: 'refreshed_at',
      refreshToken: 'refreshed_rt',
      expiresAt: Date.now() + 3_600_000,
      version: 2,
    })
    vi.mocked(storeCredentials).mockResolvedValue(undefined)

    const result = await resolveFreshAccessToken()

    expect(result).toBe('refreshed_at')
    expect(refreshAccessToken).toHaveBeenCalledWith('still_valid_rt')
    expect(storeCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'refreshed_at' })
    )
  })

  it('RFT-4: an already-expired token also refreshes (not just the skew window)', async () => {
    const { loadCredentials, refreshAccessToken, storeCredentials } =
      await import('../config/token-credentials.js')
    const { resolveFreshAccessToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue({
      accessToken: 'expired_at',
      refreshToken: 'expired_rt',
      expiresAt: Date.now() - 1_000,
      version: 2,
    })
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: 'new_at',
      refreshToken: 'new_rt',
      expiresAt: Date.now() + 3_600_000,
      version: 2,
    })
    vi.mocked(storeCredentials).mockResolvedValue(undefined)

    const result = await resolveFreshAccessToken()

    expect(result).toBe('new_at')
  })

  it('RFT-5: returns null when the refresh token itself is no longer valid', async () => {
    const { loadCredentials, refreshAccessToken } = await import('../config/token-credentials.js')
    const { resolveFreshAccessToken } = await import('./client.token-refresh.js')

    vi.mocked(loadCredentials).mockResolvedValue({
      accessToken: 'about_to_expire_at',
      refreshToken: 'dead_rt',
      expiresAt: Date.now() + 30_000,
      version: 2,
    })
    vi.mocked(refreshAccessToken).mockResolvedValue(null)

    const result = await resolveFreshAccessToken()

    expect(result).toBeNull()
  })
})
