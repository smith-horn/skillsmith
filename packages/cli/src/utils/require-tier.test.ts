/**
 * @fileoverview Tests for require-tier.ts — credential-aware live tier resolution
 * @see SMI-6271 (Wave 1 of SMI-6266) — CLI tier parity with the MCP server
 *
 * Fixture matrix required by the SMI-6271/SMI-6266 plan (Wave 1, Step 2):
 *  (a) SKILLSMITH_LICENSE_KEY only — unchanged behavior
 *  (b) SKILLSMITH_API_KEY with a live Enterprise-tier response
 *  (c) JWT session with a live Team-tier response
 *  (d) neither present — community, unchanged
 *  (e) live call fails/times out for a fail-closed caller — clear retry
 *      message, never silently passes or crashes
 *
 * Mirrors the mocking convention already established for the MCP server's
 * equivalent resolver: `packages/mcp-server/src/__tests__/middleware/license.tier.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getApiKey,
  getApiBaseUrl,
  loadCredentials,
  resolveSessionTier,
  SessionTierAuthError,
  SessionTierTransientError,
} from '@skillsmith/core'
import { TIER_FEATURES } from './license-types.js'

// SMI-6271: everything require-tier.ts imports from `@skillsmith/core` —
// confirmed via grep, so this mock shape is exhaustive for this file.
vi.mock('@skillsmith/core', () => ({
  getApiKey: vi.fn(),
  getApiBaseUrl: vi.fn(() => 'https://api.test.example/functions/v1'),
  loadCredentials: vi.fn().mockResolvedValue(null),
  resolveSessionTier: vi.fn(),
  SessionTierAuthError: class SessionTierAuthError extends Error {
    constructor(message = 'Not authenticated. Run `skillsmith login` and try again.') {
      super(message)
      this.name = 'SessionTierAuthError'
    }
  },
  SessionTierTransientError: class SessionTierTransientError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'SessionTierTransientError'
    }
  },
}))

// Partial mock: default to the REAL implementation (so fixture (a) exercises
// unchanged, genuine offline-JWT behavior) but let individual tests override
// the return value to exercise the fail-secure "key present + invalid" path
// without depending on whether @smith-horn/enterprise happens to be
// resolvable in this test environment.
vi.mock('./license-validation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./license-validation.js')>()
  return { ...actual, getLicenseStatus: vi.fn(actual.getLicenseStatus) }
})

import { getLicenseStatus } from './license-validation.js'
import { resolveEffectiveTier, requireTier, LICENSE_STATUS_TIMEOUT_MS } from './require-tier.js'

const RETRY_MESSAGE = /Could not verify your subscription tier/

describe('resolveEffectiveTier / requireTier (SMI-6271)', () => {
  const originalEnv = process.env
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env['SKILLSMITH_LICENSE_KEY']
    delete process.env['SKILLSMITH_API_KEY']
    delete process.env['SKILLSMITH_SKIP_LICENSE_CHECK']
    vi.mocked(getApiKey).mockReset().mockReturnValue(undefined)
    vi.mocked(getApiBaseUrl).mockReset().mockReturnValue('https://api.test.example/functions/v1')
    vi.mocked(loadCredentials).mockReset().mockResolvedValue(null)
    vi.mocked(resolveSessionTier).mockReset()
    vi.mocked(getLicenseStatus).mockClear()
    originalFetch = global.fetch
    // Guard against an accidental/unexpected network call — tests that DO
    // expect a live request override this in their own (inner) beforeEach,
    // which runs after this outer one.
    global.fetch = vi.fn(() => {
      throw new Error('unexpected fetch call in this test')
    })
  })

  afterEach(() => {
    process.env = originalEnv
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // ---------------------------------------------------------------------
  // (a) SKILLSMITH_LICENSE_KEY only — unchanged behavior
  // ---------------------------------------------------------------------
  describe('(a) SKILLSMITH_LICENSE_KEY only', () => {
    it('delegates to the unchanged offline getLicenseStatus() path, definitively', async () => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'some-license-key'

      const result = await resolveEffectiveTier()

      expect(result.source).toBe('license-key')
      expect(result.transient).toBe(false)
      // getLicenseStatus() is the ONLY thing consulted — the live-credential
      // paths must never even be reached when a license key is present.
      expect(getLicenseStatus).toHaveBeenCalledOnce()
      expect(getApiKey).not.toHaveBeenCalled()
      expect(loadCredentials).not.toHaveBeenCalled()
      expect(resolveSessionTier).not.toHaveBeenCalled()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('requireTier() preserves the fail-secure contract: key present + invalid → blocks', async () => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'some-license-key'
      vi.mocked(getLicenseStatus).mockResolvedValueOnce({
        valid: false,
        tier: 'community',
        features: TIER_FEATURES.community,
        error: 'Invalid license key format',
      })

      await expect(requireTier('individual')).rejects.toThrow(/License validation failed/)
    })

    it('requireTier() still enforces the tier gate when the key resolves validly to a low tier', async () => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'some-license-key'
      vi.mocked(getLicenseStatus).mockResolvedValueOnce({
        valid: true,
        tier: 'community',
        features: TIER_FEATURES.community,
      })

      await expect(requireTier('team')).rejects.toThrow(/team tier/)
    })

    it('SKILLSMITH_SKIP_LICENSE_CHECK bypasses resolution entirely, even with a license key set', async () => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'some-license-key'
      process.env['SKILLSMITH_SKIP_LICENSE_CHECK'] = 'true'

      await expect(requireTier('enterprise')).resolves.toBeUndefined()
      expect(getLicenseStatus).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------
  // (b) SKILLSMITH_API_KEY with a live Enterprise-tier response
  // ---------------------------------------------------------------------
  describe('(b) SKILLSMITH_API_KEY — live Enterprise response', () => {
    beforeEach(() => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_enterprise_test')
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: { authenticated: true, tier: 'enterprise', userId: 'user-1' } }),
            { status: 200 }
          )
        )
    })

    it('resolves definitively to enterprise via a live /license-status call', async () => {
      const result = await resolveEffectiveTier()

      expect(result).toEqual({
        source: 'api-key',
        transient: false,
        status: { valid: true, tier: 'enterprise', features: TIER_FEATURES.enterprise },
      })
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.test.example/functions/v1/license-status',
        expect.objectContaining({ headers: { 'X-API-Key': 'sk_live_enterprise_test' } })
      )
      // The API-key path takes precedence over the session path.
      expect(loadCredentials).not.toHaveBeenCalled()
    })

    it('requireTier("team") resolves without throwing for an Enterprise key', async () => {
      await expect(requireTier('team')).resolves.toBeUndefined()
    })

    it('an unauthenticated (bad/revoked) key resolves definitively to community', async () => {
      // mockImplementation (not mockResolvedValue) so each of the two calls
      // below gets its own Response instance — a Response body can only be
      // read once, and mockResolvedValue would return the SAME instance
      // (and thus an already-consumed body) on the second call.
      global.fetch = vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(JSON.stringify({ data: { authenticated: false } }), { status: 200 })
        )

      const result = await resolveEffectiveTier()
      expect(result).toEqual({
        source: 'api-key',
        transient: false,
        status: { valid: true, tier: 'community', features: TIER_FEATURES.community },
      })

      await expect(requireTier('individual')).rejects.toThrow(/individual tier/)
    })

    // SMI-6271 review finding: a contradictory response shape (authenticated:
    // false but a real tier value present) is not a trustworthy definitive
    // signal — the endpoint's contract is that an unauthenticated response
    // carries no tier, so seeing both together means something is wrong with
    // the response, not a clean "not authenticated" result.
    it('a contradictory authenticated:false + real tier response is transient, not definitive community', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { authenticated: false, tier: 'enterprise' } }), {
          status: 200,
        })
      )

      const result = await resolveEffectiveTier()
      expect(result.transient).toBe(true)
    })
  })

  // ---------------------------------------------------------------------
  // (c) JWT session with a live Team-tier response
  // ---------------------------------------------------------------------
  describe('(c) device session — live Team response', () => {
    beforeEach(() => {
      vi.mocked(loadCredentials).mockResolvedValue({
        version: 2,
        accessToken: 'tok',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 60_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      vi.mocked(resolveSessionTier).mockResolvedValue({
        authenticated: true,
        tier: 'team',
        rateLimit: 100,
        userId: 'user-2',
      })
    })

    it('resolves definitively to team via resolveSessionTier()', async () => {
      const result = await resolveEffectiveTier()

      expect(result).toEqual({
        source: 'session',
        transient: false,
        status: { valid: true, tier: 'team', features: TIER_FEATURES.team },
      })
    })

    it('requireTier("team") resolves without throwing for a Team session', async () => {
      await expect(requireTier('team')).resolves.toBeUndefined()
    })

    it('does not attempt a session check when no session is stored (cheap local skip)', async () => {
      vi.mocked(loadCredentials).mockResolvedValue(null)

      const result = await resolveEffectiveTier()

      expect(result.source).toBe('none')
      expect(resolveSessionTier).not.toHaveBeenCalled()
    })

    it('a definitively-unauthenticated session resolves to community', async () => {
      vi.mocked(resolveSessionTier).mockResolvedValue({ authenticated: false })

      const result = await resolveEffectiveTier()
      expect(result).toEqual({
        source: 'session',
        transient: false,
        status: { valid: true, tier: 'community', features: TIER_FEATURES.community },
      })
    })

    // SMI-6271 review finding: same contradictory-shape defense as the
    // API-key path above — authenticated:false with a real tier present is
    // not a trustworthy "not authenticated" signal.
    it('a contradictory authenticated:false + real tier session response is transient, not definitive community', async () => {
      vi.mocked(resolveSessionTier).mockResolvedValue({ authenticated: false, tier: 'team' })

      const result = await resolveEffectiveTier()
      expect(result.transient).toBe(true)
    })

    // SMI-6271 review finding: this test previously asserted the WRONG
    // outcome. resolveViaSession() (this describe block's only caller) is
    // reached exclusively after resolveEffectiveTier() already confirmed
    // loadCredentials() !== null — so a SessionTierAuthError surfacing here
    // is (barring a narrow TOCTOU race) never the "no session ever existed"
    // case; it's resolveAccessToken()'s OTHER throw site: a token-refresh
    // attempt that failed. token-credentials.ts's refreshAccessToken()
    // collapses a transient network/transport failure during that refresh
    // and a definitive refresh-token rejection into the same `null`, so
    // this error is genuinely ambiguous — treating it as a definitive
    // community downgrade would silently downgrade a real paying customer
    // on a network blip, the exact failure mode this wave exists to
    // prevent. Must be treated as transient (matches the established
    // precedent in packages/mcp-server/src/middleware/license.tier.ts's
    // createSessionTokenResolver, SMI-6098).
    it('a stored session whose refresh attempt failed (SessionTierAuthError) resolves as TRANSIENT, not a definitive community downgrade', async () => {
      vi.mocked(resolveSessionTier).mockRejectedValue(new SessionTierAuthError())

      const result = await resolveEffectiveTier()
      expect(result.transient).toBe(true)

      await expect(requireTier('individual')).rejects.toThrow(RETRY_MESSAGE)
    })
  })

  // ---------------------------------------------------------------------
  // (d) neither present — community, unchanged
  // ---------------------------------------------------------------------
  describe('(d) no credential at all', () => {
    it('resolves definitively to community without any network call', async () => {
      const result = await resolveEffectiveTier()

      expect(result).toEqual({
        source: 'none',
        transient: false,
        status: { valid: true, tier: 'community', features: TIER_FEATURES.community },
      })
      expect(resolveSessionTier).not.toHaveBeenCalled()
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('requireTier("team") rejects with the community-tier upgrade message', async () => {
      await expect(requireTier('team')).rejects.toThrow(/team tier/)
    })
  })

  // ---------------------------------------------------------------------
  // (e) live call fails/times out for a fail-closed caller
  // ---------------------------------------------------------------------
  describe('(e) transient live-check failures — fail closed, never silently pass', () => {
    it('a network error on the API-key path is transient, not community', async () => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_test')
      global.fetch = vi.fn().mockRejectedValue(new Error('network unreachable'))

      const result = await resolveEffectiveTier()
      expect(result.transient).toBe(true)

      await expect(requireTier('community')).rejects.toThrow(RETRY_MESSAGE)
    })

    // SMI-6271 review finding: a rejected fetch alone doesn't prove the real
    // AbortController timer wiring works — a broken or accidentally-removed
    // abort timer would still pass a test that just mocks fetch to reject
    // immediately. This uses fake timers to advance past the REAL
    // LICENSE_STATUS_TIMEOUT_MS and asserts the abort signal itself fires,
    // driven by the actual setTimeout(() => controller.abort(), ...) in
    // resolveViaApiKey() — not by the mock resolving/rejecting on its own.
    it('the AbortController actually aborts after LICENSE_STATUS_TIMEOUT_MS on a hung request', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(getApiKey).mockReturnValue('sk_live_test')

        let capturedSignal: AbortSignal | undefined
        global.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
          capturedSignal = init?.signal ?? undefined
          // Never resolves/rejects on its own — the ONLY way this promise
          // settles is via the abort signal firing.
          return new Promise<Response>((_resolve, reject) => {
            capturedSignal?.addEventListener('abort', () => {
              reject(new Error('aborted'))
            })
          })
        }) as unknown as typeof fetch

        const resultPromise = resolveEffectiveTier()

        // Let the synchronous-up-to-first-await portion of resolveViaApiKey()
        // run so the mocked fetch has been called and the signal captured.
        await vi.advanceTimersByTimeAsync(0)
        expect(capturedSignal).toBeDefined()
        expect(capturedSignal?.aborted).toBe(false)

        // Advance exactly to the real timeout constant — proves the timer
        // that fires the abort is wired to LICENSE_STATUS_TIMEOUT_MS, not a
        // stub or a since-removed mechanism.
        await vi.advanceTimersByTimeAsync(LICENSE_STATUS_TIMEOUT_MS)

        expect(capturedSignal?.aborted).toBe(true)

        const result = await resultPromise
        expect(result.transient).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('an HTTP 503 on the API-key path is transient', async () => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_test')
      global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }))

      const result = await resolveEffectiveTier()
      expect(result.transient).toBe(true)
    })

    it('an HTTP 429 on the API-key path is transient', async () => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_test')
      global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }))

      const result = await resolveEffectiveTier()
      expect(result.transient).toBe(true)
    })

    it('an unparseable response body on the API-key path is transient', async () => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_test')
      global.fetch = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))

      const result = await resolveEffectiveTier()
      expect(result.transient).toBe(true)
    })

    it('authenticated:true with an unrecognized tier string is transient, not a crash', async () => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_test')
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { authenticated: true, tier: 'gold-plus' } }), {
          status: 200,
        })
      )

      const result = await resolveEffectiveTier()
      expect(result.transient).toBe(true)
    })

    it('SessionTierTransientError from resolveSessionTier() is transient', async () => {
      vi.mocked(loadCredentials).mockResolvedValue({
        version: 2,
        accessToken: 'tok',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      vi.mocked(resolveSessionTier).mockRejectedValue(
        new SessionTierTransientError('license-status returned HTTP 500')
      )

      const result = await resolveEffectiveTier()
      expect(result.transient).toBe(true)

      await expect(requireTier('individual')).rejects.toThrow(RETRY_MESSAGE)
    })

    it('requireTier() never resolves (silently passes) nor throws the upgrade message on a transient failure', async () => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_test')
      // A generic rejected fetch — NOT a real timeout (see the dedicated
      // AbortController fake-timer test above for that). This test only
      // asserts requireTier()'s own fail-closed behavior on any transient
      // resolveEffectiveTier() outcome.
      global.fetch = vi.fn().mockRejectedValue(new Error('connection reset'))

      let thrown: unknown
      try {
        await requireTier('community')
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(RETRY_MESSAGE)
      expect((thrown as Error).message).not.toMatch(/requires community tier/)
    })
  })
})
