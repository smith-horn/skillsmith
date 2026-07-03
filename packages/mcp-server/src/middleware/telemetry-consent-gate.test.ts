/**
 * @fileoverview SMI-5479 additions to the telemetry consent gate — split
 * from `telemetry-consent.test.ts` to stay under the `audit:standards`
 * 500-line file gate (that file already covered the SMI-5019 W2 surface;
 * this sibling covers the SMI-5479 Step-3 additions: consent-cache
 * eviction-on-rejection, the once-per-process prompt primitives, and the
 * reference-identity contract `call-tool-handler.ts`'s `maybeAnnotate`
 * relies on).
 *
 * Mocking style matches `telemetry-consent.test.ts` /
 * `analytics.supabase.service.test.ts`: `vi.mock('../supabase-client.js')`
 * at module scope, `vi.mocked(getSupabaseClient)` driven per test.
 * `_resetConsentCacheForTests()` runs in `beforeEach`/`afterEach` so every
 * test starts with an empty process-level cache AND an empty `promptedIds`
 * set (SMI-5479 folded the latter into the same reset helper).
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
// Supabase module mock
// ============================================================================

vi.mock('../supabase-client.js', () => ({
  getSupabaseClient: vi.fn(),
}))

import { getSupabaseClient } from '../supabase-client.js'

const mockGetClient = vi.mocked(getSupabaseClient)

/**
 * Creates a mock Supabase client whose `.from().select().eq().maybeSingle()`
 * chain resolves with `resolvedValue`. Returns the `maybeSingle` spy so
 * callers can assert call counts.
 */
function createQueryMock(resolvedValue: {
  data: { enabled?: boolean | null } | null
  error: unknown
}) {
  const maybeSingle = vi.fn().mockResolvedValue(resolvedValue)
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  const client = { from } as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
  return { client, from, select, eq, maybeSingle }
}

/** Minimal MCP CallToolResult-shaped envelope. */
function makeEnvelope(text: string): { content: { type: string; text: string }[] } {
  return { content: [{ type: 'text', text }] }
}

beforeEach(() => {
  _resetConsentCacheForTests()
  vi.clearAllMocks()
})

afterEach(() => {
  _resetConsentCacheForTests()
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
    // immediately reject again WITHOUT calling the fetcher a second time —
    // eviction means it gets a fresh attempt.
    const { client, maybeSingle } = createQueryMock({ data: { enabled: true }, error: null })
    mockGetClient.mockResolvedValue(client)

    const state = await resolveConsent('user-evict')
    expect(state.enabled).toBe(true)
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })

  it('does not evict OTHER cached ids when one id rejects', async () => {
    const { client, maybeSingle } = createQueryMock({ data: { enabled: true }, error: null })
    mockGetClient.mockResolvedValue(client)

    // Populate a healthy cache entry for a different id first.
    await resolveConsent('user-evict-sibling')
    expect(maybeSingle).toHaveBeenCalledTimes(1)

    const rejectingFetcher = vi.fn().mockRejectedValue(new Error('injected fetch failure'))
    await expect(resolveConsent('user-evict-target', rejectingFetcher)).rejects.toThrow()

    // The sibling's cache entry is untouched — a second resolve for it does
    // NOT re-query.
    await resolveConsent('user-evict-sibling')
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })

  it('pin: fetchConsentState (the real, unmocked fetcher) never rejects — even when getSupabaseClient throws AND when the query chain rejects mid-flight', async () => {
    // Branch 1: getSupabaseClient itself throws synchronously-awaited.
    mockGetClient.mockRejectedValueOnce(new Error('supabase client construction failed'))
    await expect(resolveConsent('user-pin-client-throw')).resolves.toEqual({
      enabled: false,
      consentRequired: false,
      privacyUrl: TELEMETRY_PRIVACY_URL,
    })

    // Branch 2: the query chain's terminal call rejects.
    const maybeSingle = vi.fn().mockRejectedValue(new Error('network error mid-query'))
    const eq = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq })
    const from = vi.fn().mockReturnValue({ select })
    const client = { from } as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    mockGetClient.mockResolvedValue(client)

    await expect(resolveConsent('user-pin-query-throw')).resolves.toEqual({
      enabled: false,
      consentRequired: true,
      privacyUrl: TELEMETRY_PRIVACY_URL,
    })

    // Branch 3: `.from()` itself throws synchronously (not a promise).
    const throwingClient = {
      from: () => {
        throw new Error('synchronous client error')
      },
    } as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    mockGetClient.mockResolvedValue(throwingClient)

    await expect(resolveConsent('user-pin-sync-throw')).resolves.toEqual({
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
