/**
 * @fileoverview SMI-5479 additions to the telemetry consent gate — split
 * from `telemetry-consent.test.ts` to stay under the `audit:standards`
 * 500-line file gate (that file already covered the SMI-5019 W2 surface;
 * this sibling covers the SMI-5479 Step-3 additions: consent-cache
 * eviction-on-rejection, the once-per-process prompt primitives, and the
 * reference-identity contract `call-tool-handler.ts`'s `maybeAnnotate`
 * relies on).
 *
 * SMI-6362 §3/B-6 rewired the real `fetchConsentState` from a direct
 * Supabase query to a POST against the `telemetry-consent` edge function —
 * mocking style now matches the sibling `telemetry-consent.test.ts`:
 * `@skillsmith/core` mocked at module scope, global `fetch` stubbed per
 * test. `_resetConsentCacheForTests()` runs in `beforeEach`/`afterEach` so
 * every test starts with an empty process-level cache AND an empty
 * `promptedIds` set (SMI-5479 folded the latter into the same reset
 * helper).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveConsent,
  annotateResponseWithConsent,
  wasConsentPrompted,
  markConsentPrompted,
  _resetConsentCacheForTests,
  TELEMETRY_PRIVACY_URL,
  type ConsentState,
} from './telemetry-consent.js'

// ============================================================================
// @skillsmith/core + fetch mocks
// ============================================================================

const getApiBaseUrlMock = vi.fn(() => 'https://api.example.com')
const getApiKeyMock = vi.fn((): string | undefined => undefined)
const resolveFreshAccessTokenMock = vi.fn(async (): Promise<string | null> => null)

vi.mock('@skillsmith/core', () => ({
  getApiBaseUrl: () => getApiBaseUrlMock(),
  getApiKey: () => getApiKeyMock(),
  resolveFreshAccessToken: () => resolveFreshAccessTokenMock(),
}))

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

const fetchMock = vi.fn<typeof fetch>()

/** Minimal MCP CallToolResult-shaped envelope. */
function makeEnvelope(text: string): { content: { type: string; text: string }[] } {
  return { content: [{ type: 'text', text }] }
}

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
// Consent-cache rejection handling (SMI-5479 Step 3 sub-step)
// ============================================================================

describe('resolveConsent — eviction-on-rejection (SMI-5479)', () => {
  it('evicts the cache entry when the injected fetcher rejects, so the NEXT call re-resolves instead of replaying the same rejection', async () => {
    const rejectingFetcher = vi.fn().mockRejectedValue(new Error('injected fetch failure'))

    // First call: the cache stores `rejectingFetcher(id).catch(evict + rethrow)`
    // — this call's own caller still observes the rejection.
    await expect(resolveConsent('user-evict', rejectingFetcher)).rejects.toThrow(
      'injected fetch failure'
    )
    expect(rejectingFetcher).toHaveBeenCalledTimes(1)

    // Second call: had the rejected promise stayed cached, this would
    // immediately reject again WITHOUT calling the real fetcher a second
    // time — eviction means it gets a fresh attempt.
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    const state = await resolveConsent('user-evict')
    expect(state.enabled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not evict OTHER cached ids when one id rejects', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { enabled: true, consentRequired: false } }))

    // Populate a healthy cache entry for a different id first.
    await resolveConsent('user-evict-sibling')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const rejectingFetcher = vi.fn().mockRejectedValue(new Error('injected fetch failure'))
    await expect(resolveConsent('user-evict-target', rejectingFetcher)).rejects.toThrow()

    // The sibling's cache entry is untouched — a second resolve for it does
    // NOT re-query.
    await resolveConsent('user-evict-sibling')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('pin: fetchConsentState (the real, unmocked fetcher) never rejects — even when fetch itself rejects, when the response is not ok, and when the response body is malformed', async () => {
    // Branch 1: fetch itself rejects (network/timeout).
    fetchMock.mockRejectedValueOnce(new Error('network error'))
    await expect(resolveConsent('user-pin-network-throw')).resolves.toEqual({
      enabled: false,
      consentRequired: true,
      privacyUrl: TELEMETRY_PRIVACY_URL,
    })

    // Branch 2: the response is not ok (e.g. the endpoint's own rate limit).
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, false, 429))
    await expect(resolveConsent('user-pin-not-ok')).resolves.toEqual({
      enabled: false,
      consentRequired: true,
      privacyUrl: TELEMETRY_PRIVACY_URL,
    })

    // Branch 3: the response body is malformed (wrong-typed fields).
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { enabled: 'yes' } }))
    await expect(resolveConsent('user-pin-malformed')).resolves.toEqual({
      enabled: false,
      consentRequired: true,
      privacyUrl: TELEMETRY_PRIVACY_URL,
    })

    // Branch 4: res.json() itself throws (e.g. truncated/non-JSON body).
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected end of JSON input')
      },
    } as unknown as Response)
    await expect(resolveConsent('user-pin-json-throw')).resolves.toEqual({
      enabled: false,
      consentRequired: true,
      privacyUrl: TELEMETRY_PRIVACY_URL,
    })
  })
})

