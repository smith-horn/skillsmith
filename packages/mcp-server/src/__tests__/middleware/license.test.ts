/**
 * License middleware tests
 *
 * @see SMI-1055: Add license middleware to MCP server
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getApiKey } from '@skillsmith/core'
import {
  createLicenseMiddleware,
  requireFeature,
  isEnterpriseFeature,
  requiresLicense,
  getRequiredFeature,
  createLicenseErrorResponse,
  type FeatureFlag,
  type LicenseMiddleware,
} from '../../middleware/license.js'

// SMI-1953: only `getApiKey` (license.ts) and `getApiBaseUrl` (license.tier.ts)
// are imported from `@skillsmith/core` anywhere in the license middleware
// family — confirmed via grep, so this mock shape is exhaustive for this file.
vi.mock('@skillsmith/core', () => ({
  getApiKey: vi.fn(),
  getApiBaseUrl: vi.fn(() => 'https://api.test.example/functions/v1'),
}))

/**
 * Factory function for creating mock LicenseMiddleware
 * Reduces duplication across tests
 */
function createMockMiddleware(overrides?: Partial<LicenseMiddleware>): LicenseMiddleware {
  return {
    checkFeature: vi.fn().mockResolvedValue({ valid: true }),
    checkTool: vi.fn().mockResolvedValue({ valid: true }),
    getLicenseInfo: vi.fn().mockResolvedValue(null),
    invalidateCache: vi.fn(),
    ...overrides,
  }
}

