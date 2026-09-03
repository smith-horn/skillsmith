import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emitInstallEvent,
  emitSearchEvent,
  emitToolCallEvent,
  setTelemetryIdentityProvider,
  setTelemetryIdentityInvalidationHandler,
  getTelemetryEmitStats,
  _resetTelemetryEmitStatsForTests,
} from './remote-audit.js'

vi.mock('../config/device-identity.js', () => ({
  getOrCreateInstallId: vi.fn(() => 'a'.repeat(64)),
}))

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

/**
 * SMI-5193: emitSearchEvent — fire-and-forget search-event emission to the
 * Skillsmith events endpoint so MCP searches land in `search_metrics`.
 *
 * `emitSearchEvent` is synchronous (returns `void`, not Promise) — the tests
 * assert the fetch *eventually* fires by awaiting a microtask flush after
 * calling it, since `void postTelemetryEvent(...)` runs async internally.
 */
describe('emitSearchEvent', () => {
  // Allow the fire-and-forget fetch to be dispatched (one microtask flush is
  // enough — the helper calls fetch synchronously inside its async body).
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('returns void (not a Promise) — synchronous fire-and-forget', () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    const result = emitSearchEvent({
      query: 'commit',
      results_count: 5,
      duration_ms: 42,
      has_query: true,
    })
    expect(result).toBeUndefined()
  })

  it('skips when no API key is available', async () => {
    delete process.env.SKILLSMITH_API_KEY
    emitSearchEvent({ query: 'commit', results_count: 5, duration_ms: 42, has_query: true })
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('skips when telemetry is disabled via env', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    process.env.SKILLSMITH_TELEMETRY = '0'
    emitSearchEvent({ query: 'commit', results_count: 5, duration_ms: 42, has_query: true })
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('emits event=search with snake_case metadata + anonymous_id', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    emitSearchEvent({
      query: 'commit',
      results_count: 7,
      duration_ms: 123,
      has_query: true,
      trust_tier: 'verified',
      category: 'testing',
    })
    await flush()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = readBody()

    // Event name MUST be 'search' — 'skill_search' would 400 server-side.
    expect(body.event).toBe('search')
    // anonymous_id MUST be present and a 64-hex sha256 digest.
    expect(body.anonymous_id).toMatch(/^[0-9a-f]{64}$/)
    expect(String(body.anonymous_id)).not.toContain('sk_live')
    // Metadata keys MUST be snake_case — `sanitizeMetadata` allowlists these.
    expect(body.metadata).toEqual({
      query: 'commit',
      results_count: 7,
      duration_ms: 123,
      has_query: true,
      trust_tier: 'verified',
      category: 'testing',
    })
  })

  it('omits optional trust_tier and category when undefined', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    emitSearchEvent({
      query: '',
      results_count: 0,
      duration_ms: 9,
      has_query: false,
    })
    await flush()

    const body = readBody()
    expect(body.metadata).toEqual({
      query: '',
      results_count: 0,
      duration_ms: 9,
      has_query: false,
    })
  })

  it('swallows fetch errors without throwing', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_testtoken'
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    // Synchronous call — must not throw.
    expect(() =>
      emitSearchEvent({ query: 'commit', results_count: 0, duration_ms: 1, has_query: true })
    ).not.toThrow()
    await flush()
  })
})

/**
 * SMI-6362 §1: emitToolCallEvent — the second sink `withTelemetry` fires for
 * MCP tool calls. Distinct from emitInstallEvent/emitSearchEvent above in two
 * load-bearing ways: (1) it never uses the API-key-derived HMAC anonymous_id
 * — `anonymous_id` is always the persisted install id (D-7), regardless of
 * credential; (2) it is gated on a synchronously-read identity PROVIDER, not
 * on `getApiKey()` directly, and sends `Authorization: Bearer <token>`.
 */
