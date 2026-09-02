/**
 * @fileoverview Tests for the telemetry consent gate — SMI-5019 W2, rewired
 * by SMI-6362 §3/B-6 to POST to the `telemetry-consent` edge function
 * instead of querying `user_telemetry_preferences` directly keyed on a
 * (structurally unmatchable, per B-6) anonymous id.
 *
 * `@skillsmith/core`'s `getApiBaseUrl`/`getApiKey`/`resolveFreshAccessToken`
 * are mocked at module scope (matching `team-resolver.test.ts`'s
 * convention); the global `fetch` is stubbed per test.
 *
 * `_resetConsentCacheForTests()` is called in beforeEach so every test starts
 * with an empty process-level cache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveConsent,
  shouldEmitTelemetry,
  invalidateConsentCache,
  annotateResponseWithConsent,
  _resetConsentCacheForTests,
  TELEMETRY_PRIVACY_URL,
} from './telemetry-consent.js'

// ============================================================================
// @skillsmith/core mock (matches team-resolver.test.ts's convention)
// ============================================================================

const getApiBaseUrlMock = vi.fn(() => 'https://api.example.com')
const getApiKeyMock = vi.fn((): string | undefined => undefined)
const resolveFreshAccessTokenMock = vi.fn(async (): Promise<string | null> => null)

vi.mock('@skillsmith/core', () => ({
  getApiBaseUrl: () => getApiBaseUrlMock(),
  getApiKey: () => getApiKeyMock(),
  resolveFreshAccessToken: () => resolveFreshAccessTokenMock(),
}))

// ============================================================================
// fetch mock
// ============================================================================

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  _resetConsentCacheForTests()
  vi.clearAllMocks()
  getApiBaseUrlMock.mockReturnValue('https://api.example.com')
  getApiKeyMock.mockReturnValue(undefined)
  resolveFreshAccessTokenMock.mockResolvedValue(null)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  _resetConsentCacheForTests()
  vi.unstubAllGlobals()
})

// ============================================================================
// (1) Default-no-id: empty / null / undefined anonymous_id
// ============================================================================

describe('resolveConsent — default-no-id branch', () => {
  it('returns DEFAULT_NO_ID for empty string without making a request', async () => {
    const state = await resolveConsent('')

    expect(state.enabled).toBe(false)
    expect(state.consentRequired).toBe(false)
    expect(state.privacyUrl).toBe(TELEMETRY_PRIVACY_URL)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns DEFAULT_NO_ID for null without making a request', async () => {
    const state = await resolveConsent(null)

    expect(state.enabled).toBe(false)
    expect(state.consentRequired).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns DEFAULT_NO_ID for undefined without making a request', async () => {
    const state = await resolveConsent(undefined)

    expect(state.enabled).toBe(false)
    expect(state.consentRequired).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shouldEmitTelemetry returns false for empty string', async () => {
    expect(await shouldEmitTelemetry('')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ============================================================================
// (2) Server resolves an undecided/unknown caller
// ============================================================================

describe('resolveConsent — server reports consentRequired', () => {
  it('returns consent_required: true when the server responds so', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: false, consentRequired: true } }))

    const state = await resolveConsent('install-id-xyz')

    expect(state.consentRequired).toBe(true)
    expect(state.enabled).toBe(false)
    expect(state.privacyUrl).toBe(TELEMETRY_PRIVACY_URL)
  })

  it('shouldEmitTelemetry returns false when consent is required', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: false, consentRequired: true } }))

    expect(await shouldEmitTelemetry('install-id-xyz')).toBe(false)
  })
})

// ============================================================================
// (3) Enabled preference
// ============================================================================

describe('resolveConsent — enabled preference', () => {
  it('returns consentRequired: false and enabled: true when the server says so', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    const state = await resolveConsent('install-id-abc')

    expect(state.enabled).toBe(true)
    expect(state.consentRequired).toBe(false)
    expect(state.privacyUrl).toBe(TELEMETRY_PRIVACY_URL)
  })

  it('shouldEmitTelemetry returns true when preference is enabled', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    expect(await shouldEmitTelemetry('install-id-abc')).toBe(true)
  })
})

// ============================================================================
// (4) Disabled (decided) preference
// ============================================================================

describe('resolveConsent — disabled preference', () => {
  it('returns consentRequired: false and enabled: false when the server says the caller decided no', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: false, consentRequired: false } }))

    const state = await resolveConsent('install-id-abc')

    // User has answered — no prompt needed, but telemetry is off.
    expect(state.consentRequired).toBe(false)
    expect(state.enabled).toBe(false)
  })

  it('shouldEmitTelemetry returns false when preference is disabled', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: false, consentRequired: false } }))

    expect(await shouldEmitTelemetry('install-id-abc')).toBe(false)
  })
})

// ============================================================================
// (5) Idempotent under concurrent calls — single in-flight request
// ============================================================================

describe('resolveConsent — concurrent call deduplication', () => {
  it('issues exactly one request for two parallel calls on the same id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    const [s1, s2] = await Promise.all([
      resolveConsent('install-id-def'),
      resolveConsent('install-id-def'),
    ])

    // Both calls must have resolved to the same consent state.
    expect(s1).toEqual(s2)
    // The endpoint was only hit once — the cache stored the in-flight Promise.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// (6) Fail-safe on transport/shape failure
// ============================================================================

describe('resolveConsent — fail-safe on transport/shape failure', () => {
  it('returns consent_required: true when fetch rejects (network/timeout)', async () => {
    fetchMock.mockRejectedValue(new Error('network error'))

    const state = await resolveConsent('install-id-ghi')

    // Fail-safe: consent_required must be true — never silently emit.
    expect(state.consentRequired).toBe(true)
    expect(state.enabled).toBe(false)
  })

  it('returns consent_required: true when the response is not ok (e.g. 429/500)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'rate_limited' }, false, 429))

    const state = await resolveConsent('install-id-ghi')

    expect(state.consentRequired).toBe(true)
    expect(state.enabled).toBe(false)
  })

  it('returns consent_required: true when the response body is malformed (missing/wrong-typed fields)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: 'yes' } }))

    const state = await resolveConsent('install-id-ghi')

    expect(state.consentRequired).toBe(true)
    expect(state.enabled).toBe(false)
  })

  it('shouldEmitTelemetry returns false when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('db error'))

    expect(await shouldEmitTelemetry('install-id-ghi')).toBe(false)
  })
})

// ============================================================================
// (6b) Credential precedence (SMI-6362 round-2 required change #5)
// ============================================================================

describe('resolveConsent — credential precedence (JWT-first, never both, never key-preferred)', () => {
  it('sends Authorization: Bearer <jwt> when a fresh access token is available', async () => {
    resolveFreshAccessTokenMock.mockResolvedValue('fresh-jwt-token')
    getApiKeyMock.mockReturnValue('sk_live_should_not_be_sent')
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    await resolveConsent('install-id-cred-1')

    const [, init] = fetchMock.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer fresh-jwt-token')
    expect(headers['X-API-Key']).toBeUndefined()
  })

  it('falls back to X-API-Key only when no JWT is available', async () => {
    resolveFreshAccessTokenMock.mockResolvedValue(null)
    getApiKeyMock.mockReturnValue('sk_live_the_only_credential')
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: false, consentRequired: true } }))

    await resolveConsent('install-id-cred-2')

    const [, init] = fetchMock.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers['X-API-Key']).toBe('sk_live_the_only_credential')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('sends no auth headers when neither a JWT nor an API key is available (unauthenticated request, server resolves it anonymously)', async () => {
    resolveFreshAccessTokenMock.mockResolvedValue(null)
    getApiKeyMock.mockReturnValue(undefined)
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: false, consentRequired: false } }))

    await resolveConsent('install-id-cred-3')

    const [, init] = fetchMock.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['X-API-Key']).toBeUndefined()
  })

  it('posts installId in the request body, to the telemetry-consent endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    await resolveConsent('the-install-id')

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.example.com/functions/v1/telemetry-consent')
    expect(JSON.parse(init?.body as string)).toEqual({ installId: 'the-install-id' })
  })

  it('resolveFreshAccessToken throwing is treated the same as no JWT available (falls back to API key, never throws)', async () => {
    resolveFreshAccessTokenMock.mockRejectedValue(new Error('credentials file corrupt'))
    getApiKeyMock.mockReturnValue('sk_live_fallback')
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: false, consentRequired: true } }))

    const state = await resolveConsent('install-id-cred-4')

    expect(state).toEqual({
      enabled: false,
      consentRequired: true,
      privacyUrl: TELEMETRY_PRIVACY_URL,
    })
    const [, init] = fetchMock.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers['X-API-Key']).toBe('sk_live_fallback')
  })
})

// ============================================================================
// (7) Cache invalidation
// ============================================================================

describe('invalidateConsentCache', () => {
  it('causes next resolveConsent call to re-query after invalidation', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    // First call — populates cache.
    await resolveConsent('install-id-jkl')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Invalidate.
    invalidateConsentCache('install-id-jkl')

    // Second call — must re-query.
    await resolveConsent('install-id-jkl')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not affect cache entries for other ids', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    await resolveConsent('install-id-jkl')
    await resolveConsent('install-id-other')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    invalidateConsentCache('install-id-jkl')

    // Only install-id-jkl re-queries; install-id-other is still cached.
    await resolveConsent('install-id-jkl')
    await resolveConsent('install-id-other')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('clears entire cache when called without argument', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    await resolveConsent('install-id-a')
    await resolveConsent('install-id-b')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    invalidateConsentCache()

    await resolveConsent('install-id-a')
    await resolveConsent('install-id-b')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

// ============================================================================
// (8–11) annotateResponseWithConsent — unaffected by the transport change
// ============================================================================

/** Minimal MCP CallToolResult-shaped envelope. */
function makeEnvelope(text: string): { content: { type: string; text: string }[] } {
  return { content: [{ type: 'text', text }] }
}

