/**
 * SMI-1059: FeatureChecker Tests
 *
 * Tests for the feature flag checking utilities.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  FeatureChecker,
  withFeatureCheck,
  assertFeature,
} from '../../src/license/FeatureChecker.js'
import { FeatureRequiredError } from '../../src/license/FeatureRequiredError.js'
import { LicenseValidator } from '../../src/license/LicenseValidator.js'
import type { FeatureFlag, License, LicenseTier } from '../../src/license/types.js'

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock LicenseValidator with specified tier and features
 */
function createMockValidator(tier: LicenseTier, features: FeatureFlag[] = []): LicenseValidator {
  const validator = new LicenseValidator()

  // Mock the internal state by setting a license
  const license: License = {
    tier,
    features,
    customerId: 'test-customer',
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    rawToken: 'mock-token',
  }

  // Use vi.spyOn to mock the methods
  vi.spyOn(validator, 'getLicense').mockReturnValue(license)
  vi.spyOn(validator, 'getTier').mockReturnValue(tier)
  vi.spyOn(validator, 'hasFeature').mockImplementation((feature: FeatureFlag) => {
    // Check explicit features
    if (features.includes(feature)) {
      return true
    }

    // Check tier-based features
    const tierFeatures: Record<LicenseTier, FeatureFlag[]> = {
      individual: ['basic_analytics', 'email_support'],
      community: [],
      team: ['team_workspaces', 'private_skills', 'usage_analytics', 'priority_support'],
      enterprise: [
        'team_workspaces',
        'private_skills',
        'usage_analytics',
        'priority_support',
        'sso_saml',
        'rbac',
        'audit_logging',
        'siem_export',
        'compliance_reports',
        'private_registry',
        'custom_integrations',
        'advanced_analytics',
      ],
    }

    return tierFeatures[tier].includes(feature)
  })

  return validator
}

// ============================================================================
// FeatureChecker Tests
// ============================================================================

