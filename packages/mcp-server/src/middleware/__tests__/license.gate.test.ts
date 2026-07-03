// SMI-4402: license.gate.ts tests
// LG-1: createProfileIncompleteResponse returns code -32001 + profile_incomplete data
// LG-2: withLicenseAndQuota intercepts profile_incomplete ApiClientError → profile response
// LG-3: withLicenseAndQuota rethrows non-profile_incomplete errors
// LG-4: withLicenseAndQuota passes through on success
// LG-5: checkAndTrack IS called before the handler (quota decremented for profile_incomplete)
// LG-6 (SMI-4463): NETWORK_QUOTA_EXCEEDED → JSON-RPC -32050 + structured quotaInfo
// T2 (SMI-5479): double-gate reconciliation — withLicenseAndQuota's
// runWithEmissionGate scope nests inside a simulated dispatch-level scope.
// See the `T2 —` describe block below.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiClientError, SkillsmithError, ErrorCodes } from '@skillsmith/core'
import {
  runWithEmissionGate,
  withTelemetry,
  initializePostHog,
  shutdownPostHog,
  getPostHog,
} from '@skillsmith/core/telemetry'
import {
  createProfileIncompleteResponse,
  withLicenseAndQuota,
  MCP_MONTHLY_QUOTA_EXCEEDED_CODE,
} from '../license.gate.js'
import {
  resolveConsent,
  annotateResponseWithConsent,
  TELEMETRY_PRIVACY_URL,
  _resetConsentCacheForTests,
} from '../telemetry-consent.js'
import type { LicenseMiddleware } from '../license.js'
import type { QuotaMiddleware } from '../quota-types.js'
import type { ToolContext } from '../../context.types.js'
import { z } from 'zod'

// Mocking style matches telemetry-consent.test.ts: vi.mock the Supabase
// client module so `resolveConsent` (called inside `withLicenseAndQuota`) can
// be driven to a deterministic `enabled` value per test.
vi.mock('../../supabase-client.js', () => ({
  getSupabaseClient: vi.fn(),
}))

import { getSupabaseClient } from '../../supabase-client.js'

const mockGetClient = vi.mocked(getSupabaseClient)

/** Builds a mock Supabase client whose consent-row query resolves as given. */
function createConsentQueryMock(resolvedValue: {
  data: { enabled?: boolean | null } | null
  error: unknown
}): Awaited<ReturnType<typeof getSupabaseClient>> {
  const maybeSingle = vi.fn().mockResolvedValue(resolvedValue)
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  return { from } as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
}

const mockLicense: LicenseMiddleware = {
  checkFeature: vi.fn().mockResolvedValue({ valid: true }),
  checkTool: vi.fn().mockResolvedValue({ valid: true }),
  getLicenseInfo: vi.fn().mockResolvedValue({ valid: true, tier: 'community', features: [] }),
  invalidateCache: vi.fn(),
}

const mockQuota: QuotaMiddleware = {
  checkAndTrack: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 999,
    limit: 1000,
    percentUsed: 0.1,
    warningLevel: 0,
    resetAt: new Date(),
  }),
  getStatus: vi.fn(),
  buildMetadata: vi.fn(),
  buildExceededResponse: vi.fn(),
}

const mockCtx = {} as ToolContext

const inputSchema = z.object({ query: z.string() })

