/**
 * @fileoverview Tests for the extracted CallTool request handler (SMI-5479 Step 3).
 *
 * T1 — dispatch-level emission gate on/off, driven end-to-end through
 *      `handleCallToolRequest` (real `dispatchToolCall`), plus the
 *      late-binding deps pin (plan pass-2 trap).
 * T4 — per-tool emission smoke, parametrized over all 18 newly-emitting
 *      tools (12 agent-profile + 6 non-profile).
 * Plus: once-per-process consent annotation (Option A), error envelopes
 *      never annotated, `inventory_push` prose-body fail-open no-annotate.
 *
 * First-run welcome message annotation (SMI-5573/5582) coverage — one-shot
 * delivery, error envelopes never consuming the pending message, and
 * composition with the consent annotator on the same response — lives in
 * the sibling call-tool-handler.welcome.test.ts (split out to stay under
 * the 500-line/file cap).
 *
 * Observation seam (plan pass-2, matches
 * `middleware/__tests__/license.gate.test.ts`'s T2 block): `wrap.ts` (inside
 * `@skillsmith/core`) calls its own module-local `./posthog.js` binding, so
 * `vi.mock('@skillsmith/core/telemetry')` from this package cannot intercept
 * it. Initialize a REAL PostHog client with a test key and spy directly on
 * the resulting instance's `capture` method.
 *
 * Fixture note: several of the 18 tools touch the real filesystem read-only
 * (`uninstall_skill`, `skill_outdated`, `skill_rescan` read manifest /
 * skills-dir state under the real home directory — there is no override for
 * `getConfigDir()`). This is acceptable per the plan ("any routed outcome
 * that reaches the withTelemetry wrapper counts") — these are read-only,
 * fail gracefully on a "not found" outcome regardless of what's on disk, and
 * every OTHER tool that DOES expose an override (`homeDir`, `skillsDir`,
 * `project_path`) is pointed at `os.tmpdir()` to stay filesystem-isolated.
 * `apiClient` is constructed with `offlineMode: true` (via
 * `createTestDatabase()`) and every network-capable tool here
 * (`search`/`get_skill`/`install_skill`) checks `apiClient.isOffline()`
 * before making a live call, so none of these tests touch the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import { initializePostHog, shutdownPostHog, getPostHog } from '@skillsmith/core/telemetry'
import { handleCallToolRequest } from './call-tool-handler.js'
import { _resetConsentCacheForTests } from './middleware/telemetry-consent.js'
import { _resetPendingWelcomeForTests } from './middleware/first-run-welcome.js'
import { createTestDatabase, type TestDatabaseContext } from '../tests/integration/setup.js'
import type { ToolContext } from './context.js'
import type { LicenseMiddleware } from './middleware/license.js'
import type { QuotaMiddleware } from './middleware/quota.js'

// Mocking style matches telemetry-consent.test.ts / license.gate.test.ts's
// T2 block: vi.mock the Supabase client module so `resolveConsent` (called
// inside `handleCallToolRequest`) can be driven to a deterministic `enabled`
// value per test. `importOriginal` + spread (rather than a bare `{
// getSupabaseClient: vi.fn() }` factory) because `dispatchToolCall` pulls in
// EVERY tool module — including ones this file never dispatches to, like
// `team-workspace.ts` — and some of those import OTHER named exports off the
// same module (e.g. `isSupabaseConfigured`) at their own top level.
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

function captured(
  spy: ReturnType<typeof vi.spyOn>,
  callIndex = 0
): {
  event: string
  properties: Record<string, unknown>
} {
  return spy.mock.calls[callIndex][0] as { event: string; properties: Record<string, unknown> }
}

/**
 * `skill_invoke` calls captured by `spy`, filtered out of any OTHER
 * unconditional (non-consent-gated) analytics event a handler may ALSO fire
 * directly — e.g. `search.ts` calls `trackSkillSearch` and `recommend.ts`
 * calls `trackEvent(..., 'skill_recommend', ...)` unconditionally, in
 * addition to (and independent of) the consent-gated `withTelemetry`
 * `skill_invoke` emit this suite is testing. Asserting on the RAW capture
 * count would make T4 fail for those two tools for a reason unrelated to the
 * emission gate.
 */
