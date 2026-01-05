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
  TOOL_FEATURES,
  FEATURE_DISPLAY_NAMES,
  FEATURE_TIERS,
  type FeatureFlag,
  type LicenseInfo,
} from '../../middleware/license.js'

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

    describe('with invalid license key (no enterprise package)', () => {
      beforeEach(() => {
        process.env.SKILLSMITH_LICENSE_KEY = 'invalid-key-123'
      })

      it('should treat as community when enterprise package unavailable', async () => {
        const middleware = createLicenseMiddleware()
        const license = await middleware.getLicenseInfo()
        expect(license?.tier).toBe('community')
      })

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
    })

    describe('custom environment variable', () => {
      it('should read from custom env var', async () => {
        process.env.CUSTOM_LICENSE_KEY = 'custom-key-123'

        const middleware = createLicenseMiddleware({
          licenseKeyEnvVar: 'CUSTOM_LICENSE_KEY',
        })

        // Should attempt to validate since key is present
        // Without enterprise package, will fall back to community
        const license = await middleware.getLicenseInfo()
        expect(license?.tier).toBe('community')

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
      // Mock a licensed middleware
      const mockMiddleware = {
        checkFeature: vi.fn().mockResolvedValue({ valid: true }),
        checkTool: vi.fn(),
        getLicenseInfo: vi.fn(),
        invalidateCache: vi.fn(),
      }

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
        upgradeUrl: 'https://skillsmith.io/pricing?feature=audit_logging',
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
        upgradeUrl: 'https://skillsmith.io/pricing',
      }

      const response = createLicenseErrorResponse(validationResult)
      expect(response._meta?.upgradeUrl).toBe('https://skillsmith.io/pricing')
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

      for (const [tool, feature] of licensedTools) {
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
      expect(result.upgradeUrl).toContain('skillsmith.io/pricing')
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
