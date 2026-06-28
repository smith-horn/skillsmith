/**
 * inventory-client tests (SMI-5392).
 *
 * Mocks the token-credentials module and global fetch.
 *
 * UC-1: no credentials -> InventoryAuthError, no fetch.
 * UC-2: expired credentials -> refresh path runs, new creds stored, new token used.
 * UC-3: expired credentials + failed refresh -> InventoryAuthError.
 * UC-4: 200 body returned verbatim (incl. the consent-off no-op).
 * UC-5: 401 / 409 / 400 / 500 -> the matching typed error.
 * UC-6: network throw -> InventoryUploadError.
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
  uploadInventory,
  InventoryAuthError,
  InventoryConflictError,
  InventoryValidationError,
  InventoryUploadError,
} from './inventory-client.js'
import type { InventoryUploadPayload } from './inventory-types.js'

const fetchMock = vi.fn<typeof fetch>()

const payload: InventoryUploadPayload = {
  device: { device_id: '11111111-1111-4111-8111-111111111111' },
  skills: [],
}

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

describe('inventory-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('UC-1: throws InventoryAuthError when no credentials are stored', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(null)

    await expect(uploadInventory(payload)).rejects.toBeInstanceOf(InventoryAuthError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('UC-2: refreshes + stores when the access token is near expiry, then uses the new token', async () => {
    vi.mocked(loadCredentials).mockResolvedValue({
      accessToken: 'at_expired',
      refreshToken: 'rt_old',
      expiresAt: Date.now() - 1_000,
      version: 2,
    })
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: 'at_new',
      refreshToken: 'rt_new',
      expiresAt: Date.now() + 3_600_000,
      version: 2,
    })
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, applied: true, device_id: 'd' }, 200))

    const result = await uploadInventory(payload)

    expect(refreshAccessToken).toHaveBeenCalledWith('rt_old')
    expect(storeCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'at_new', version: 2 })
    )
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/inventory-upload'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer at_new' }),
      })
    )
    expect(result.applied).toBe(true)
  })

  it('UC-3: throws InventoryAuthError when the refresh fails', async () => {
    vi.mocked(loadCredentials).mockResolvedValue({
      accessToken: 'at_expired',
      refreshToken: 'rt_old',
      expiresAt: Date.now() - 1_000,
      version: 2,
    })
    vi.mocked(refreshAccessToken).mockResolvedValue(null)

    await expect(uploadInventory(payload)).rejects.toBeInstanceOf(InventoryAuthError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('UC-4: returns the 200 body verbatim, including the consent-off no-op', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    const consentOff = { ok: true, applied: false, reason: 'consent_disabled' }
    fetchMock.mockResolvedValue(jsonResponse(consentOff, 200))

    const result = await uploadInventory(payload)

    expect(result).toEqual(consentOff)
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('UC-5a: maps 401 to InventoryAuthError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ error: 'authentication_required' }, 401))

    await expect(uploadInventory(payload)).rejects.toBeInstanceOf(InventoryAuthError)
  })

  it('UC-5b: maps 409 to InventoryConflictError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ error: 'device_conflict' }, 409))

    await expect(uploadInventory(payload)).rejects.toBeInstanceOf(InventoryConflictError)
  })

  it('UC-5c: maps 400 to InventoryValidationError carrying the server message', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ error: 'too_many_skills' }, 400))

    // Single call: the mocked Response body can only be read once.
    const error = await uploadInventory(payload).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InventoryValidationError)
    expect((error as Error).message).toBe('too_many_skills')
  })

  it('UC-5d: maps 500 to InventoryUploadError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ error: 'server_error' }, 500))

    await expect(uploadInventory(payload)).rejects.toBeInstanceOf(InventoryUploadError)
  })

  it('UC-6: wraps a network throw in InventoryUploadError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(uploadInventory(payload)).rejects.toBeInstanceOf(InventoryUploadError)
  })

  // Security invariant: tokens must never appear in error message strings.
  // Covers both the non-200 response path and the network-throw path.
  it('UC-7: error messages do not leak access tokens or refresh tokens (security invariant)', async () => {
    const sentinelCreds = {
      accessToken: 'at_SECRET_5392',
      refreshToken: 'rt_SECRET_5392',
      expiresAt: Date.now() + 3_600_000,
      version: 2 as const,
    }

    // Non-200 path: 500 → InventoryUploadError whose message must not contain tokens.
    vi.mocked(loadCredentials).mockResolvedValue(sentinelCreds)
    fetchMock.mockResolvedValue(jsonResponse({ error: 'server_error' }, 500))

    const err500 = await uploadInventory(payload).catch((e: unknown) => e)
    expect(err500).toBeInstanceOf(InventoryUploadError)
    expect((err500 as Error).message).not.toContain('at_SECRET_5392')
    expect((err500 as Error).message).not.toContain('rt_SECRET_5392')

    // Network-throw path: fetch rejects → InventoryUploadError whose message must not contain tokens.
    vi.mocked(loadCredentials).mockResolvedValue(sentinelCreds)
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    const errNet = await uploadInventory(payload).catch((e: unknown) => e)
    expect(errNet).toBeInstanceOf(InventoryUploadError)
    expect((errNet as Error).message).not.toContain('at_SECRET_5392')
    expect((errNet as Error).message).not.toContain('rt_SECRET_5392')
  })
})