function skillInvokeCalls(
  spy: ReturnType<typeof vi.spyOn>
): Array<{ event: string; properties: Record<string, unknown> }> {
  return spy.mock.calls
    .map((call: unknown[]) => call[0] as { event: string; properties: Record<string, unknown> })
    .filter((event: { event: string }) => event.event === 'skill_invoke')
}

/** Parses the single text content item of a CallToolResult as JSON. */
function parseBody(
  result: Awaited<ReturnType<typeof handleCallToolRequest>>
): Record<string, unknown> {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, unknown>
}

// ============================================================================
// All 18 newly-emitting tools (SMI-5479 emission-volume delta) — 12
// agent-profile + 6 non-profile. Args are chosen per-tool to (a) satisfy
// `safeParseOrError` where the dispatch layer validates before invoking the
// handler, and (b) stay offline / filesystem-isolated where an override
// exists — see the fixture note in the file doc comment above.
// ============================================================================

const TMP_HOME = os.tmpdir()
const NONEXISTENT_SKILL_PATH = path.join(TMP_HOME, 'smi5479-nonexistent', 'SKILL.md')
const NONEXISTENT_PUBLISH_DIR = path.join(TMP_HOME, 'smi5479-nonexistent-publish-dir')

const NEWLY_EMITTING_TOOLS: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
  // --- 12 agent-profile tools (PRD §9.1 mediation denominator) ---
  { name: 'search', args: { query: 'smi5479-test-query' } },
  { name: 'get_skill', args: { id: 'smi5479-test-author/smi5479-test-skill' } },
  { name: 'install_skill', args: { skillId: 'smi5479-test-author/smi5479-test-skill' } },
  { name: 'uninstall_skill', args: { skillName: 'smi5479-test-skill-not-installed' } },
  { name: 'skill_recommend', args: {} },
  { name: 'skill_validate', args: { skill_path: NONEXISTENT_SKILL_PATH } },
  {
    name: 'skill_compare',
    args: { skill_a: 'smi5479-test/a', skill_b: 'smi5479-test/b' },
  },
  { name: 'skill_outdated', args: {} },
  { name: 'skill_inventory_audit', args: { homeDir: TMP_HOME } },
  {
    name: 'apply_namespace_rename',
    args: {
      auditId: 'smi5479-nonexistent-audit',
      collisionId: 'smi5479-nonexistent-collision',
      action: 'skip',
    },
  },
  {
    name: 'apply_recommended_edit',
    args: { auditId: 'smi5479-nonexistent-audit', collisionId: 'smi5479-nonexistent-collision' },
  },
  { name: 'undo_apply', args: {} },
  // --- 6 non-profile direct-dispatch tools ---
  { name: 'skill_suggest', args: { project_path: TMP_HOME } },
  { name: 'index_local', args: { skillsDir: TMP_HOME } },
  { name: 'skill_publish', args: { skill_path: NONEXISTENT_PUBLISH_DIR } },
  { name: 'skill_rescan', args: {} },
  { name: 'inventory_push', args: {} },
  { name: 'skill_recover_source', args: { homeDir: TMP_HOME } },
]