describe('FeatureChecker', () => {
  describe('constructor', () => {
    it('should create a FeatureChecker with a validator', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      expect(checker).toBeInstanceOf(FeatureChecker)
      expect(checker.getValidator()).toBe(validator)
    })
  })

  describe('checkFeature', () => {
    it('should return true for features available in the tier', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      expect(checker.checkFeature('team_workspaces')).toBe(true)
      expect(checker.checkFeature('private_skills')).toBe(true)
      expect(checker.checkFeature('usage_analytics')).toBe(true)
      expect(checker.checkFeature('priority_support')).toBe(true)
    })

    it('should return false for features not in the tier', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      expect(checker.checkFeature('sso_saml')).toBe(false)
      expect(checker.checkFeature('rbac')).toBe(false)
      expect(checker.checkFeature('audit_logging')).toBe(false)
    })

    it('should return true for all features in enterprise tier', () => {
      const validator = createMockValidator('enterprise')
      const checker = new FeatureChecker(validator)

      expect(checker.checkFeature('team_workspaces')).toBe(true)
      expect(checker.checkFeature('sso_saml')).toBe(true)
      expect(checker.checkFeature('rbac')).toBe(true)
      expect(checker.checkFeature('audit_logging')).toBe(true)
      expect(checker.checkFeature('private_registry')).toBe(true)
    })

    it('should return false for all features in community tier', () => {
      const validator = createMockValidator('community')
      const checker = new FeatureChecker(validator)

      expect(checker.checkFeature('team_workspaces')).toBe(false)
      expect(checker.checkFeature('sso_saml')).toBe(false)
    })
  })

  describe('checkFeatures', () => {
    it('should return a map of feature availability', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      const features: FeatureFlag[] = ['team_workspaces', 'sso_saml', 'rbac']
      const results = checker.checkFeatures(features)

      expect(results).toBeInstanceOf(Map)
      expect(results.get('team_workspaces')).toBe(true)
      expect(results.get('sso_saml')).toBe(false)
      expect(results.get('rbac')).toBe(false)
    })

    it('should handle empty array', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      const results = checker.checkFeatures([])

      expect(results).toBeInstanceOf(Map)
      expect(results.size).toBe(0)
    })

    it('should check all features for enterprise tier', () => {
      const validator = createMockValidator('enterprise')
      const checker = new FeatureChecker(validator)

      const features: FeatureFlag[] = [
        'team_workspaces',
        'sso_saml',
        'rbac',
        'audit_logging',
        'private_registry',
      ]
      const results = checker.checkFeatures(features)

      for (const feature of features) {
        expect(results.get(feature)).toBe(true)
      }
    })
  })

  describe('getAvailableFeatures', () => {
    it('should return team features for team tier', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      const available = checker.getAvailableFeatures()

      expect(available).toContain('team_workspaces')
      expect(available).toContain('private_skills')
      expect(available).toContain('usage_analytics')
      expect(available).toContain('priority_support')
      expect(available).not.toContain('sso_saml')
      expect(available).not.toContain('rbac')
    })

    it('should return all features for enterprise tier', () => {
      const validator = createMockValidator('enterprise')
      const checker = new FeatureChecker(validator)

      const available = checker.getAvailableFeatures()

      expect(available).toContain('team_workspaces')
      expect(available).toContain('sso_saml')
      expect(available).toContain('rbac')
      expect(available).toContain('audit_logging')
      expect(available).toContain('private_registry')
    })

    it('should return empty array for community tier', () => {
      const validator = createMockValidator('community')
      const checker = new FeatureChecker(validator)

      const available = checker.getAvailableFeatures()

      expect(available).toEqual([])
    })

    it('should include explicit features from license', () => {
      // Team tier with an extra enterprise feature granted
      const validator = createMockValidator('team', ['sso_saml'])
      const checker = new FeatureChecker(validator)

      const available = checker.getAvailableFeatures()

      expect(available).toContain('team_workspaces')
      expect(available).toContain('sso_saml') // Explicitly granted
    })
  })

  describe('getMissingFeatures', () => {
    it('should return features not available in the tier', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      const required: FeatureFlag[] = ['team_workspaces', 'sso_saml', 'rbac']
      const missing = checker.getMissingFeatures(required)

      expect(missing).toEqual(['sso_saml', 'rbac'])
    })

    it('should return empty array when all features are available', () => {
      const validator = createMockValidator('enterprise')
      const checker = new FeatureChecker(validator)

      const required: FeatureFlag[] = ['team_workspaces', 'sso_saml', 'rbac']
      const missing = checker.getMissingFeatures(required)

      expect(missing).toEqual([])
    })

    it('should return all features for community tier', () => {
      const validator = createMockValidator('community')
      const checker = new FeatureChecker(validator)

      const required: FeatureFlag[] = ['team_workspaces', 'sso_saml']
      const missing = checker.getMissingFeatures(required)

      expect(missing).toEqual(['team_workspaces', 'sso_saml'])
    })

    it('should handle empty required array', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      const missing = checker.getMissingFeatures([])

      expect(missing).toEqual([])
    })
  })

  describe('assertFeature', () => {
    it('should not throw for available features', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      expect(() => checker.assertFeature('team_workspaces')).not.toThrow()
    })

    it('should throw FeatureRequiredError for unavailable features', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      expect(() => checker.assertFeature('sso_saml')).toThrow(FeatureRequiredError)
    })

    it('should include correct error details', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      try {
        checker.assertFeature('sso_saml')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(FeatureRequiredError)
        const featureError = error as FeatureRequiredError
        expect(featureError.feature).toBe('sso_saml')
        expect(featureError.requiredTier).toBe('enterprise')
        expect(featureError.currentTier).toBe('team')
      }
    })
  })

  describe('getTier', () => {
    it('should return the current tier', () => {
      const validator = createMockValidator('enterprise')
      const checker = new FeatureChecker(validator)

      expect(checker.getTier()).toBe('enterprise')
    })
  })

  describe('getValidator', () => {
    it('should return the underlying validator', () => {
      const validator = createMockValidator('team')
      const checker = new FeatureChecker(validator)

      expect(checker.getValidator()).toBe(validator)
    })
  })
})

// ============================================================================
// FeatureRequiredError Tests
// ============================================================================

describe('FeatureRequiredError', () => {
  it('should create an error with correct properties', () => {
    const error = new FeatureRequiredError('sso_saml', 'enterprise', 'team')

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(FeatureRequiredError)
    expect(error.name).toBe('FeatureRequiredError')
    expect(error.feature).toBe('sso_saml')
    expect(error.requiredTier).toBe('enterprise')
    expect(error.currentTier).toBe('team')
  })

  it('should have a descriptive message', () => {
    const error = new FeatureRequiredError('sso_saml', 'enterprise', 'team')

    expect(error.message).toBe(
      "Feature 'sso_saml' requires 'enterprise' tier, but current tier is 'team'"
    )
  })

  it('should work with different features and tiers', () => {
    const error = new FeatureRequiredError('team_workspaces', 'team', 'community')

    expect(error.feature).toBe('team_workspaces')
    expect(error.requiredTier).toBe('team')
    expect(error.currentTier).toBe('community')
    expect(error.message).toContain('team_workspaces')
    expect(error.message).toContain('team')
    expect(error.message).toContain('community')
  })

  it('should have a stack trace', () => {
    const error = new FeatureRequiredError('sso_saml', 'enterprise', 'team')

    expect(error.stack).toBeDefined()
    expect(error.stack).toContain('FeatureRequiredError')
  })
})

// ============================================================================
// withFeatureCheck Helper Tests
// ============================================================================

