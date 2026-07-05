/**
 * audit-notify-client tests (SMI-5541 Wave 2C Stage 2).
 *
 * Mocks the token-credentials leaf module (which the shared `access-token`
 * resolver imports) and global fetch.
 *
 * UC-1: no credentials -> AuditNotifyAuthError, no fetch.
 * UC-2: expired credentials -> refresh path runs, new creds stored, new token used.
 * UC-3: 200 bodies (sent / nothing_to_report / not_consented) returned verbatim.
 * UC-4: 401 -> AuditNotifyAuthError; 400 / 500 -> AuditNotifyError (carries reason).
 * UC-5: network throw / unreadable 200 -> AuditNotifyError.
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
  sendAuditDigest,
  AuditNotifyAuthError,
  AuditNotifyError,
  type AuditDigestPushPayload,
} from './audit-notify-client.js'

const fetchMock = vi.fn<typeof fetch>()

const payload: AuditDigestPushPayload = {
  scanned: 3,
  hostile: 1,
  malicious: 0,
  suspicious: 0,
  findings: [{ identifier: 'acme/rug', kind: 'skill', verdict: 'hostile', reason: 'went bad' }],
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

describe('audit-notify-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('UC-1: throws AuditNotifyAuthError when no credentials are stored — no fetch', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(null)
    await expect(sendAuditDigest(payload)).rejects.toBeInstanceOf(AuditNotifyAuthError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('UC-2: refreshes an about-to-expire token, stores it, and sends with the new token', async () => {
    vi.mocked(loadCredentials).mockResolvedValue({
      ...futureCreds,
      accessToken: 'at_stale',
      expiresAt: Date.now() + 1_000, // within the 60s skew → refresh
    })
    vi.mocked(refreshAccessToken).mockResolvedValue({ ...futureCreds, accessToken: 'at_fresh' })
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, sent: true }, 200))

    const res = await sendAuditDigest(payload)

    expect(res).toEqual({ ok: true, sent: true })
    expect(storeCredentials).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at_fresh')
  })

  it('UC-3a: 200 { ok:true, sent:true } → returned verbatim', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, sent: true }, 200))
    await expect(sendAuditDigest(payload)).resolves.toEqual({ ok: true, sent: true })
  })

  it('UC-3b: 200 nothing_to_report → { ok:true, sent:false, reason }', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, sent: false, reason: 'nothing_to_report' }, 200)
    )
    await expect(sendAuditDigest(payload)).resolves.toEqual({
      ok: true,
      sent: false,
      reason: 'nothing_to_report',
    })
  })

  it('UC-3c: 200 not_consented → { ok:false, sent:false, reason }', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, reason: 'not_consented' }, 200))
    await expect(sendAuditDigest(payload)).resolves.toEqual({
      ok: false,
      sent: false,
      reason: 'not_consented',
    })
  })

  it('UC-3d: 200 { ok:false, error:"email_send_failed" } → reason surfaced from `error`', async () => {
    // The Resend-failure body uses `error`, not `reason` — the client must
    // still surface it so the outcome is not silently blank.
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'email_send_failed' }, 200))
    await expect(sendAuditDigest(payload)).resolves.toEqual({
      ok: false,
      sent: false,
      reason: 'email_send_failed',
    })
  })

  it('UC-4a: 401 → AuditNotifyAuthError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ error: 'authentication_required' }, 401))
    await expect(sendAuditDigest(payload)).rejects.toBeInstanceOf(AuditNotifyAuthError)
  })

  it('UC-4b: 400 invalid_payload → AuditNotifyError carrying the server message', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_payload' }, 400))
    await expect(sendAuditDigest(payload)).rejects.toThrow(/invalid_payload/)
  })

  it('UC-4c: 500 → AuditNotifyError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(jsonResponse({ error: 'server_misconfigured' }, 500))
    await expect(sendAuditDigest(payload)).rejects.toBeInstanceOf(AuditNotifyError)
  })

  it('UC-5a: network throw → AuditNotifyError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    await expect(sendAuditDigest(payload)).rejects.toBeInstanceOf(AuditNotifyError)
  })

  it('UC-5b: unreadable 200 body → AuditNotifyError', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(futureCreds)
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(sendAuditDigest(payload)).rejects.toBeInstanceOf(AuditNotifyError)
  })
})