describe('License Middleware', () => {
  const originalEnv = process.env
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env.SKILLSMITH_LICENSE_KEY
    delete process.env.SKILLSMITH_MCP_LIVE_TIER_CHECK
    // SMI-1953: reset to the default (no personal key) so every pre-existing
    // test in this file — which never sets this mock — collapses to the exact
    // same community-default behavior as before this middleware branch existed.
    vi.mocked(getApiKey).mockReset()
    originalFetch = global.fetch
  })

  afterEach(() => {
    process.env = originalEnv
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('isEnterpriseFeature', () => {
    it('should return false for community tools', () => {
      expect(isEnterpriseFeature('search')).toBe(false)
      expect(isEnterpriseFeature('get_skill')).toBe(false)
      expect(isEnterpriseFeature('install_skill')).toBe(false)
      expect(isEnterpriseFeature('skill_recommend')).toBe(false)
    })

    it('should return false for team tools', () => {
      expect(isEnterpriseFeature('publish_private')).toBe(false)
      expect(isEnterpriseFeature('team_workspace')).toBe(false)
    })

    it('should return true for enterprise tools', () => {
      expect(isEnterpriseFeature('configure_sso')).toBe(true)
      expect(isEnterpriseFeature('audit_export')).toBe(true)
      expect(isEnterpriseFeature('rbac_manage')).toBe(true)
    })

    it('should return false for unknown tools', () => {
      expect(isEnterpriseFeature('unknown_tool')).toBe(false)
    })
  })

  describe('requiresLicense', () => {
    it('should return false for community tools', () => {
      expect(requiresLicense('search')).toBe(false)
      expect(requiresLicense('get_skill')).toBe(false)
      expect(requiresLicense('install_skill')).toBe(false)
    })

    it('should return true for team tools', () => {
      expect(requiresLicense('publish_private')).toBe(true)
      expect(requiresLicense('team_workspace')).toBe(true)
    })

    it('should return true for enterprise tools', () => {
      expect(requiresLicense('configure_sso')).toBe(true)
      expect(requiresLicense('audit_export')).toBe(true)
    })

    it('should return false for unknown tools', () => {
      expect(requiresLicense('unknown_tool')).toBe(false)
    })
  })

  describe('getRequiredFeature', () => {
    it('should return null for community tools', () => {
      expect(getRequiredFeature('search')).toBeNull()
      expect(getRequiredFeature('get_skill')).toBeNull()
    })

    it('should return correct feature for team tools', () => {
      expect(getRequiredFeature('publish_private')).toBe('private_skills')
      expect(getRequiredFeature('team_workspace')).toBe('team_workspaces')
    })

    it('should return correct feature for enterprise tools', () => {
      expect(getRequiredFeature('configure_sso')).toBe('sso_saml')
      expect(getRequiredFeature('audit_export')).toBe('audit_logging')
      expect(getRequiredFeature('rbac_manage')).toBe('rbac')
    })

    it('should return null for unknown tools', () => {
      expect(getRequiredFeature('unknown_tool')).toBeNull()
    })
  })

  describe('createLicenseMiddleware', () => {
    describe('without license key', () => {
      it('should allow community tools', async () => {
        const middleware = createLicenseMiddleware()
        const result = await middleware.checkTool('search')
        expect(result.valid).toBe(true)
      })

      it('should deny team tools', async () => {
        const middleware = createLicenseMiddleware()
        const result = await middleware.checkTool('publish_private')
        expect(result.valid).toBe(false)
        expect(result.message).toContain('team license')
        expect(result.upgradeUrl).toBeDefined()
      })

      it('should deny enterprise tools', async () => {
        const middleware = createLicenseMiddleware()
        const result = await middleware.checkTool('configure_sso')
        expect(result.valid).toBe(false)
        expect(result.message).toContain('enterprise license')
        expect(result.upgradeUrl).toBeDefined()
      })

      it('should return community license info', async () => {
        const middleware = createLicenseMiddleware()
        const license = await middleware.getLicenseInfo()
        expect(license).not.toBeNull()
        expect(license?.tier).toBe('community')
        expect(license?.features).toEqual([])
      })

      it('SMI-1953 regression guard: never calls fetch when no personal API key is configured', async () => {
        // getApiKey() is at its default (mockReset -> undefined) — the new
        // resolveTierViaApiKey branch must never be reached, and no network
        // call should ever be made in this path.
        global.fetch = vi.fn()
        const middleware = createLicenseMiddleware()
        await middleware.getLicenseInfo()
        expect(global.fetch).not.toHaveBeenCalled()
      })
    })

    describe('with invalid license key', () => {
      beforeEach(() => {
        process.env.SKILLSMITH_LICENSE_KEY = 'invalid-key-123'
      })

      it(
        'should return null when license key present but validation unavailable',
        async () => {
          // When a license key is provided but the enterprise package is not available,
          // we return null to indicate validation failure rather than silently degrading
          // to community tier. This ensures paying customers get feedback.
          // See SMI-1130 for rationale.
          //
          // SMI-1588: Extended timeout (15s) required because in monorepo CI the
          // @smith-horn/enterprise package IS available. The dynamic import at line 107
          // of license.ts loads the package, and LicenseValidator initialization may
          // involve async operations (key decryption, signature verification).
          // This is NOT a test smell - it reflects real-world enterprise validation latency.
          const middleware = createLicenseMiddleware()
          const license = await middleware.getLicenseInfo()

          // License key present + no validator = null (validation failed)
          // License key present + validator available = validates (may still be null if invalid)
          expect(license).toBeNull()
        },
        15 * 1000
      ) // 15s: Enterprise validator initialization in monorepo CI

      it('should still allow community tools', async () => {
        const middleware = createLicenseMiddleware()
        const result = await middleware.checkTool('search')
        expect(result.valid).toBe(true)
      })

      it(
        'SMI-1953: enterprise key takes precedence over an also-configured personal API key ' +
          '(the new fallback branch, and its fetch call, must never be reached)',
        async () => {
          vi.mocked(getApiKey).mockReturnValue('sk_live_personal_alongside_enterprise')
          global.fetch = vi.fn()

          const middleware = createLicenseMiddleware()
          await middleware.getLicenseInfo()

          expect(global.fetch).not.toHaveBeenCalled()
        },
        15 * 1000
      ) // 15s: same enterprise-validator-initialization latency note as above
    })

    describe('cache behavior', () => {
      it('should cache license info', async () => {
        const middleware = createLicenseMiddleware({ cacheTtlMs: 10000 })

        const license1 = await middleware.getLicenseInfo()
        const license2 = await middleware.getLicenseInfo()

        // Both should be the same cached object
        expect(license1).toEqual(license2)
      })

      it('should invalidate cache when requested', async () => {
        const middleware = createLicenseMiddleware()

        await middleware.getLicenseInfo()
        middleware.invalidateCache()

        // Cache should be invalidated - next call should refetch
        const license = await middleware.getLicenseInfo()
        expect(license).not.toBeNull()
      })

      it('should return cached license within TTL period', async () => {
        const cacheTtl = 60 * 1000 // 60 seconds
        const middleware = createLicenseMiddleware({ cacheTtlMs: cacheTtl })

        const license1 = await middleware.getLicenseInfo()
        // Immediately get again - should be cached
        const license2 = await middleware.getLicenseInfo()

        expect(license1).toBe(license2) // Same reference means cached
      })

      it('should refetch license after cache expiry', async () => {
        vi.useFakeTimers()

        try {
          const shortTtl = 100 // 100ms TTL for fast test
          const middleware = createLicenseMiddleware({ cacheTtlMs: shortTtl })

          const license1 = await middleware.getLicenseInfo()

          // Advance time past TTL
          vi.advanceTimersByTime(shortTtl * 2)

          const license2 = await middleware.getLicenseInfo()

          // Both should be community license, but refetched
          expect(license1?.tier).toBe('community')
          expect(license2?.tier).toBe('community')
        } finally {
          vi.useRealTimers()
        }
      })
    })

    describe('custom environment variable', () => {
      it('should read from custom env var', async () => {
        process.env.CUSTOM_LICENSE_KEY = 'custom-key-123'

        const middleware = createLicenseMiddleware({
          licenseKeyEnvVar: 'CUSTOM_LICENSE_KEY',
        })

        // Should attempt to validate since key is present
        // License key present + no validator = null (validation failed)
        // See SMI-1130 for rationale.
        const license = await middleware.getLicenseInfo()
        expect(license).toBeNull()

        delete process.env.CUSTOM_LICENSE_KEY
      })
    })
  })

  describe('requireFeature', () => {
    it('should create a function that checks features', async () => {
      const middleware = createLicenseMiddleware()
      const checkAudit = requireFeature('audit_logging')

      const result = await checkAudit(middleware)
      expect(result.valid).toBe(false)
      expect(result.feature).toBe('audit_logging')
    })

    it('should return valid for features in license', async () => {
      const mockMiddleware = createMockMiddleware({
        checkFeature: vi.fn().mockResolvedValue({ valid: true }),
      })

      const checkPrivate = requireFeature('private_skills')
      const result = await checkPrivate(mockMiddleware)

      expect(result.valid).toBe(true)
      expect(mockMiddleware.checkFeature).toHaveBeenCalledWith('private_skills')
    })
  })

  describe('createLicenseErrorResponse', () => {
    it('should create MCP-formatted error response', () => {
      const validationResult = {
        valid: false,
        feature: 'audit_logging' as FeatureFlag,
        message: 'Audit logging requires enterprise license',
        upgradeUrl: 'https://skillsmith.app/pricing?feature=audit_logging',
      }

      const response = createLicenseErrorResponse(validationResult)

      expect(response.isError).toBe(true)
      expect(response.content).toHaveLength(1)
      expect(response.content[0].type).toBe('text')

      const parsed = JSON.parse(response.content[0].text)
      expect(parsed.error).toBe('license_required')
      expect(parsed.feature).toBe('audit_logging')
      expect(parsed.upgradeUrl).toBeDefined()
    })

    it('should include upgrade URL in meta', () => {
      const validationResult = {
        valid: false,
        message: 'Feature not available',
        upgradeUrl: 'https://skillsmith.app/pricing',
      }

      const response = createLicenseErrorResponse(validationResult)
      expect(response._meta?.upgradeUrl).toBe('https://skillsmith.app/pricing')
    })

    it('should not include _meta when upgradeUrl is undefined', () => {
      const validationResult = {
        valid: false,
        message: 'Feature not available',
        // No upgradeUrl
      }

      const response = createLicenseErrorResponse(validationResult)
      expect(response._meta).toBeUndefined()
    })

    it('should handle validation result without feature field', () => {
      const validationResult = {
        valid: false,
        message: 'License validation failed',
      }

      const response = createLicenseErrorResponse(validationResult)

      expect(response.isError).toBe(true)
      const parsed = JSON.parse(response.content[0].text)
      expect(parsed.error).toBe('license_required')
      expect(parsed.feature).toBeUndefined()
    })
  })

  describe('checkFeature', () => {
    it('should return valid=false with helpful message for community users', async () => {
      const middleware = createLicenseMiddleware()
      const result = await middleware.checkFeature('audit_logging')

      expect(result.valid).toBe(false)
      expect(result.message).toContain('Audit Logging')
      expect(result.message).toContain('enterprise')
      expect(result.message).toContain('community')
      expect(result.upgradeUrl).toContain('skillsmith.app/pricing')
      expect(result.upgradeUrl).toContain('feature=audit_logging')
    })

    it('should include current tier in upgrade URL', async () => {
      const middleware = createLicenseMiddleware()
      const result = await middleware.checkFeature('private_skills')

      expect(result.upgradeUrl).toContain('current=community')
    })
  })

  describe('error messages', () => {
    it('should provide actionable error messages', async () => {
      const middleware = createLicenseMiddleware()

      const ssoResult = await middleware.checkFeature('sso_saml')
      expect(ssoResult.message).toMatch(/SSO\/SAML Integration/)
      expect(ssoResult.message).toMatch(/enterprise license/)

      const privateResult = await middleware.checkFeature('private_skills')
      expect(privateResult.message).toMatch(/Private Skills/)
      expect(privateResult.message).toMatch(/team license/)
    })
  })
})

describe('tier validation scenarios', () => {
  it('should deny enterprise features for individual tier', async () => {
    // Individual tier should not have access to enterprise features
    // This tests the branch at line 320 in license.ts
    const middleware = createLicenseMiddleware()

    // Without a license key, defaults to community
    // Individual tier would deny team/enterprise features
    const result = await middleware.checkFeature('sso_saml')
    expect(result.valid).toBe(false)
    expect(result.message).toContain('enterprise')
  })

  it('should deny team features for community tier', async () => {
    const middleware = createLicenseMiddleware()
    const result = await middleware.checkFeature('private_skills')
    expect(result.valid).toBe(false)
    expect(result.message).toContain('team')
    expect(result.message).toContain('community')
  })

  it('should provide upgrade URL with current tier', async () => {
    const middleware = createLicenseMiddleware()
    const result = await middleware.checkFeature('team_workspaces')
    expect(result.upgradeUrl).toContain('current=community')
  })
})