describe('handleCallToolRequest (SMI-5479 Step 3)', () => {
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
    initializePostHog({ apiKey: 'phc_test_key_smi_5479_dispatch' })
    // inventory_push has no offline gate of its own — SKILLSMITH_INVENTORY_DISABLE
    // short-circuits it to a pure local no-op (no network, no device-id
    // creation) before any upload attempt. Set for every test in this file
    // (harmless for the other 17 tools) and restored in afterEach.
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

  // ==========================================================================
  // T1 — dispatch-level gate on/off + late-binding deps pin
  // ==========================================================================
  describe('T1 — dispatch-level emission gate on/off', () => {
    it('gate ON (consent enabled): exactly one emit with skillId=install_skill', async () => {
      mockGetClient.mockResolvedValue(
        createConsentQueryMock({ data: { enabled: true }, error: null })
      )
      const captureSpy = vi.spyOn(getPostHog()!, 'capture').mockImplementation(() => undefined)

      await handleCallToolRequest(
        makeRequest('install_skill', { skillId: 'smi5479-test-author/smi5479-test-skill-t1-on' }),
        {
          toolContext: contextWithConsent('user-t1-on'),
          licenseMiddleware: allowAllLicense,
          quotaMiddleware: allowAllQuota,
        }
      )

      expect(captureSpy).toHaveBeenCalledTimes(1)
      const event = captured(captureSpy)
      expect(event.event).toBe('skill_invoke')
      expect(event.properties.skill_id).toBe('install_skill')
    })

    it('gate OFF (consent disabled): zero emits', async () => {
      mockGetClient.mockResolvedValue(
        createConsentQueryMock({ data: { enabled: false }, error: null })
      )
      const captureSpy = vi.spyOn(getPostHog()!, 'capture').mockImplementation(() => undefined)

      await handleCallToolRequest(
        makeRequest('install_skill', {
          skillId: 'smi5479-test-author/smi5479-test-skill-t1-off',
        }),
        {
          toolContext: contextWithConsent('user-t1-off'),
          licenseMiddleware: allowAllLicense,
          quotaMiddleware: allowAllQuota,
        }
      )

      expect(captureSpy).not.toHaveBeenCalled()
    })

    it('late-binding pin: a handler "registered" while toolContext is undefined still dispatches correctly once toolContext is assigned before the call (per-call deps, never captured at registration)', async () => {
      mockGetClient.mockResolvedValue(
        createConsentQueryMock({ data: { enabled: true }, error: null })
      )
      const captureSpy = vi.spyOn(getPostHog()!, 'capture').mockImplementation(() => undefined)

      // Mirrors index.ts exactly: `toolContext` is a module-level `let`
      // assigned inside main() AFTER `server.setRequestHandler(...)`
      // registers the arrow function below. The object literal
      // `{ toolContext, ... }` lives INSIDE the arrow function body, so it
      // is re-evaluated on every CALL, not captured once at registration.
      // Intentionally `let` (not `const`) even though it's reassigned only
      // once here — mirrors index.ts's real late-binding shape.
      // eslint-disable-next-line prefer-const
      let lateToolContext: ToolContext | undefined
      const registeredHandler = (request: CallToolRequest) =>
        handleCallToolRequest(request, {
          toolContext: lateToolContext as ToolContext,
          licenseMiddleware: allowAllLicense,
          quotaMiddleware: allowAllQuota,
        })

      // At "registration time" the dep is undefined — the wrong shape (an
      // extraction that destructures/captures `toolContext` ONCE outside the
      // handler closure) would freeze it here and fail every call forever.
      expect(lateToolContext).toBeUndefined()

      // "main()" now assigns toolContext, AFTER registration.
      lateToolContext = contextWithConsent('user-t1-late-binding')

      const result = await registeredHandler(
        makeRequest('install_skill', {
          skillId: 'smi5479-test-author/smi5479-test-skill-t1-late',
        })
      )

      expect(result).toBeDefined()
      expect(captureSpy).toHaveBeenCalledTimes(1)
      expect(captured(captureSpy).properties.skill_id).toBe('install_skill')
    })
  })

  // ==========================================================================
  // T4 — per-tool emission smoke: all 18 newly-emitting tools
  // ==========================================================================
  describe('T4 — per-tool emission smoke (all 18 newly-emitting tools)', () => {
    it.each(NEWLY_EMITTING_TOOLS)(
      '$name emits exactly once with skillId=$name under a permissive gate',
      async ({ name, args }) => {
        mockGetClient.mockResolvedValue(
          createConsentQueryMock({ data: { enabled: true }, error: null })
        )
        const captureSpy = vi.spyOn(getPostHog()!, 'capture').mockImplementation(() => undefined)

        // The assertion is the EMIT, not handler success — any routed
        // outcome (success, domain-level "not found", or a thrown error
        // caught by the outer handleCallToolRequest try/catch) counts, since
        // withTelemetry emits in a `finally` regardless of outcome.
        await handleCallToolRequest(makeRequest(name, args), {
          toolContext: contextWithConsent(`user-t4-${name}`),
          licenseMiddleware: allowAllLicense,
          quotaMiddleware: allowAllQuota,
        })

        // Filtered on event === 'skill_invoke' — see skillInvokeCalls doc
        // (search/skill_recommend also fire an unrelated, unconditional
        // legacy analytics event on the same spy).
        const invokes = skillInvokeCalls(captureSpy)
        expect(invokes).toHaveLength(1)
        expect(invokes[0].properties.skill_id).toBe(name)
      },
      15000
    )
  })

  // ==========================================================================
  // Once-per-process consent annotation (SMI-5479 Option A, ratified)
  // ==========================================================================
  describe('once-per-process consent annotation', () => {
    it('first success call for a consent-required id is annotated; a second call for the SAME id is not', async () => {
      // No row => consentRequired: true (DEFAULT_CONSENT_REQUIRED).
      mockGetClient.mockResolvedValue(createConsentQueryMock({ data: null, error: null }))
      const distinctId = 'user-annotate-once'

      const first = await handleCallToolRequest(makeRequest('search', { query: 'first' }), {
        toolContext: contextWithConsent(distinctId),
        licenseMiddleware: allowAllLicense,
        quotaMiddleware: allowAllQuota,
      })
      expect(first.isError).toBeFalsy()
      const firstBody = parseBody(first)
      expect(firstBody.consent_required).toBe(true)
      expect(typeof firstBody.privacy_url).toBe('string')

      const second = await handleCallToolRequest(makeRequest('search', { query: 'second' }), {
        toolContext: contextWithConsent(distinctId),
        licenseMiddleware: allowAllLicense,
        quotaMiddleware: allowAllQuota,
      })
      expect(second.isError).toBeFalsy()
      const secondBody = parseBody(second)
      expect(secondBody.consent_required).toBeUndefined()
      expect(secondBody.privacy_url).toBeUndefined()
    })

    it('a DIFFERENT anonymousId is annotated again (per-id, not a global one-shot)', async () => {
      mockGetClient.mockResolvedValue(createConsentQueryMock({ data: null, error: null }))

      // search.ts requires queries >= 3 chars (a shorter query throws
      // synchronously, producing an error envelope this test isn't after).
      await handleCallToolRequest(makeRequest('search', { query: 'test-annotate-a' }), {
        toolContext: contextWithConsent('user-annotate-a'),
        licenseMiddleware: allowAllLicense,
        quotaMiddleware: allowAllQuota,
      })

      const otherUser = await handleCallToolRequest(
        makeRequest('search', { query: 'test-annotate-b' }),
        {
          toolContext: contextWithConsent('user-annotate-b'),
          licenseMiddleware: allowAllLicense,
          quotaMiddleware: allowAllQuota,
        }
      )

      const otherBody = parseBody(otherUser)
      expect(otherBody.consent_required).toBe(true)
    })

    it('error envelopes are never annotated, even when consent is required', async () => {
      mockGetClient.mockResolvedValue(createConsentQueryMock({ data: null, error: null }))

      const result = await handleCallToolRequest(
        makeRequest('smi5479-definitely-not-a-real-tool', {}),
        {
          toolContext: contextWithConsent('user-annotate-error'),
          licenseMiddleware: allowAllLicense,
          quotaMiddleware: allowAllQuota,
        }
      )

      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0].text
      expect(text).not.toContain('consent_required')
      expect(text).not.toContain('privacy_url')
    })

    it('inventory_push prose success body is never annotated (fail-open, no throw)', async () => {
      mockGetClient.mockResolvedValue(createConsentQueryMock({ data: null, error: null }))

      const result = await handleCallToolRequest(makeRequest('inventory_push', {}), {
        toolContext: contextWithConsent('user-annotate-inventory'),
        licenseMiddleware: allowAllLicense,
        quotaMiddleware: allowAllQuota,
      })

      expect(result.isError).toBe(false)
      const text = (result.content as Array<{ text: string }>)[0].text
      // Prose body — not JSON — so annotateResponseWithConsent fails open.
      expect(() => JSON.parse(text)).toThrow()
      expect(text).not.toContain('consent_required')
    })
  })
})
