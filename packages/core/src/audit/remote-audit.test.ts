import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitInstallEvent } from './remote-audit.js'

const fetchSpy = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy)
  fetchSpy.mockReset()
  fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
  delete process.env.SKILLSMITH_TELEMETRY
  delete process.env.SKILLSMITH_API_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.SKILLSMITH_API_KEY
})

function readBody(): Record<string, unknown> {
  const body = fetchSpy.mock.calls[0]?.[1]?.body
  return JSON.parse(body as string) as Record<string, unknown>
}

describe('emitInstallEvent', () => {
  it('skips when no API key is available', async () => {
    delete process.env.SKILLSMITH_API_KEY
    await emitInstallEvent({ skillId: 'acme/foo', source: 'mcp', success: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('skips when telemetry is disabled via env', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    process.env.SKILLSMITH_TELEMETRY = '0'
    await emitInstallEvent({ skillId: 'acme/foo', source: 'mcp', success: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('hashes the API key (actor is sha256 hex, not raw key)', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    await emitInstallEvent({ skillId: 'acme/foo', source: 'mcp', success: true })
    const body = readBody()
    expect(body.anonymous_id).toMatch(/^[0-9a-f]{64}$/)
    expect(String(body.anonymous_id)).not.toContain('sk_live')
  })

  it('emits with event=skill_install and the expected metadata shape', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    await emitInstallEvent({
      skillId: 'acme/foo',
      source: 'cli',
      success: false,
      durationMs: 123,
      trustTier: 'community',
      errorCode: 'NETWORK_ERROR',
    })
    const body = readBody()
    expect(body.event).toBe('skill_install')
    expect(body.metadata).toEqual({
      skill_id: 'acme/foo',
      source: 'cli',
      success: false,
      duration_ms: 123,
      trust_tier: 'community',
      error_code: 'NETWORK_ERROR',
    })
  })

  it('omits undefined optional fields from metadata', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    await emitInstallEvent({ skillId: 'acme/foo', source: 'vscode', success: true })
    const body = readBody()
    const meta = body.metadata as Record<string, unknown>
    expect(meta).toEqual({ skill_id: 'acme/foo', source: 'vscode', success: true })
    expect(meta).not.toHaveProperty('duration_ms')
    expect(meta).not.toHaveProperty('trust_tier')
    expect(meta).not.toHaveProperty('error_code')
  })

  it('swallows fetch errors and does not throw', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    await expect(
      emitInstallEvent({ skillId: 'acme/foo', source: 'mcp', success: true })
    ).resolves.toBeUndefined()
  })

  it('respects SKILLSMITH_API_URL override', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    process.env.SKILLSMITH_API_URL = 'https://staging.skillsmith.app'
    await emitInstallEvent({ skillId: 'acme/foo', source: 'mcp', success: true })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://staging.skillsmith.app/functions/v1/events',
      expect.any(Object)
    )
  })
})