// ============================================================================
// Once-per-process consent-prompt primitives (SMI-5479 Option A)
// ============================================================================

describe('wasConsentPrompted / markConsentPrompted', () => {
  it('wasConsentPrompted returns false for an id that has never been marked', () => {
    expect(wasConsentPrompted('user-never-prompted')).toBe(false)
  })

  it('wasConsentPrompted returns true after markConsentPrompted for the same id', () => {
    markConsentPrompted('user-prompted-once')
    expect(wasConsentPrompted('user-prompted-once')).toBe(true)
  })

  it('marking one id does not affect another', () => {
    markConsentPrompted('user-prompted-x')
    expect(wasConsentPrompted('user-prompted-y')).toBe(false)
  })

  it('both are no-ops for a falsy id', () => {
    expect(wasConsentPrompted(null)).toBe(false)
    expect(wasConsentPrompted(undefined)).toBe(false)
    expect(() => markConsentPrompted(undefined)).not.toThrow()
    expect(() => markConsentPrompted(null)).not.toThrow()
  })

  it('_resetConsentCacheForTests clears promptedIds alongside the consent cache', () => {
    markConsentPrompted('user-prompted-reset')
    expect(wasConsentPrompted('user-prompted-reset')).toBe(true)

    _resetConsentCacheForTests()

    expect(wasConsentPrompted('user-prompted-reset')).toBe(false)
  })
})

// ============================================================================
// annotateResponseWithConsent — reference-identity contract the
// dispatch-level `maybeAnnotate` (call-tool-handler.ts) relies on: a no-op
// path returns the SAME reference; an actual splice returns a NEW one.
// ============================================================================

describe('annotateResponseWithConsent — reference identity (SMI-5479 maybeAnnotate contract)', () => {
  const REQUIRED: ConsentState = {
    enabled: false,
    consentRequired: true,
    privacyUrl: TELEMETRY_PRIVACY_URL,
  }

  it('returns a NEW reference when it actually splices the fields in', () => {
    const envelope = makeEnvelope(JSON.stringify({ result: 'ok' }))
    const out = annotateResponseWithConsent(envelope, REQUIRED)
    expect(out).not.toBe(envelope)
  })

  it('returns the SAME reference on the non-JSON fail-open path (e.g. inventory_push prose body)', () => {
    const envelope = makeEnvelope('Pushed inventory for device abc123: 4 present, 0 absent.')
    const out = annotateResponseWithConsent(envelope, REQUIRED)
    expect(out).toBe(envelope)
  })

  it('returns the SAME reference when already annotated (idempotency)', () => {
    const alreadyAnnotated = { result: 'ok', consent_required: true, privacy_url: 'https://x.y' }
    const envelope = makeEnvelope(JSON.stringify(alreadyAnnotated))
    const out = annotateResponseWithConsent(envelope, REQUIRED)
    expect(out).toBe(envelope)
  })
})