describe('emitToolCallEvent', () => {
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  const basePayload = {
    toolName: 'search',
    framework: 'claude-code',
    durationMs: 42,
    success: true,
    isSubagent: false,
  }

  afterEach(() => {
    setTelemetryIdentityProvider(null)
    setTelemetryIdentityInvalidationHandler(null)
    _resetTelemetryEmitStatsForTests()
  })

  it('skips entirely (no fetch call) when no identity provider is installed', async () => {
    emitToolCallEvent(basePayload)
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getTelemetryEmitStats().skippedNoIdentity).toBe(1)
  })

  it('skips entirely when the provider returns null (no cached credential yet)', async () => {
    setTelemetryIdentityProvider(() => null)
    emitToolCallEvent(basePayload)
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getTelemetryEmitStats().skippedNoIdentity).toBe(1)
  })

  it('never falls back to an unauthenticated POST — no identity means no send at all', async () => {
    // Regression guard for the plan's explicit "no fallback to an
    // unauthenticated POST" rule (§1, Credential plumbing).
    setTelemetryIdentityProvider(() => null)
    emitToolCallEvent(basePayload)
    emitToolCallEvent(basePayload)
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('skips when telemetry is disabled via env, even with a valid identity', async () => {
    process.env.SKILLSMITH_TELEMETRY = '0'
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
    emitToolCallEvent(basePayload)
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends event=tool_call with the install id as anonymous_id (not an API-key hash)', async () => {
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
    emitToolCallEvent(basePayload)
    await flush()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = readBody()
    expect(body.event).toBe('tool_call')
    expect(body.anonymous_id).toBe('a'.repeat(64))
  })

  it('sends Authorization: Bearer <accessToken> from the identity provider', async () => {
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-xyz' }))
    emitToolCallEvent(basePayload)
    await flush()

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer jwt-xyz')
  })

  it('sends the full snake_case metadata shape, D-2a/D-3 exclusions honoured', async () => {
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc', sdkVersion: '0.7.12' }))
    emitToolCallEvent({
      toolName: 'install_skill',
      framework: 'cursor',
      durationMs: 99,
      success: true,
      isSubagent: false,
      sessionId: 'sess-42',
    })
    await flush()

    const body = readBody()
    const meta = body.metadata as Record<string, unknown>
    expect(meta.tool_name).toBe('install_skill')
    expect(meta.source).toBe('mcp-tool')
    expect(meta.framework).toBe('cursor')
    expect(meta.duration_ms).toBe(99)
    expect(meta.success).toBe(true)
    expect(meta.session_id).toBe('sess-42')
    expect(meta.sdk_version).toBe('0.7.12')
    expect(meta.is_subagent).toBe(false)
    expect(meta.platform).toBe(process.platform)
    // D-2a: team_id is never a client-sent field (server-derived only).
    expect(meta).not.toHaveProperty('team_id')
    // D-3: skill_name is never sent on a tool_call event.
    expect(meta).not.toHaveProperty('skill_name')
  })

  it('omits session_id and sdk_version when neither is available', async () => {
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
    emitToolCallEvent(basePayload)
    await flush()

    const meta = readBody().metadata as Record<string, unknown>
    expect(meta).not.toHaveProperty('session_id')
    expect(meta).not.toHaveProperty('sdk_version')
  })

  it('includes error_name/error_message on failure only', async () => {
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
    emitToolCallEvent({
      ...basePayload,
      success: false,
      errorName: 'ZodError',
      errorMessage: 'invalid arguments',
    })
    await flush()

    const meta = readBody().metadata as Record<string, unknown>
    expect(meta.error_name).toBe('ZodError')
    expect(meta.error_message).toBe('invalid arguments')
  })

  it('omits error_name/error_message on success even if somehow passed', async () => {
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
    emitToolCallEvent({
      ...basePayload,
      success: true,
      errorName: 'should-not-appear',
      errorMessage: 'should-not-appear',
    })
    await flush()

    const meta = readBody().metadata as Record<string, unknown>
    expect(meta).not.toHaveProperty('error_name')
    expect(meta).not.toHaveProperty('error_message')
  })

  describe('D-8: emission-durability classification', () => {
    it('classifies a response with Accepted=1 as accepted', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { 'X-Skillsmith-Telemetry-Accepted': '1' } })
      )
      setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
      emitToolCallEvent(basePayload)
      await flush()
      expect(getTelemetryEmitStats()).toMatchObject({ accepted: 1, rejected: 0, failed: 0 })
    })

    it('classifies a response with Accepted=0 + a reason header as rejected', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            'X-Skillsmith-Telemetry-Accepted': '0',
            'X-Skillsmith-Telemetry-Reason': 'consent_required',
          },
        })
      )
      setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
      emitToolCallEvent(basePayload)
      await flush()
      expect(getTelemetryEmitStats()).toMatchObject({
        accepted: 0,
        rejected: 1,
        failed: 0,
        lastRejectionReason: 'consent_required',
      })
    })

    it('classifies a swallowed fetch/network error as failed', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network down'))
      setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
      emitToolCallEvent(basePayload)
      await flush()
      expect(getTelemetryEmitStats()).toMatchObject({ accepted: 0, rejected: 0, failed: 1 })
    })

    it('updates lastRejectionReason to the most recent rejection only', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            'X-Skillsmith-Telemetry-Accepted': '0',
            'X-Skillsmith-Telemetry-Reason': 'ambiguous_team',
          },
        })
      )
      setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
      emitToolCallEvent(basePayload)
      await flush()
      expect(getTelemetryEmitStats().lastRejectionReason).toBe('ambiguous_team')

      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            'X-Skillsmith-Telemetry-Accepted': '0',
            'X-Skillsmith-Telemetry-Reason': 'consent_denied',
          },
        })
      )
      emitToolCallEvent(basePayload)
      await flush()
      expect(getTelemetryEmitStats().lastRejectionReason).toBe('consent_denied')
    })

    it('invokes the invalidation handler on an invalid_jwt rejection, and only that reason', async () => {
      const onInvalid = vi.fn()
      setTelemetryIdentityInvalidationHandler(onInvalid)
      setTelemetryIdentityProvider(() => ({ accessToken: 'stale-jwt' }))

      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            'X-Skillsmith-Telemetry-Accepted': '0',
            'X-Skillsmith-Telemetry-Reason': 'invalid_jwt',
          },
        })
      )
      emitToolCallEvent(basePayload)
      await flush()
      expect(onInvalid).toHaveBeenCalledTimes(1)

      // A different rejection reason (e.g. consent_denied) must NOT trigger
      // a refresh — re-resolving the same valid token would not fix it.
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            'X-Skillsmith-Telemetry-Accepted': '0',
            'X-Skillsmith-Telemetry-Reason': 'consent_denied',
          },
        })
      )
      emitToolCallEvent(basePayload)
      await flush()
      expect(onInvalid).toHaveBeenCalledTimes(1)
    })
  })
})
