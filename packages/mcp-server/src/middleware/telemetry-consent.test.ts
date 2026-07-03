/**
 * @fileoverview Tests for the telemetry consent gate — SMI-5019 W2
 *
 * Mocking style matches analytics.supabase.service.test.ts:
 *   vi.mock('../supabase-client.js') at module scope, then
 *   vi.mocked(getSupabaseClient).mockResolvedValue / mockRejectedValue per test.
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
// Supabase module mock
// ============================================================================

vi.mock('../supabase-client.js', () => ({
  getSupabaseClient: vi.fn(),
}))

import { getSupabaseClient } from '../supabase-client.js'

const mockGetClient = vi.mocked(getSupabaseClient)

// ============================================================================
// Helper — build a chainable Supabase query mock
// ============================================================================

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

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  _resetConsentCacheForTests()
  vi.clearAllMocks()
})

afterEach(() => {
  _resetConsentCacheForTests()
})

// ============================================================================
// (1) Default-no-id: empty / null / undefined anonymous_id
// ============================================================================

describe('resolveConsent — default-no-id branch', () => {
  it('returns DEFAULT_NO_ID for empty string without querying Supabase', async () => {
    const state = await resolveConsent('')

    expect(state.enabled).toBe(false)
    expect(state.consentRequired).toBe(false)
    expect(state.privacyUrl).toBe(TELEMETRY_PRIVACY_URL)
    expect(mockGetClient).not.toHaveBeenCalled()
  })

  it('returns DEFAULT_NO_ID for null without querying Supabase', async () => {
    const state = await resolveConsent(null)

    expect(state.enabled).toBe(false)
    expect(state.consentRequired).toBe(false)
    expect(mockGetClient).not.toHaveBeenCalled()
  })

  it('returns DEFAULT_NO_ID for undefined without querying Supabase', async () => {
    const state = await resolveConsent(undefined)

    expect(state.enabled).toBe(false)
    expect(state.consentRequired).toBe(false)
    expect(mockGetClient).not.toHaveBeenCalled()
  })

  it('shouldEmitTelemetry returns false for empty string', async () => {
    expect(await shouldEmitTelemetry('')).toBe(false)
    expect(mockGetClient).not.toHaveBeenCalled()
  })
})

// ============================================================================
// (2) Unknown anonymous_id — no row in DB
// ============================================================================

describe('resolveConsent — unknown anonymous_id (no row)', () => {
  it('returns consent_required: true when Supabase returns no row', async () => {
    const { client } = createQueryMock({ data: null, error: null })
    mockGetClient.mockResolvedValue(client)

    const state = await resolveConsent('unknown-xyz')

    expect(state.consentRequired).toBe(true)
    expect(state.enabled).toBe(false)
    expect(state.privacyUrl).toBe(TELEMETRY_PRIVACY_URL)
  })

  it('shouldEmitTelemetry returns false for unknown anonymous_id', async () => {
    const { client } = createQueryMock({ data: null, error: null })
    mockGetClient.mockResolvedValue(client)

    expect(await shouldEmitTelemetry('unknown-xyz')).toBe(false)
  })
})

// ============================================================================
// (3) Enabled preference
// ============================================================================

describe('resolveConsent — enabled preference', () => {
  it('returns consentRequired: false and enabled: true when row has enabled=true', async () => {
    const { client } = createQueryMock({ data: { enabled: true }, error: null })
    mockGetClient.mockResolvedValue(client)

    const state = await resolveConsent('user-abc')

    expect(state.enabled).toBe(true)
    expect(state.consentRequired).toBe(false)
    expect(state.privacyUrl).toBe(TELEMETRY_PRIVACY_URL)
  })

  it('shouldEmitTelemetry returns true when preference is enabled', async () => {
    const { client } = createQueryMock({ data: { enabled: true }, error: null })
    mockGetClient.mockResolvedValue(client)

    expect(await shouldEmitTelemetry('user-abc')).toBe(true)
  })
})

// ============================================================================
// (4) Disabled preference
// ============================================================================

describe('resolveConsent — disabled preference', () => {
  it('returns consentRequired: false and enabled: false when row has enabled=false', async () => {
    const { client } = createQueryMock({ data: { enabled: false }, error: null })
    mockGetClient.mockResolvedValue(client)

    const state = await resolveConsent('user-abc')

    // User has answered — no prompt needed, but telemetry is off.
    expect(state.consentRequired).toBe(false)
    expect(state.enabled).toBe(false)
  })

  it('shouldEmitTelemetry returns false when preference is disabled', async () => {
    const { client } = createQueryMock({ data: { enabled: false }, error: null })
    mockGetClient.mockResolvedValue(client)

    expect(await shouldEmitTelemetry('user-abc')).toBe(false)
  })
})

// ============================================================================
// (5) Idempotent under concurrent calls — single in-flight query
// ============================================================================

describe('resolveConsent — concurrent call deduplication', () => {
  it('issues exactly one Supabase query for two parallel calls on the same id', async () => {
    const { client, maybeSingle } = createQueryMock({ data: { enabled: true }, error: null })
    mockGetClient.mockResolvedValue(client)

    const [s1, s2] = await Promise.all([resolveConsent('user-def'), resolveConsent('user-def')])

    // Both calls must have resolved to the same consent state.
    expect(s1).toEqual(s2)
    // The DB was only hit once — the cache stored the in-flight Promise.
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// (6) Fail-safe on Supabase error
// ============================================================================

describe('resolveConsent — fail-safe on Supabase error', () => {
  it('returns consent_required: true when maybeSingle rejects', async () => {
    const maybeSingle = vi.fn().mockRejectedValue(new Error('network error'))
    const eq = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq })
    const from = vi.fn().mockReturnValue({ select })
    const client = { from } as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    mockGetClient.mockResolvedValue(client)

    const state = await resolveConsent('user-ghi')

    // Fail-safe: consent_required must be true — never silently emit.
    expect(state.consentRequired).toBe(true)
    expect(state.enabled).toBe(false)
  })

  it('returns consent_required: true when query returns an error object', async () => {
    const { client } = createQueryMock({ data: null, error: { message: 'permission denied' } })
    mockGetClient.mockResolvedValue(client)

    const state = await resolveConsent('user-ghi')

    expect(state.consentRequired).toBe(true)
    expect(state.enabled).toBe(false)
  })

  it('shouldEmitTelemetry returns false when Supabase errors', async () => {
    const { client } = createQueryMock({ data: null, error: { message: 'db error' } })
    mockGetClient.mockResolvedValue(client)

    expect(await shouldEmitTelemetry('user-ghi')).toBe(false)
  })

  it('returns no-id state (no prompt) when getSupabaseClient itself throws', async () => {
    // This covers the "Supabase not configured" offline branch.
    mockGetClient.mockRejectedValue(new Error('Supabase not configured'))

    const state = await resolveConsent('user-ghi-offline')

    // Offline: suppress telemetry but do NOT demand consent (no network surface).
    expect(state.enabled).toBe(false)
    // consentRequired is false in the offline/unconfigured branch — matches DEFAULT_NO_ID.
    expect(state.consentRequired).toBe(false)
  })
})

// ============================================================================
// (7) Cache invalidation
// ============================================================================

describe('invalidateConsentCache', () => {
  it('causes next resolveConsent call to re-query Supabase after invalidation', async () => {
    const { client, maybeSingle } = createQueryMock({ data: { enabled: true }, error: null })
    mockGetClient.mockResolvedValue(client)

    // First call — populates cache.
    await resolveConsent('user-jkl')
    expect(maybeSingle).toHaveBeenCalledTimes(1)

    // Invalidate.
    invalidateConsentCache('user-jkl')

    // Second call — must re-query.
    await resolveConsent('user-jkl')
    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })

  it('does not affect cache entries for other anonymous_ids', async () => {
    const { client, maybeSingle } = createQueryMock({ data: { enabled: true }, error: null })
    mockGetClient.mockResolvedValue(client)

    await resolveConsent('user-jkl')
    await resolveConsent('user-other')
    expect(maybeSingle).toHaveBeenCalledTimes(2)

    invalidateConsentCache('user-jkl')

    // Only user-jkl re-queries; user-other is still cached.
    await resolveConsent('user-jkl')
    await resolveConsent('user-other')
    expect(maybeSingle).toHaveBeenCalledTimes(3)
  })

  it('clears entire cache when called without argument', async () => {
    const { client, maybeSingle } = createQueryMock({ data: { enabled: true }, error: null })
    mockGetClient.mockResolvedValue(client)

    await resolveConsent('user-a')
    await resolveConsent('user-b')
    expect(maybeSingle).toHaveBeenCalledTimes(2)

    invalidateConsentCache()

    await resolveConsent('user-a')
    await resolveConsent('user-b')
    expect(maybeSingle).toHaveBeenCalledTimes(4)
  })
})

// ============================================================================
// (8–11) annotateResponseWithConsent
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
