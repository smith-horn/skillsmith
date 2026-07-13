/**
 * License tier-resolution tests
 *
 * Split from license.test.ts (SMI-1953, 500-line standard) to mirror the
 * license.ts / license.tier.ts implementation split. Covers:
 * - Live tier resolution via a personal API key (license.tier.ts)
 * - Enterprise-validator LicenseInfo structure (mock-only, no license.ts call)
 *
 * @see SMI-1055: Add license middleware to MCP server
 * @see SMI-1953: MCP server never resolves a paying customer's real subscription tier
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getApiKey } from '@skillsmith/core'
import {
  createLicenseMiddleware,
  featuresForTier,
  FEATURE_TIERS,
  type FeatureFlag,
  type LicenseInfo,
  type LicenseTier,
} from '../../middleware/license.js'

// SMI-1953: only `getApiKey` (license.ts) and `getApiBaseUrl` (license.tier.ts)
// are imported from `@skillsmith/core` anywhere in the license middleware
// family — confirmed via grep, so this mock shape is exhaustive for this file.
vi.mock('@skillsmith/core', () => ({
  getApiKey: vi.fn(),
  getApiBaseUrl: vi.fn(() => 'https://api.test.example/functions/v1'),
}))

describe('SMI-1953: live tier resolution via personal API key', () => {
  const originalEnv = process.env
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.SKILLSMITH_LICENSE_KEY
    delete process.env.SKILLSMITH_MCP_LIVE_TIER_CHECK
    // Reset to the default (no personal key) unless a test opts in.
    vi.mocked(getApiKey).mockReset()
    originalFetch = global.fetch
  })

  afterEach(() => {
    process.env = originalEnv
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('valid Individual-tier key', () => {
    beforeEach(() => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_individual_test')
      global.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              authenticated: true,
              tier: 'individual',
              rateLimit: 60,
              userId: 'user-1',
            },
          }),
          { status: 200 }
        )
      )
    })

    it('resolves tier: individual', async () => {
      const middleware = createLicenseMiddleware()
      const license = await middleware.getLicenseInfo()
      expect(license?.tier).toBe('individual')
    })

    it('allows basic_analytics (an individual-tier feature)', async () => {
      const middleware = createLicenseMiddleware()
      const result = await middleware.checkFeature('basic_analytics')
      expect(result.valid).toBe(true)
    })

    it('still denies private_skills (a team-tier feature)', async () => {
      const middleware = createLicenseMiddleware()
      const result = await middleware.checkFeature('private_skills')
      expect(result.valid).toBe(false)
    })
  })

  describe('valid Team-tier key', () => {
    beforeEach(() => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_team_test')
      global.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: { authenticated: true, tier: 'team', rateLimit: 120, userId: 'user-2' },
          }),
          { status: 200 }
        )
      )
    })

    it('allows skill_updates (the exact SMI-1953 reopen-comment repro tool)', async () => {
      const middleware = createLicenseMiddleware()
      const result = await middleware.checkTool('skill_updates')
      expect(result.valid).toBe(true)
    })

    it('allows team_workspace (a team-scoped tool, not just the flat skill_updates)', async () => {
      const middleware = createLicenseMiddleware()
      const result = await middleware.checkTool('team_workspace')
      expect(result.valid).toBe(true)
    })

    it('still denies sso_saml (an enterprise-tier feature)', async () => {
      const middleware = createLicenseMiddleware()
      const result = await middleware.checkFeature('sso_saml')
      expect(result.valid).toBe(false)
    })
  })

  describe('featuresForTier (exhaustive parameterized boundary test)', () => {
    // Same total ordering as license.tier.ts's internal (unexported)
    // TIER_RANK — iterated over the FULL FEATURE_TIERS object below, not a
    // hand-picked subset, per the plan's review note (M4).
    const TIER_RANK: Record<LicenseTier, number> = {
      community: 0,
      individual: 1,
      team: 2,
      enterprise: 3,
    }
    const ALL_TIERS: LicenseTier[] = ['community', 'individual', 'team', 'enterprise']

    for (const tier of ALL_TIERS) {
      for (const flag of Object.keys(FEATURE_TIERS) as FeatureFlag[]) {
        const expected = TIER_RANK[FEATURE_TIERS[flag]] <= TIER_RANK[tier]
        it(`tier '${tier}' ${expected ? 'includes' : 'excludes'} feature '${flag}'`, () => {
          expect(featuresForTier(tier).includes(flag)).toBe(expected)
        })
      }
    }
  })

  describe('invalid/expired key', () => {
    beforeEach(() => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_invalid_test')
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: { authenticated: false } }), { status: 200 })
        )
    })

    it('returns a community LicenseInfo, not null, not a throw', async () => {
      const middleware = createLicenseMiddleware()
      const license = await middleware.getLicenseInfo()
      expect(license).not.toBeNull()
      expect(license?.tier).toBe('community')
      expect(license?.features).toEqual([])
    })
  })

  describe('transient failures — no prior cache', () => {
    beforeEach(() => {
      vi.mocked(getApiKey).mockReturnValue('sk_live_transient_test')
    })

    it('network error falls back to community, never throws', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network error'))
      const middleware = createLicenseMiddleware()
      const license = await middleware.getLicenseInfo()
      expect(license).not.toBeNull()
      expect(license?.tier).toBe('community')
    })

    it("HTTP 429 (license-status's own abuse rate limit) falls back to community, never throws", async () => {
      global.fetch = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))
      const middleware = createLicenseMiddleware()
      const license = await middleware.getLicenseInfo()
      expect(license).not.toBeNull()
      expect(license?.tier).toBe('community')
    })

    it('HTTP 500 falls back to community, never throws', async () => {
      global.fetch = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }))
      const middleware = createLicenseMiddleware()
      const license = await middleware.getLicenseInfo()
      expect(license).not.toBeNull()
      expect(license?.tier).toBe('community')
    })

    it('a malformed JSON body falls back to community, never throws', async () => {
      global.fetch = vi.fn().mockResolvedValue(new Response('not-json{{{', { status: 200 }))
      const middleware = createLicenseMiddleware()
      const license = await middleware.getLicenseInfo()
      expect(license).not.toBeNull()
      expect(license?.tier).toBe('community')
    })
  })

  describe('transient failures — stale-if-error (C1 regression class)', () => {
    it('serves the last-resolved tier instead of demoting to community on a later transient failure', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(getApiKey).mockReturnValue('sk_live_stale_test')

        // First call: successfully resolve + cache 'team' with a very short TTL.
        global.fetch = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              data: { authenticated: true, tier: 'team', rateLimit: 120, userId: 'user-3' },
            }),
            { status: 200 }
          )
        )
        const shortTtl = 100
        const middleware = createLicenseMiddleware({ cacheTtlMs: shortTtl })

        const first = await middleware.getLicenseInfo()
        expect(first?.tier).toBe('team')

        // Advance past the cache TTL so the next call is forced to refetch.
        vi.advanceTimersByTime(shortTtl * 2)

        // Second call: transient network failure — must NOT demote to community.
        global.fetch = vi.fn().mockRejectedValue(new Error('network error'))
        const second = await middleware.getLicenseInfo()

        expect(second?.tier).toBe('team')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('kill switch: SKILLSMITH_MCP_LIVE_TIER_CHECK=false', () => {
    it('skips the live check, returns community, never calls fetch, and logs a warning', async () => {
      process.env.SKILLSMITH_MCP_LIVE_TIER_CHECK = 'false'
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      // Constructing the middleware alone should warn (loud-at-construction-time).
      const middleware = createLicenseMiddleware()
      expect(warnSpy).toHaveBeenCalled()

      vi.mocked(getApiKey).mockReturnValue('sk_live_killswitch_test')
      global.fetch = vi.fn()

      const license = await middleware.getLicenseInfo()

      expect(license?.tier).toBe('community')
      expect(global.fetch).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
    })
  })
})

describe('with mocked enterprise validator', () => {
  it('should validate team license features', async () => {
    const mockValidator = {
      validate: vi.fn().mockResolvedValue({
        valid: true,
        license: {
          tier: 'team' as const,
          features: ['private_skills', 'team_workspaces'] as FeatureFlag[],
          customerId: 'test-customer',
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        },
      }),
      hasFeature: vi.fn().mockResolvedValue(true),
    }

    // Test the validator mock structure matches expected interface
    const validationResult = await mockValidator.validate('test-key')
    expect(validationResult.valid).toBe(true)
    expect(validationResult.license?.tier).toBe('team')
    expect(validationResult.license?.features).toContain('private_skills')
    expect(validationResult.license?.features).toContain('team_workspaces')
    expect(mockValidator.validate).toHaveBeenCalledWith('test-key')
  })

  it('should validate enterprise license features', async () => {
    const mockValidator = {
      validate: vi.fn().mockResolvedValue({
        valid: true,
        license: {
          tier: 'enterprise' as const,
          features: [
            'private_skills',
            'team_workspaces',
            'sso_saml',
            'audit_logging',
            'rbac',
          ] as FeatureFlag[],
          customerId: 'enterprise-customer',
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        },
      }),
      hasFeature: vi.fn().mockImplementation((_key: string, feature: string) => {
        const enterpriseFeatures = [
          'private_skills',
          'team_workspaces',
          'sso_saml',
          'audit_logging',
          'rbac',
        ]
        return Promise.resolve(enterpriseFeatures.includes(feature))
      }),
    }

    // Validate enterprise license structure
    const validationResult = await mockValidator.validate('enterprise-key')
    expect(validationResult.valid).toBe(true)
    expect(validationResult.license?.tier).toBe('enterprise')
    expect(validationResult.license?.features).toContain('sso_saml')
    expect(validationResult.license?.features).toContain('audit_logging')
    expect(validationResult.license?.features).toContain('rbac')

    // Test hasFeature method
    expect(await mockValidator.hasFeature('enterprise-key', 'sso_saml')).toBe(true)
    expect(await mockValidator.hasFeature('enterprise-key', 'audit_logging')).toBe(true)
    expect(await mockValidator.hasFeature('enterprise-key', 'unknown_feature')).toBe(false)
  })

  it('should handle validation failure', async () => {
    const mockValidator = {
      validate: vi.fn().mockResolvedValue({
        valid: false,
        error: { code: 'INVALID_LICENSE', message: 'License expired' },
      }),
      hasFeature: vi.fn().mockResolvedValue(false),
    }

    // Test validation failure
    const validationResult = await mockValidator.validate('expired-key')
    expect(validationResult.valid).toBe(false)
    expect(validationResult.error?.code).toBe('INVALID_LICENSE')
    expect(validationResult.error?.message).toBe('License expired')
    expect(validationResult.license).toBeUndefined()

    // hasFeature should return false for invalid license
    expect(await mockValidator.hasFeature('expired-key', 'any_feature')).toBe(false)
  })

  it('should handle validation exception', async () => {
    const mockValidator = {
      validate: vi.fn().mockRejectedValue(new Error('Network error')),
      hasFeature: vi.fn().mockRejectedValue(new Error('Network error')),
    }

    // Test validation exception handling
    await expect(mockValidator.validate('test-key')).rejects.toThrow('Network error')
    await expect(mockValidator.hasFeature('test-key', 'feature')).rejects.toThrow('Network error')
  })

  it('should verify LicenseInfo structure matches enterprise license', async () => {
    const mockEnterpriseLicense = {
      tier: 'enterprise' as const,
      features: ['sso_saml', 'audit_logging'] as FeatureFlag[],
      customerId: 'test-customer',
      issuedAt: new Date('2024-01-01'),
      expiresAt: new Date('2025-01-01'),
    }

    // Convert to middleware LicenseInfo format (as done in getLicenseInfo)
    const licenseInfo: LicenseInfo = {
      valid: true,
      tier: mockEnterpriseLicense.tier,
      features: mockEnterpriseLicense.features,
      expiresAt: mockEnterpriseLicense.expiresAt,
      organizationId: mockEnterpriseLicense.customerId,
    }

    expect(licenseInfo.valid).toBe(true)
    expect(licenseInfo.tier).toBe('enterprise')
    expect(licenseInfo.features).toEqual(['sso_saml', 'audit_logging'])
    expect(licenseInfo.expiresAt).toEqual(new Date('2025-01-01'))
    expect(licenseInfo.organizationId).toBe('test-customer')
  })
})
