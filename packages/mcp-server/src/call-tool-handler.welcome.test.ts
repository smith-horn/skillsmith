/**
 * @fileoverview First-run welcome message annotation tests (SMI-5573/5582).
 *
 * Split out of call-tool-handler.test.ts to stay under the 500-line/file
 * cap — this file covers ONLY the welcome-message annotator's wiring into
 * `handleCallToolRequest`: one-shot delivery, composition with the
 * pre-existing consent annotator on the same response, error envelopes
 * never consuming the pending message, and true no-op passthrough.
 *
 * `annotateResponseWithWelcome` (middleware/first-run-welcome.ts) is called
 * UNCONDITIONALLY in `call-tool-handler.ts`, ahead of the (success-only)
 * consent annotation — see the module doc there.
 *
 * Shared fixture/mocking setup below is duplicated from the sibling
 * call-tool-handler.test.ts (T1/T4/consent suite) rather than factored into
 * a shared helper, to keep each file's dependency graph self-contained.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import { initializePostHog, shutdownPostHog } from '@skillsmith/core/telemetry'
import { handleCallToolRequest } from './call-tool-handler.js'
import { _resetConsentCacheForTests } from './middleware/telemetry-consent.js'
import { setPendingWelcome, _resetPendingWelcomeForTests } from './middleware/first-run-welcome.js'
import { createTestDatabase, type TestDatabaseContext } from '../tests/integration/setup.js'
import type { ToolContext } from './context.js'
import type { LicenseMiddleware } from './middleware/license.js'
import type { QuotaMiddleware } from './middleware/quota.js'

// Mocking style matches call-tool-handler.test.ts's T2 block — see that
// file's header comment for the full rationale (dispatchToolCall pulls in
// every tool module, some of which import other named exports off the same
// module at their own top level).
vi.mock('./supabase-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./supabase-client.js')>()
  return {
    ...actual,
    getSupabaseClient: vi.fn(),
  }
})

import { getSupabaseClient } from './supabase-client.js'

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

const allowAllLicense: LicenseMiddleware = {
  checkFeature: vi.fn().mockResolvedValue({ valid: true }),
  checkTool: vi.fn().mockResolvedValue({ valid: true }),
  getLicenseInfo: vi.fn().mockResolvedValue({ valid: true, tier: 'community', features: [] }),
  invalidateCache: vi.fn(),
}

const allowAllQuota: QuotaMiddleware = {
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

function makeRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } }
}

/** Parses the single text content item of a CallToolResult as JSON. */
function parseBody(
  result: Awaited<ReturnType<typeof handleCallToolRequest>>
): Record<string, unknown> {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, unknown>
}