const UNRESOLVED_CONSENT = {
  enabled: false,
  consentRequired: true,
  privacyUrl: TELEMETRY_PRIVACY_URL,
}

const RESOLVED_CONSENT = {
  enabled: true,
  consentRequired: false,
  privacyUrl: TELEMETRY_PRIVACY_URL,
}

describe('annotateResponseWithConsent', () => {
  it('(8) splices consent_required and privacy_url when consent is unresolved', () => {
    const envelope = makeEnvelope(JSON.stringify({ result: 'ok' }))

    const out = annotateResponseWithConsent(envelope, UNRESOLVED_CONSENT)

    const parsed = JSON.parse((out.content as { type: string; text: string }[])[0].text)
    expect(parsed.result).toBe('ok')
    expect(parsed.consent_required).toBe(true)
    expect(parsed.privacy_url).toBe(TELEMETRY_PRIVACY_URL)
  })

  it('(9) returns envelope unchanged when consent is resolved (passthrough)', () => {
    const text = JSON.stringify({ result: 'ok' })
    const envelope = makeEnvelope(text)

    const out = annotateResponseWithConsent(envelope, RESOLVED_CONSENT)

    // Same reference (or at minimum identical content) — nothing added.
    expect(out).toBe(envelope)
    const parsed = JSON.parse((out.content as { type: string; text: string }[])[0].text)
    expect(parsed).not.toHaveProperty('consent_required')
  })

  it('(10) is idempotent — does not re-annotate if fields already present', () => {
    const alreadyAnnotated = { result: 'ok', consent_required: true, privacy_url: 'https://x.y' }
    const envelope = makeEnvelope(JSON.stringify(alreadyAnnotated))

    const out = annotateResponseWithConsent(envelope, UNRESOLVED_CONSENT)

    // Must return the same reference — no mutation of pre-existing annotation.
    expect(out).toBe(envelope)
    const parsed = JSON.parse((out.content as { type: string; text: string }[])[0].text)
    // privacy_url should remain the original value, not overwritten.
    expect(parsed.privacy_url).toBe('https://x.y')
  })

  it('(11) returns envelope unchanged when text is malformed JSON (no throw)', () => {
    const envelope = makeEnvelope('not-valid-json{{')

    expect(() => annotateResponseWithConsent(envelope, UNRESOLVED_CONSENT)).not.toThrow()

    const out = annotateResponseWithConsent(envelope, UNRESOLVED_CONSENT)
    expect(out).toBe(envelope)
  })

  it('returns envelope unchanged when content array is empty', () => {
    const envelope = { content: [] }

    const out = annotateResponseWithConsent(envelope, UNRESOLVED_CONSENT)

    expect(out).toBe(envelope)
  })

  it('returns envelope unchanged when first content item is not type=text', () => {
    const envelope = { content: [{ type: 'image', url: 'https://example.com/img.png' }] }

    const out = annotateResponseWithConsent(
      envelope as unknown as { content: { type: string; text: string }[] },
      UNRESOLVED_CONSENT
    )

    expect(out).toBe(envelope)
  })
})

// ============================================================================
// (12) Privacy URL literal
// ============================================================================

describe('TELEMETRY_PRIVACY_URL', () => {
  it('equals the canonical consent dashboard URL', () => {
    expect(TELEMETRY_PRIVACY_URL).toBe('https://skillsmith.app/account/telemetry')
  })
})

// SMI-5479 additions (consent-cache eviction-on-rejection, the
// once-per-process prompt primitives, and the annotateResponseWithConsent
// reference-identity contract) live in the sibling `telemetry-consent-gate.
// test.ts` — this file was approaching the audit:standards 500-line gate.
