/**
 * token-credentials tests (SMI-4402)
 * TC-1: storeCredentials → writes version:2 schema to config file
 * TC-2: loadCredentials → returns null when no v2 creds stored
 * TC-3: loadCredentials → returns TokenCredentials with keyring token
 * TC-4: refreshAccessToken → exchanges refresh token, returns new creds
 * TC-5: refreshAccessToken → returns null on non-2xx response
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock('os', () => ({ homedir: vi.fn(() => '/mock-home') }))

vi.mock('./index.js', () => ({ ensureConfigDir: vi.fn() }))

vi.mock('../api/utils.js', () => ({
  PRODUCTION_ANON_KEY: 'test-anon-key',
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const keytarDefault: any = {
  setPassword: vi.fn(),
  getPassword: vi.fn(),
}
vi.mock('@isaacs/keytar', () => ({ default: keytarDefault }))

const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', fetchMock)

describe('token-credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockReset()
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(readFileSync).mockReturnValue('{}')
    keytarDefault.setPassword.mockResolvedValue(undefined)
    keytarDefault.getPassword.mockResolvedValue(null)
  })

  it('TC-1: storeCredentials writes version:2 schema to config file', async () => {
    const { storeCredentials } = await import('./token-credentials.js')

    await storeCredentials({
      accessToken: 'at_test',
      refreshToken: 'rt_test',
      expiresAt: 9999999999000,
      version: 2,
    })

    const writeCall = vi.mocked(writeFileSync).mock.calls[0]
    expect(writeCall).toBeDefined()
    const written = JSON.parse(writeCall[1] as string) as Record<string, unknown>
    expect(written.version).toBe(2)
    expect(written.accessToken).toBe('at_test')
    expect(written.expiresAt).toBe(9999999999000)
    expect(keytarDefault.setPassword).toHaveBeenCalledWith(
      'skillsmith-cli',
      'refresh-token',
      'rt_test'
    )
  })

  it('TC-2: loadCredentials returns null when no v2 creds exist', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ apiKey: 'sk_live_legacy' }))

    const { loadCredentials } = await import('./token-credentials.js')
    const result = await loadCredentials()
    expect(result).toBeNull()
  })

  it('TC-3: loadCredentials returns TokenCredentials with keyring refresh token', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ accessToken: 'at_stored', expiresAt: 9999999999000, version: 2 })
    )
    keytarDefault.getPassword.mockResolvedValue('rt_from_keyring')

    const { loadCredentials } = await import('./token-credentials.js')
    const result = await loadCredentials()

    expect(result).not.toBeNull()
    expect(result?.accessToken).toBe('at_stored')
    expect(result?.refreshToken).toBe('rt_from_keyring')
    expect(result?.version).toBe(2)
  })

  it('TC-4: refreshAccessToken exchanges refresh token for new creds', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'new_at', refresh_token: 'new_rt', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const { refreshAccessToken } = await import('./token-credentials.js')
    const result = await refreshAccessToken('old_rt')

    expect(result).not.toBeNull()
    expect(result?.accessToken).toBe('new_at')
    expect(result?.refreshToken).toBe('new_rt')
    expect(result?.version).toBe(2)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/v1/token?grant_type=refresh_token'),
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('TC-5: refreshAccessToken returns null on non-2xx response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    )

    const { refreshAccessToken } = await import('./token-credentials.js')
    const result = await refreshAccessToken('expired_rt')
    expect(result).toBeNull()
  })
})