describe('license.gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('LG-1: createProfileIncompleteResponse has code -32001 and profile_incomplete=true', () => {
    const resp = createProfileIncompleteResponse()
    expect(resp.isError).toBe(true)
    const body = JSON.parse(resp.content[0].text) as Record<string, unknown>
    expect(body.code).toBe(-32001)
    expect(body.error).toBe('profile_incomplete')
    expect((body.data as Record<string, unknown>).profile_incomplete).toBe(true)
    expect(typeof body.complete_url).toBe('string')
  })

  it('LG-2: withLicenseAndQuota catches profile_incomplete ApiClientError', async () => {
    const handler = vi.fn().mockRejectedValue(new ApiClientError('profile_incomplete', false, 403))

    const result = await withLicenseAndQuota(
      'search',
      { query: 'test' },
      inputSchema,
      handler,
      mockCtx,
      mockLicense,
      mockQuota
    )

    expect(result.isError).toBe(true)
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<
      string,
      unknown
    >
    expect(body.code).toBe(-32001)
    expect(body.error).toBe('profile_incomplete')
  })

  it('LG-3: withLicenseAndQuota rethrows non-profile-incomplete errors', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('network timeout'))

    await expect(
      withLicenseAndQuota(
        'search',
        { query: 'test' },
        inputSchema,
        handler,
        mockCtx,
        mockLicense,
        mockQuota
      )
    ).rejects.toThrow('network timeout')
  })

  it('LG-4: withLicenseAndQuota returns ok on success', async () => {
    const handler = vi.fn().mockResolvedValue({ data: [{ id: 'skill/foo' }] })

    const result = await withLicenseAndQuota(
      'search',
      { query: 'test' },
      inputSchema,
      handler,
      mockCtx,
      mockLicense,
      mockQuota
    )

    expect(result.isError).toBeUndefined()
    expect(result.content).toBeDefined()
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<
      string,
      unknown
    >
    expect(body).toHaveProperty('data')
  })

  it('LG-5: checkAndTrack is called before handler (quota consumed even for profile_incomplete)', async () => {
    // H9 design note: QuotaMiddleware.checkAndTrack atomically checks + increments.
    // There is no split check/track API, so quota IS consumed before profile_incomplete
    // is detected. This test documents actual behavior to prevent misreading the comment.
    const handler = vi.fn().mockRejectedValue(new ApiClientError('profile_incomplete', false, 403))

    await withLicenseAndQuota(
      'search',
      { query: 'test' },
      inputSchema,
      handler,
      mockCtx,
      mockLicense,
      mockQuota
    )

    expect(mockQuota.checkAndTrack).toHaveBeenCalledOnce()
  })

  it('LG-6 (SMI-4463): NETWORK_QUOTA_EXCEEDED → JSON-RPC -32050 with quotaInfo', async () => {
    const resetsAt = new Date(Date.now() + 5 * 86400000).toISOString()
    const handler = vi
      .fn()
      .mockRejectedValue(
        new SkillsmithError(
          ErrorCodes.NETWORK_QUOTA_EXCEEDED,
          'Monthly quota reached (1000/1000 community tier).\nUpgrade: https://skillsmith.app/pricing',
          { details: { used: 1000, limit: 1000, tier: 'community', resetsAt } }
        )
      )

    const result = await withLicenseAndQuota(
      'search',
      { query: 'test' },
      inputSchema,
      handler,
      mockCtx,
      mockLicense,
      mockQuota
    )

    expect(result.isError).toBe(true)
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<
      string,
      unknown
    >
    expect(body.code).toBe(MCP_MONTHLY_QUOTA_EXCEEDED_CODE)
    expect(body.code).toBe(-32050)
    expect(body.error).toBe('monthly_quota_exceeded')
    expect(body.message).toContain('Monthly quota reached')
    const quotaInfo = (body.data as Record<string, unknown>).quotaInfo as Record<string, unknown>
    expect(quotaInfo.used).toBe(1000)
    expect(quotaInfo.limit).toBe(1000)
    expect(quotaInfo.tier).toBe('community')
    expect(quotaInfo.resetsAt).toBe(resetsAt)
  })
})

// ============================================================================
// T2 (SMI-5479) — double-gate reconciliation: `withLicenseAndQuota`'s
// `runWithEmissionGate` scope nests inside a simulated dispatch-level scope
// (the shape Step 3 wires into `index.ts`'s CallTool handler).
//
// Observation seam: `wrap.ts` (inside `@skillsmith/core`) calls its own
// module-local `./posthog.js` binding, so `vi.mock('@skillsmith/core/telemetry')`
// from this (different) package cannot intercept it. These tests instead
// initialize a real PostHog client with a test key and spy directly on the
// resulting instance's `capture` method — see the dispatch plan's Test
// surface T1/T2/T4 note (`docs/internal/implementation/
// smi-5479-emission-gate-dispatch.md`).
// ============================================================================

