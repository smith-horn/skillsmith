/**
 * SMI-1059: FeatureChecker Tests
 *
 * Tests for the feature flag checking utilities.
 */

import { describe, it, expect, vi } from 'vitest'
import { FeatureChecker } from '../../src/license/FeatureChecker.js'
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
      team: [
        'team_workspaces',
        'private_skills',
        'usage_analytics',
        'priority_support',
        // SMI-3140: expanded to Team + Enterprise (2026-07-14)
        'compliance_reports',
      ],
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