describe('withFeatureCheck', () => {
  it('should execute the main function when feature is available', () => {
    const validator = createMockValidator('team')
    const checker = new FeatureChecker(validator)

    const mainFn = vi.fn(() => 'main result')
    const fallbackFn = vi.fn(() => 'fallback result')

    const wrapped = withFeatureCheck(checker, 'team_workspaces', fallbackFn)(mainFn)
    const result = wrapped()

    expect(result).toBe('main result')
    expect(mainFn).toHaveBeenCalledTimes(1)
    expect(fallbackFn).not.toHaveBeenCalled()
  })

  it('should execute fallback when feature is unavailable', () => {
    const validator = createMockValidator('team')
    const checker = new FeatureChecker(validator)

    const mainFn = vi.fn(() => 'main result')
    const fallbackFn = vi.fn(() => 'fallback result')

    const wrapped = withFeatureCheck(checker, 'sso_saml', fallbackFn)(mainFn)
    const result = wrapped()

    expect(result).toBe('fallback result')
    expect(mainFn).not.toHaveBeenCalled()
    expect(fallbackFn).toHaveBeenCalledTimes(1)
  })

  it('should throw FeatureRequiredError when no fallback provided and feature unavailable', () => {
    const validator = createMockValidator('team')
    const checker = new FeatureChecker(validator)

    const mainFn = vi.fn(() => 'main result')

    const wrapped = withFeatureCheck(checker, 'sso_saml')(mainFn)

    expect(() => wrapped()).toThrow(FeatureRequiredError)
    expect(mainFn).not.toHaveBeenCalled()
  })

  it('should work with functions returning different types', () => {
    const validator = createMockValidator('enterprise')
    const checker = new FeatureChecker(validator)

    // Number
    const numberFn = withFeatureCheck(checker, 'sso_saml')(() => 42)
    expect(numberFn()).toBe(42)

    // Object
    const objectFn = withFeatureCheck(checker, 'rbac')(() => ({ enabled: true }))
    expect(objectFn()).toEqual({ enabled: true })

    // Array
    const arrayFn = withFeatureCheck(checker, 'audit_logging')(() => [1, 2, 3])
    expect(arrayFn()).toEqual([1, 2, 3])
  })
})

// ============================================================================
// assertFeature Helper Tests
// ============================================================================

describe('assertFeature helper', () => {
  it('should not throw for available features', () => {
    const validator = createMockValidator('enterprise')
    const checker = new FeatureChecker(validator)

    expect(() => assertFeature(checker, 'sso_saml')).not.toThrow()
  })

  it('should throw FeatureRequiredError for unavailable features', () => {
    const validator = createMockValidator('team')
    const checker = new FeatureChecker(validator)

    expect(() => assertFeature(checker, 'sso_saml')).toThrow(FeatureRequiredError)
  })
})

// ============================================================================
// Integration Tests
// ============================================================================

describe('FeatureChecker integration', () => {
  it('should work with real tier feature mappings', () => {
    const validator = createMockValidator('team')
    const checker = new FeatureChecker(validator)

    // Team features should be available
    const teamFeatures: FeatureFlag[] = [
      'team_workspaces',
      'private_skills',
      'usage_analytics',
      'priority_support',
    ]

    for (const feature of teamFeatures) {
      expect(checker.checkFeature(feature)).toBe(true)
    }

    // Enterprise features should not be available
    const enterpriseFeatures: FeatureFlag[] = [
      'sso_saml',
      'rbac',
      'audit_logging',
      'siem_export',
      'compliance_reports',
      'private_registry',
    ]

    for (const feature of enterpriseFeatures) {
      expect(checker.checkFeature(feature)).toBe(false)
    }
  })

  it('should correctly identify missing features for upgrade prompts', () => {
    const validator = createMockValidator('team')
    const checker = new FeatureChecker(validator)

    // User wants these features
    const desiredFeatures: FeatureFlag[] = [
      'team_workspaces', // Has
      'sso_saml', // Missing
      'rbac', // Missing
      'private_skills', // Has
    ]

    const missing = checker.getMissingFeatures(desiredFeatures)

    expect(missing).toEqual(['sso_saml', 'rbac'])
    expect(missing.length).toBe(2)
  })

  it('should support feature-gated function execution', () => {
    const validator = createMockValidator('team')
    const checker = new FeatureChecker(validator)

    // Simulating feature-gated code
    const getSSOSettings = withFeatureCheck(
      checker,
      'sso_saml',
      (): { enabled: boolean; provider: string | null } => ({
        enabled: false,
        provider: null,
      })
    )(() => ({
      enabled: true,
      provider: 'okta',
      endpoint: 'https://sso.example.com',
    }))

    const result = getSSOSettings()

    // Should return fallback since team tier doesn't have SSO
    expect(result).toEqual({ enabled: false, provider: null })
  })
})
