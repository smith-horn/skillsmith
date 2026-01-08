/**
 * SMI-1061: License Error Classes Test Suite
 *
 * Comprehensive tests for license error handling classes.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  LicenseError,
  LicenseExpiredError,
  LicenseInvalidError,
  LicenseNotFoundError,
  FeatureNotAvailableError,
  LicenseQuotaExceededError,
  LICENSE_ERROR_CODES,
  isLicenseError,
  isLicenseExpiredError,
  isLicenseInvalidError,
  isLicenseNotFoundError,
  isFeatureNotAvailableError,
  isLicenseQuotaExceededError,
  createLicenseError,
} from '../../../src/license/errors/index.js'

// ============================================================================
// LicenseError Base Class Tests
// ============================================================================

describe('LicenseError', () => {
  it('should create a basic license error', () => {
    const error = new LicenseError('Test error message', {
      code: LICENSE_ERROR_CODES.LICENSE_INVALID,
    })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(LicenseError)
    expect(error.name).toBe('LicenseError')
    expect(error.message).toBe('Test error message')
    expect(error.code).toBe('E002')
  })

  it('should include all provided details', () => {
    const error = new LicenseError('Test error', {
      code: LICENSE_ERROR_CODES.FEATURE_NOT_AVAILABLE,
      currentTier: 'team',
      requiredTier: 'enterprise',
      feature: 'audit_logging',
      upgradeUrl: 'https://example.com/upgrade',
      context: { extra: 'data' },
    })

    expect(error.code).toBe('E004')
    expect(error.currentTier).toBe('team')
    expect(error.requiredTier).toBe('enterprise')
    expect(error.feature).toBe('audit_logging')
    expect(error.upgradeUrl).toBe('https://example.com/upgrade')
    expect(error.context).toEqual({ extra: 'data' })
  })

  it('should use default upgrade URL when not provided', () => {
    const error = new LicenseError('Test error', {
      code: LICENSE_ERROR_CODES.LICENSE_INVALID,
    })

    expect(error.upgradeUrl).toBe('https://skillsmith.app/upgrade')
  })

  it('should have a timestamp', () => {
    const before = new Date()
    const error = new LicenseError('Test error', {
      code: LICENSE_ERROR_CODES.LICENSE_INVALID,
    })
    const after = new Date()

    expect(error.timestamp).toBeInstanceOf(Date)
    expect(error.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(error.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it('should serialize to JSON correctly', () => {
    const error = new LicenseError('Test error', {
      code: LICENSE_ERROR_CODES.FEATURE_NOT_AVAILABLE,
      currentTier: 'team',
      requiredTier: 'enterprise',
      feature: 'sso_saml',
    })

    const json = error.toJSON()

    expect(json['name']).toBe('LicenseError')
    expect(json['message']).toBe('Test error')
    expect(json['code']).toBe('E004')
    expect(json['currentTier']).toBe('team')
    expect(json['requiredTier']).toBe('enterprise')
    expect(json['feature']).toBe('sso_saml')
    expect(typeof json['timestamp']).toBe('string')
  })

  it('should have a proper stack trace', () => {
    const error = new LicenseError('Test error', {
      code: LICENSE_ERROR_CODES.LICENSE_INVALID,
    })

    expect(error.stack).toBeDefined()
    expect(error.stack).toContain('LicenseError')
  })
})

// ============================================================================
// LicenseExpiredError Tests
// ============================================================================

describe('LicenseExpiredError', () => {
  it('should create an expired license error', () => {
    const expiredAt = new Date('2024-01-15T12:00:00Z')
    const error = new LicenseExpiredError(expiredAt, 'enterprise')

    expect(error).toBeInstanceOf(LicenseError)
    expect(error).toBeInstanceOf(LicenseExpiredError)
    expect(error.name).toBe('LicenseExpiredError')
    expect(error.code).toBe('E001')
    expect(error.expiredAt).toEqual(expiredAt)
    expect(error.currentTier).toBe('enterprise')
    expect(error.message).toContain('2024-01-15')
  })

  it('should have renew URL', () => {
    const error = new LicenseExpiredError(new Date())

    expect(error.upgradeUrl).toBe('https://skillsmith.app/renew')
  })

  it('should work without current tier', () => {
    const error = new LicenseExpiredError(new Date())

    expect(error.currentTier).toBeUndefined()
  })
})

// ============================================================================
// LicenseInvalidError Tests
// ============================================================================

describe('LicenseInvalidError', () => {
  it('should create an invalid license error', () => {
    const error = new LicenseInvalidError('Invalid JWT signature')

    expect(error).toBeInstanceOf(LicenseError)
    expect(error).toBeInstanceOf(LicenseInvalidError)
    expect(error.name).toBe('LicenseInvalidError')
    expect(error.code).toBe('E002')
    expect(error.reason).toBe('Invalid JWT signature')
    expect(error.message).toBe('Invalid license: Invalid JWT signature')
  })

  it('should include additional context', () => {
    const error = new LicenseInvalidError('Malformed token', { tokenLength: 100 })

    expect(error.context).toEqual({ reason: 'Malformed token', tokenLength: 100 })
  })

  it('should have support URL', () => {
    const error = new LicenseInvalidError('Bad format')

    expect(error.upgradeUrl).toBe('https://skillsmith.app/support')
  })
})

// ============================================================================
// LicenseNotFoundError Tests
// ============================================================================

describe('LicenseNotFoundError', () => {
  it('should create a license not found error', () => {
    const error = new LicenseNotFoundError()

    expect(error).toBeInstanceOf(LicenseError)
    expect(error).toBeInstanceOf(LicenseNotFoundError)
    expect(error.name).toBe('LicenseNotFoundError')
    expect(error.code).toBe('E003')
    expect(error.currentTier).toBe('community')
    expect(error.message).toContain('SKILLSMITH_LICENSE_KEY')
  })

  it('should have pricing URL', () => {
    const error = new LicenseNotFoundError()

    expect(error.upgradeUrl).toBe('https://skillsmith.app/pricing')
  })

  it('should include optional context', () => {
    const error = new LicenseNotFoundError({ checkedEnvVars: ['SKILLSMITH_LICENSE_KEY'] })

    expect(error.context).toEqual({ checkedEnvVars: ['SKILLSMITH_LICENSE_KEY'] })
  })
})

// ============================================================================
// FeatureNotAvailableError Tests
// ============================================================================

describe('FeatureNotAvailableError', () => {
  it('should create a feature not available error', () => {
    const error = new FeatureNotAvailableError('audit_logging', 'team', 'enterprise')

    expect(error).toBeInstanceOf(LicenseError)
    expect(error).toBeInstanceOf(FeatureNotAvailableError)
    expect(error.name).toBe('FeatureNotAvailableError')
    expect(error.code).toBe('E004')
    expect(error.feature).toBe('audit_logging')
    expect(error.currentTier).toBe('team')
    expect(error.requiredTier).toBe('enterprise')
    expect(error.message).toContain("'audit_logging'")
    expect(error.message).toContain("'enterprise'")
    expect(error.message).toContain("'team'")
  })

  it('should generate upgrade URL with parameters', () => {
    const error = new FeatureNotAvailableError('sso_saml', 'community', 'enterprise')

    expect(error.upgradeUrl).toBe(
      'https://skillsmith.app/upgrade?feature=sso_saml&from=community&to=enterprise'
    )
  })

  it('should include optional context', () => {
    const error = new FeatureNotAvailableError('rbac', 'team', 'enterprise', {
      attemptedAction: 'create_role',
    })

    expect(error.context).toEqual({ attemptedAction: 'create_role' })
  })
})

// ============================================================================
// LicenseQuotaExceededError Tests
// ============================================================================

describe('LicenseQuotaExceededError', () => {
  it('should create a quota exceeded error', () => {
    const error = new LicenseQuotaExceededError('seats', 10, 15, 'team')

    expect(error).toBeInstanceOf(LicenseError)
    expect(error).toBeInstanceOf(LicenseQuotaExceededError)
    expect(error.name).toBe('LicenseQuotaExceededError')
    expect(error.code).toBe('E005')
    expect(error.quotaType).toBe('seats')
    expect(error.maxQuota).toBe(10)
    expect(error.currentUsage).toBe(15)
    expect(error.currentTier).toBe('team')
    expect(error.message).toContain('15 of 10')
  })

  it('should generate upgrade URL with quota type', () => {
    const error = new LicenseQuotaExceededError('api_calls', 1000, 1500)

    expect(error.upgradeUrl).toBe('https://skillsmith.app/upgrade?quota=api_calls')
  })

  it('should work without current tier', () => {
    const error = new LicenseQuotaExceededError('storage', 50, 60)

    expect(error.currentTier).toBeUndefined()
  })

  it('should include optional context', () => {
    const error = new LicenseQuotaExceededError('seats', 10, 12, 'team', {
      billingCycle: 'monthly',
    })

    expect(error.context).toEqual({
      quotaType: 'seats',
      maxQuota: 10,
      currentUsage: 12,
      billingCycle: 'monthly',
    })
  })
})

// ============================================================================
// Error Code Constants Tests
// ============================================================================

describe('LICENSE_ERROR_CODES', () => {
  it('should have correct error codes', () => {
    expect(LICENSE_ERROR_CODES.LICENSE_EXPIRED).toBe('E001')
    expect(LICENSE_ERROR_CODES.LICENSE_INVALID).toBe('E002')
    expect(LICENSE_ERROR_CODES.LICENSE_NOT_FOUND).toBe('E003')
    expect(LICENSE_ERROR_CODES.FEATURE_NOT_AVAILABLE).toBe('E004')
    expect(LICENSE_ERROR_CODES.QUOTA_EXCEEDED).toBe('E005')
  })
})

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('Type Guards', () => {
  let licenseError: LicenseError
  let expiredError: LicenseExpiredError
  let invalidError: LicenseInvalidError
  let notFoundError: LicenseNotFoundError
  let featureError: FeatureNotAvailableError
  let quotaError: LicenseQuotaExceededError
  let genericError: Error

  beforeEach(() => {
    licenseError = new LicenseError('Test', { code: 'E002' })
    expiredError = new LicenseExpiredError(new Date())
    invalidError = new LicenseInvalidError('Bad token')
    notFoundError = new LicenseNotFoundError()
    featureError = new FeatureNotAvailableError('sso_saml', 'team', 'enterprise')
    quotaError = new LicenseQuotaExceededError('seats', 10, 15)
    genericError = new Error('Generic error')
  })

  describe('isLicenseError', () => {
    it('should return true for LicenseError instances', () => {
      expect(isLicenseError(licenseError)).toBe(true)
      expect(isLicenseError(expiredError)).toBe(true)
      expect(isLicenseError(invalidError)).toBe(true)
      expect(isLicenseError(notFoundError)).toBe(true)
      expect(isLicenseError(featureError)).toBe(true)
      expect(isLicenseError(quotaError)).toBe(true)
    })

    it('should return false for non-LicenseError', () => {
      expect(isLicenseError(genericError)).toBe(false)
      expect(isLicenseError(null)).toBe(false)
      expect(isLicenseError(undefined)).toBe(false)
      expect(isLicenseError('string')).toBe(false)
      expect(isLicenseError({})).toBe(false)
    })
  })

  describe('isLicenseExpiredError', () => {
    it('should return true only for LicenseExpiredError', () => {
      expect(isLicenseExpiredError(expiredError)).toBe(true)
      expect(isLicenseExpiredError(licenseError)).toBe(false)
      expect(isLicenseExpiredError(invalidError)).toBe(false)
    })
  })

  describe('isLicenseInvalidError', () => {
    it('should return true only for LicenseInvalidError', () => {
      expect(isLicenseInvalidError(invalidError)).toBe(true)
      expect(isLicenseInvalidError(licenseError)).toBe(false)
      expect(isLicenseInvalidError(expiredError)).toBe(false)
    })
  })

  describe('isLicenseNotFoundError', () => {
    it('should return true only for LicenseNotFoundError', () => {
      expect(isLicenseNotFoundError(notFoundError)).toBe(true)
      expect(isLicenseNotFoundError(licenseError)).toBe(false)
      expect(isLicenseNotFoundError(invalidError)).toBe(false)
    })
  })

  describe('isFeatureNotAvailableError', () => {
    it('should return true only for FeatureNotAvailableError', () => {
      expect(isFeatureNotAvailableError(featureError)).toBe(true)
      expect(isFeatureNotAvailableError(licenseError)).toBe(false)
      expect(isFeatureNotAvailableError(notFoundError)).toBe(false)
    })
  })

  describe('isLicenseQuotaExceededError', () => {
    it('should return true only for LicenseQuotaExceededError', () => {
      expect(isLicenseQuotaExceededError(quotaError)).toBe(true)
      expect(isLicenseQuotaExceededError(licenseError)).toBe(false)
      expect(isLicenseQuotaExceededError(featureError)).toBe(false)
    })
  })
})

// ============================================================================
// Error Factory Tests
// ============================================================================

describe('createLicenseError', () => {
  it('should create LicenseExpiredError for TOKEN_EXPIRED', () => {
    const error = createLicenseError('TOKEN_EXPIRED', {
      currentTier: 'enterprise',
      context: { expiredAt: '2024-01-15T12:00:00Z' },
    })

    expect(error).toBeInstanceOf(LicenseExpiredError)
    expect(error.code).toBe('E001')
  })

  it('should create LicenseInvalidError for INVALID_TOKEN', () => {
    const error = createLicenseError('INVALID_TOKEN', {
      context: { reason: 'Malformed JWT' },
    })

    expect(error).toBeInstanceOf(LicenseInvalidError)
    expect(error.code).toBe('E002')
  })

  it('should create LicenseInvalidError for INVALID_SIGNATURE', () => {
    const error = createLicenseError('INVALID_SIGNATURE')

    expect(error).toBeInstanceOf(LicenseInvalidError)
    expect(error.code).toBe('E002')
  })

  it('should create LicenseInvalidError for INVALID_TIER', () => {
    const error = createLicenseError('INVALID_TIER')

    expect(error).toBeInstanceOf(LicenseInvalidError)
    expect(error.code).toBe('E002')
  })

  it('should create LicenseInvalidError for INVALID_FEATURES', () => {
    const error = createLicenseError('INVALID_FEATURES')

    expect(error).toBeInstanceOf(LicenseInvalidError)
    expect(error.code).toBe('E002')
  })

  it('should create LicenseInvalidError with missing claims message', () => {
    const error = createLicenseError('MISSING_CLAIMS', {
      context: { missingClaims: ['tier', 'customerId'] },
    })

    expect(error).toBeInstanceOf(LicenseInvalidError)
    expect(error.message).toContain('tier')
    expect(error.message).toContain('customerId')
  })

  it('should create LicenseNotFoundError for MISSING_CLAIMS without specific claims', () => {
    const error = createLicenseError('MISSING_CLAIMS')

    expect(error).toBeInstanceOf(LicenseNotFoundError)
    expect(error.code).toBe('E003')
  })

  it('should create generic LicenseError for unknown codes', () => {
    const error = createLicenseError('UNKNOWN_ERROR')

    expect(error).toBeInstanceOf(LicenseError)
    expect(error.code).toBe('E002') // Falls back to INVALID
  })
})