describe('T2 — double-gate reconciliation with runWithEmissionGate (SMI-5479)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetConsentCacheForTests()
    initializePostHog({ apiKey: 'phc_test_key_smi_5479' })
  })

  afterEach(async () => {
    await shutdownPostHog()
    _resetConsentCacheForTests()
  })

  it('gated tool emits exactly ONE event inside an outer dispatch-level scope — the inner middleware scope shadows, no double emit', async () => {
    mockGetClient.mockResolvedValue(
      createConsentQueryMock({ data: { enabled: true }, error: null })
    )
    const captureSpy = vi.spyOn(getPostHog()!, 'capture').mockImplementation(() => undefined)

    const ctx = { distinctId: 'user-t2-single-emit' } as ToolContext
    // Mirrors real gated-tool wiring (e.g. `executeSkillAudit` in
    // tools/skill-audit.ts): the handler passed to `withLicenseAndQuota` is
    // itself `withTelemetry`-wrapped.
    const gatedHandler = withTelemetry(async () => ({ data: [{ id: 'skill/foo' }] }), {
      source: 'mcp-tool',
      extractSkillId: () => 'skill_audit',
    })

    // Outer scope simulates Step 3's dispatch-level
    // `runWithEmissionGate(consent.enabled, ...)` wrapping the whole CallTool
    // dispatch.
    const result = await runWithEmissionGate(true, () =>
      withLicenseAndQuota(
        'skill_audit',
        { query: 'x' },
        inputSchema,
        gatedHandler,
        ctx,
        mockLicense,
        mockQuota
      )
    )

    expect(result.isError).toBeUndefined()
    expect(captureSpy).toHaveBeenCalledTimes(1)
    const [captured] = captureSpy.mock.calls[0] as [
      { event: string; properties: Record<string, unknown> },
    ]
    expect(captured.event).toBe('skill_invoke')
    expect(captured.properties.skill_id).toBe('skill_audit')
    expect(captured.properties.success).toBe(true)
  })

  it('a sibling direct call in the same outer scope still emits after the gated call completes (no destructive clear)', async () => {
    mockGetClient.mockResolvedValue(
      createConsentQueryMock({ data: { enabled: true }, error: null })
    )
    const captureSpy = vi.spyOn(getPostHog()!, 'capture').mockImplementation(() => undefined)

    const ctx = { distinctId: 'user-t2-sibling' } as ToolContext
    const gatedHandler = withTelemetry(async () => ({ data: [] }), {
      source: 'mcp-tool',
      extractSkillId: () => 'skill_audit',
    })
    // A sibling direct-dispatch tool (never routed through
    // `withLicenseAndQuota`), called directly in the SAME outer scope.
    const siblingHandler = withTelemetry(async () => 'sibling-ok', {
      source: 'mcp-tool',
      extractSkillId: () => 'search',
    })

    await runWithEmissionGate(true, async () => {
      await withLicenseAndQuota(
        'skill_audit',
        { query: 'x' },
        inputSchema,
        gatedHandler,
        ctx,
        mockLicense,
        mockQuota
      )
      // The gated call's own nested scope has already returned/unwound by
      // this point. Under the pre-SMI-5479 module-`let` implementation, its
      // `finally { setEmissionGate(undefined) }` would have destructively
      // cleared the SHARED gate here — this sibling call would then read
      // `undefined` and suppress despite still being inside an ON outer
      // scope. The ALS refactor makes that race dead: this call reads its
      // OWN outer scope, which the inner call's exit never touched.
      await siblingHandler()
    })

    expect(captureSpy).toHaveBeenCalledTimes(2)
    // `EventMessage.properties` is `Record<string | number, any>` — narrowing
    // straight to a required `skill_id` literal key trips TS2352 ("neither
    // type sufficiently overlaps"), so the `unknown` bridge is required here
    // (unlike the direct cast at line ~277, which narrows only to an index
    // signature and doesn't hit that check).
    const skillIds = captureSpy.mock.calls.map(
      (call) => (call[0] as unknown as { properties: { skill_id: string } }).properties.skill_id
    )
    expect(skillIds).toEqual(['skill_audit', 'search'])
  })

  it('gated tool ERROR envelope is byte-identical with and without an outer dispatch-level scope (annotation stays success-only)', async () => {
    const handler = vi.fn().mockRejectedValue(new ApiClientError('profile_incomplete', false, 403))

    const withoutOuterScope = await withLicenseAndQuota(
      'search',
      { query: 'x' },
      inputSchema,
      handler,
      mockCtx,
      mockLicense,
      mockQuota
    )
    const withOuterScope = await runWithEmissionGate(true, () =>
      withLicenseAndQuota(
        'search',
        { query: 'x' },
        inputSchema,
        handler,
        mockCtx,
        mockLicense,
        mockQuota
      )
    )

    expect(withOuterScope).toEqual(withoutOuterScope)
    const body = JSON.parse((withOuterScope.content as Array<{ text: string }>)[0].text) as Record<
      string,
      unknown
    >
    expect(body.code).toBe(-32001)
    expect(body).not.toHaveProperty('consent_required')
    expect(body).not.toHaveProperty('privacy_url')
  })

  it('a gated success annotated by both the middleware and a simulated dispatch-level pass yields exactly ONE consent_required/privacy_url pair', async () => {
    mockGetClient.mockResolvedValue(createConsentQueryMock({ data: null, error: null }))

    const ctx = { distinctId: 'user-t2-idempotent' } as ToolContext
    const handler = vi.fn().mockResolvedValue({ data: [{ id: 'skill/foo' }] })

    const middlewareResult = await withLicenseAndQuota(
      'search',
      { query: 'x' },
      inputSchema,
      handler,
      ctx,
      mockLicense,
      mockQuota
    )

    // Simulate Step 3's dispatch-level annotation applying the SAME resolved
    // consent (same cached `resolveConsent` call) to the middleware's
    // already-annotated result. The idempotency guard in
    // `annotateResponseWithConsent` (telemetry-consent.ts:210) must make this
    // a no-op — never a second pair, never an overwrite.
    const consent = await resolveConsent(ctx.distinctId)
    const dispatchResult = annotateResponseWithConsent(middlewareResult, consent)

    const rawText = (dispatchResult.content as Array<{ text: string }>)[0].text
    expect(rawText.match(/"consent_required"/g)).toHaveLength(1)
    expect(rawText.match(/"privacy_url"/g)).toHaveLength(1)
    const body = JSON.parse(rawText) as Record<string, unknown>
    expect(body.consent_required).toBe(true)
    expect(body.privacy_url).toBe(TELEMETRY_PRIVACY_URL)
  })
})