describe('handleCallToolRequest — first-run welcome message annotation (SMI-5573/5582)', () => {
  let dbContext: TestDatabaseContext
  let baseToolContext: Omit<ToolContext, 'distinctId'>
  let previousInventoryDisable: string | undefined

  beforeAll(async () => {
    dbContext = await createTestDatabase()
    // TestDatabaseContext has a `cleanup` field ToolContext doesn't — strip it.
    const { cleanup: _cleanup, ...contextFields } = dbContext
    baseToolContext = contextFields
  })

  afterAll(async () => {
    await dbContext.cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    _resetConsentCacheForTests()
    _resetPendingWelcomeForTests()
    initializePostHog({ apiKey: 'phc_test_key_smi_5582_welcome' })
    previousInventoryDisable = process.env.SKILLSMITH_INVENTORY_DISABLE
    process.env.SKILLSMITH_INVENTORY_DISABLE = '1'
  })

  afterEach(async () => {
    await shutdownPostHog()
    _resetConsentCacheForTests()
    _resetPendingWelcomeForTests()
    if (previousInventoryDisable === undefined) {
      delete process.env.SKILLSMITH_INVENTORY_DISABLE
    } else {
      process.env.SKILLSMITH_INVENTORY_DISABLE = previousInventoryDisable
    }
  })

  function contextWithConsent(distinctId: string | undefined): ToolContext {
    return { ...baseToolContext, distinctId }
  }

  const WELCOME_MESSAGE = 'Welcome to Skillsmith! (smi-5582 test fixture)'
  const NO_TIER1_FAILURES: string[] = []

  it('delivers the welcome message on the first successful call after setPendingWelcome, then is one-shot (a second call does not get it again)', async () => {
    // consentRequired: false so the consent annotator stays silent — this
    // test is purely about the welcome annotator's own splice + one-shot
    // consumption, isolated from the composition case covered below.
    mockGetClient.mockResolvedValue(
      createConsentQueryMock({ data: { enabled: true }, error: null })
    )
    setPendingWelcome(WELCOME_MESSAGE, NO_TIER1_FAILURES)

    const first = await handleCallToolRequest(
      makeRequest('search', { query: 'welcome-first-call' }),
      {
        toolContext: contextWithConsent('user-welcome-oneshot'),
        licenseMiddleware: allowAllLicense,
        quotaMiddleware: allowAllQuota,
      }
    )
    expect(first.isError).toBeFalsy()
    const firstBody = parseBody(first)
    expect(firstBody.welcome_message).toBe(WELCOME_MESSAGE)
    expect(firstBody.tier1_install_failures).toEqual(NO_TIER1_FAILURES)

    const second = await handleCallToolRequest(
      makeRequest('search', { query: 'welcome-second-call' }),
      {
        toolContext: contextWithConsent('user-welcome-oneshot'),
        licenseMiddleware: allowAllLicense,
        quotaMiddleware: allowAllQuota,
      }
    )
    expect(second.isError).toBeFalsy()
    const secondBody = parseBody(second)
    expect(secondBody.welcome_message).toBeUndefined()
    expect(secondBody.tier1_install_failures).toBeUndefined()
  })

  it('composes with the consent annotation on the same response — both fields present, neither clobbers the other', async () => {
    // No row => consentRequired: true (mirrors call-tool-handler.test.ts's
    // "once-per-process consent annotation" describe block's own setup for
    // this case), so BOTH annotators actually splice into the SAME response
    // body.
    mockGetClient.mockResolvedValue(createConsentQueryMock({ data: null, error: null }))
    setPendingWelcome(WELCOME_MESSAGE, ['author/failed-tier1-skill'])

    const result = await handleCallToolRequest(
      makeRequest('search', { query: 'welcome-and-consent-together' }),
      {
        toolContext: contextWithConsent('user-welcome-and-consent'),
        licenseMiddleware: allowAllLicense,
        quotaMiddleware: allowAllQuota,
      }
    )

    expect(result.isError).toBeFalsy()
    const body = parseBody(result)
    // Welcome annotator's fields survived the consent splice...
    expect(body.welcome_message).toBe(WELCOME_MESSAGE)
    expect(body.tier1_install_failures).toEqual(['author/failed-tier1-skill'])
    // ...and the consent annotator's fields survived the welcome splice.
    expect(body.consent_required).toBe(true)
    expect(body.privacy_url).toBe('https://skillsmith.app/account/telemetry')
  })

  it('error responses are never annotated with the welcome message, but the pending welcome survives to the next successful call', async () => {
    mockGetClient.mockResolvedValue(
      createConsentQueryMock({ data: { enabled: true }, error: null })
    )
    setPendingWelcome(WELCOME_MESSAGE, NO_TIER1_FAILURES)

    // `uninstall_skill` requires `skillName` (z.string().min(1)) — omitting
    // it fails `safeParseOrError` and `dispatchToolCall` RETURNS (does not
    // throw) a structured `isError: true` envelope. This is deliberately
    // different from call-tool-handler.test.ts's "error envelopes are never
    // annotated" consent test (which dispatches a nonexistent tool name and
    // never even reaches an annotator, since that path throws and is caught
    // by the outer try/catch): here `annotateResponseWithWelcome` IS
    // actually invoked with an error envelope, so this exercises its
    // internal `if (response.isError) return response` branch directly.
    const errorResult = await handleCallToolRequest(makeRequest('uninstall_skill', {}), {
      toolContext: contextWithConsent('user-welcome-error'),
      licenseMiddleware: allowAllLicense,
      quotaMiddleware: allowAllQuota,
    })

    expect(errorResult.isError).toBe(true)
    const errorText = (errorResult.content as Array<{ text: string }>)[0].text
    expect(errorText).not.toContain('welcome_message')
    expect(errorText).not.toContain('tier1_install_failures')

    // The important assertion: the pending welcome was NOT consumed by the
    // error call above, so the next successful call still receives it.
    const success = await handleCallToolRequest(
      makeRequest('search', { query: 'welcome-after-error' }),
      {
        toolContext: contextWithConsent('user-welcome-error'),
        licenseMiddleware: allowAllLicense,
        quotaMiddleware: allowAllQuota,
      }
    )
    expect(success.isError).toBeFalsy()
    const successBody = parseBody(success)
    expect(successBody.welcome_message).toBe(WELCOME_MESSAGE)
    expect(successBody.tier1_install_failures).toEqual(NO_TIER1_FAILURES)
  })

  it('is a true no-op when nothing is pending — no welcome fields at all, not even empty/null', async () => {
    mockGetClient.mockResolvedValue(
      createConsentQueryMock({ data: { enabled: true }, error: null })
    )
    // Nothing queued: beforeEach's _resetPendingWelcomeForTests() leaves a
    // clean slate, and this test never calls setPendingWelcome.

    const result = await handleCallToolRequest(
      makeRequest('search', { query: 'welcome-passthrough' }),
      {
        toolContext: contextWithConsent('user-welcome-passthrough'),
        licenseMiddleware: allowAllLicense,
        quotaMiddleware: allowAllQuota,
      }
    )

    expect(result.isError).toBeFalsy()
    const body = parseBody(result)
    expect('welcome_message' in body).toBe(false)
    expect('tier1_install_failures' in body).toBe(false)
  })
})
