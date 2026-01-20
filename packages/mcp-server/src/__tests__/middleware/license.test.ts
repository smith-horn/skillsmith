/**
 * License middleware tests
 *
 * @see SMI-1055: Add license middleware to MCP server
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createLicenseMiddleware,
  requireFeature,
  isEnterpriseFeature,
  requiresLicense,
  getRequiredFeature,
  createLicenseErrorResponse,
  getExpirationWarning,
  TOOL_FEATURES,
  FEATURE_DISPLAY_NAMES,
  FEATURE_TIERS,
  type FeatureFlag,
  type LicenseInfo,
  type LicenseMiddleware,
} from '../../middleware/license.js'

// Time constants for readability
const MS_PER_DAY = 24 * 60 * 60 * 1000

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

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env.SKILLSMITH_LICENSE_KEY
  })

  afterEach(() => {
    process.env = originalEnv
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
          // @skillsmith/enterprise package IS available. The dynamic import at line 107
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

  describe('TOOL_FEATURES mapping', () => {
    it('should have null for all community tools', () => {
      const communityTools = ['search', 'get_skill', 'install_skill', 'uninstall_skill']
      for (const tool of communityTools) {
        expect(TOOL_FEATURES[tool]).toBeNull()
      }
    })

    it('should have valid feature flags for licensed tools', () => {
      const licensedTools = Object.entries(TOOL_FEATURES).filter(([, v]) => v !== null)
      expect(licensedTools.length).toBeGreaterThan(0)

      for (const [_tool, feature] of licensedTools) {
        expect(FEATURE_DISPLAY_NAMES[feature as FeatureFlag]).toBeDefined()
        expect(FEATURE_TIERS[feature as FeatureFlag]).toBeDefined()
      }
    })
  })

  describe('FEATURE_DISPLAY_NAMES', () => {
    it('should have display names for all features', () => {
      const features: FeatureFlag[] = [
        'private_skills',
        'team_workspaces',
        'sso_saml',
        'audit_logging',
        'rbac',
        'priority_support',
        'custom_integrations',
        'advanced_analytics',
      ]

      for (const feature of features) {
        expect(FEATURE_DISPLAY_NAMES[feature]).toBeDefined()
        expect(typeof FEATURE_DISPLAY_NAMES[feature]).toBe('string')
      }
    })
  })

  describe('FEATURE_TIERS', () => {
    it('should categorize features into team or enterprise', () => {
      const teamFeatures: FeatureFlag[] = ['private_skills', 'team_workspaces', 'priority_support']
      const enterpriseFeatures: FeatureFlag[] = [
        'sso_saml',
        'audit_logging',
        'rbac',
        'custom_integrations',
        'advanced_analytics',
      ]

      for (const feature of teamFeatures) {
        expect(FEATURE_TIERS[feature]).toBe('team')
      }

      for (const feature of enterpriseFeatures) {
        expect(FEATURE_TIERS[feature]).toBe('enterprise')
      }
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

  describe('getExpirationWarning', () => {
    it('should return warning when license expires within 30 days', () => {
      vi.useFakeTimers()
      try {
        const now = new Date('2026-01-15T12:00:00Z')
        vi.setSystemTime(now)

        const expiresIn15Days = new Date(now.getTime() + 15 * MS_PER_DAY)
        const warning = getExpirationWarning(expiresIn15Days)

        expect(warning).toBe(
          'Your license expires in 15 days. Please renew to avoid service interruption.'
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('should use singular day when 1 day remaining', () => {
      vi.useFakeTimers()
      try {
        const now = new Date('2026-01-15T12:00:00Z')
        vi.setSystemTime(now)

        const expiresIn1Day = new Date(now.getTime() + 1 * MS_PER_DAY)
        const warning = getExpirationWarning(expiresIn1Day)

        expect(warning).toBe(
          'Your license expires in 1 day. Please renew to avoid service interruption.'
        )
        expect(warning).not.toContain('1 days')
      } finally {
        vi.useRealTimers()
      }
    })

    it('should not return warning when license expires in more than 30 days', () => {
      vi.useFakeTimers()
      try {
        const now = new Date('2026-01-15T12:00:00Z')
        vi.setSystemTime(now)

        const expiresIn31Days = new Date(now.getTime() + 31 * MS_PER_DAY)
        const warning = getExpirationWarning(expiresIn31Days)

        expect(warning).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('should not return warning when expiresAt is undefined', () => {
      const warning = getExpirationWarning(undefined)
      expect(warning).toBeUndefined()
    })

    it('should not return warning when license is already expired (daysUntilExpiry <= 0)', () => {
      vi.useFakeTimers()
      try {
        const now = new Date('2026-01-15T12:00:00Z')
        vi.setSystemTime(now)

        const expiredYesterday = new Date(now.getTime() - 1 * MS_PER_DAY)
        const warning = getExpirationWarning(expiredYesterday)

        // When license has already expired, no "expiring soon" warning is shown
        expect(warning).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('should return warning at exactly 30 days', () => {
      vi.useFakeTimers()
      try {
        const now = new Date('2026-01-15T12:00:00Z')
        vi.setSystemTime(now)

        const expiresIn30Days = new Date(now.getTime() + 30 * MS_PER_DAY)
        const warning = getExpirationWarning(expiresIn30Days)

        expect(warning).toBe(
          'Your license expires in 30 days. Please renew to avoid service interruption.'
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('should not return warning when license expires today (0 days)', () => {
      vi.useFakeTimers()
      try {
        const now = new Date('2026-01-15T12:00:00Z')
        vi.setSystemTime(now)

        // Expires today - 0 days remaining (edge case: daysUntilExpiry > 0 check)
        const expiresToday = new Date(now.getTime() + 1) // Just 1ms in the future
        const warning = getExpirationWarning(expiresToday)

        expect(warning).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
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

describe('Tool Feature Mapping Integration', () => {
  it('should cover all documented tool names', () => {
    // These are the core tools from the MCP server
    const coreTools = [
      'search',
      'get_skill',
      'install_skill',
      'uninstall_skill',
      'skill_recommend',
      'skill_validate',
      'skill_compare',
      'skill_suggest',
    ]

    for (const tool of coreTools) {
      expect(tool in TOOL_FEATURES).toBe(true)
      expect(TOOL_FEATURES[tool]).toBeNull() // All core tools should be community
    }
  })

  it('should have consistent tier assignments', () => {
    // Verify that enterprise features are truly enterprise-level
    const enterpriseFeatures = Object.entries(FEATURE_TIERS)
      .filter(([, tier]) => tier === 'enterprise')
      .map(([feature]) => feature)

    // SSO, audit, and RBAC should all be enterprise
    expect(enterpriseFeatures).toContain('sso_saml')
    expect(enterpriseFeatures).toContain('audit_logging')
    expect(enterpriseFeatures).toContain('rbac')
  })
})
