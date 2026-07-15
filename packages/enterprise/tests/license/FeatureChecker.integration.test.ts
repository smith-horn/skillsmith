/**
 * SMI-1059: FeatureChecker Tests — FeatureRequiredError, withFeatureCheck,
 *   assertFeature helper, and integration tests.
 *
 * Split from FeatureChecker.test.ts to stay under the 500-line file gate.
 * The `FeatureChecker` describe block (constructor, checkFeature,
 * checkFeatures, getAvailableFeatures, getMissingFeatures, assertFeature,
 * getTier, getValidator) remains in FeatureChecker.test.ts.
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
      // SMI-3140: expanded to Team + Enterprise (2026-07-14)
      'compliance_reports',
    ]

    for (const feature of teamFeatures) {
      expect(checker.checkFeature(feature)).toBe(true)
    }

    // Enterprise-only features should not be available
    const enterpriseFeatures: FeatureFlag[] = [
      'sso_saml',
      'rbac',
      'audit_logging',
      'siem_export',
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
