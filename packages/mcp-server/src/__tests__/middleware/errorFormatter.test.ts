/**
 * SMI-1061: MCP Error Formatter Test Suite
 *
 * Tests for MCP-formatted license error responses.
 */

import { describe, it, expect } from 'vitest'

import {
  formatLicenseError,
  formatGenericError,
  getUserFriendlyMessage,
  generateUpgradeUrl,
  buildUpgradeRequiredResponse,
  buildLicenseExpiredResponse,
  buildQuotaExceededResponse,
  isLicenseErrorLike,
  safeFormatError,
  type LicenseErrorLike,
} from '../../middleware/errorFormatter.js'

// ============================================================================
// formatLicenseError Tests
// ============================================================================

describe('formatLicenseError', () => {
  it('should format a basic license error', () => {
    const error: LicenseErrorLike = {
      code: 'E004',
      message: 'Feature not available',
      feature: 'audit_logging',
      currentTier: 'team',
      requiredTier: 'enterprise',
    }

    const response = formatLicenseError(error)

    expect(response.isError).toBe(true)
    expect(response.content).toHaveLength(1)
    expect(response.content[0].type).toBe('text')

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.code).toBe('E004')
    expect(parsed.error.message).toBe('Feature not available')
    expect(parsed.error.details.feature).toBe('audit_logging')
    expect(parsed.error.details.currentTier).toBe('team')
    expect(parsed.error.details.requiredTier).toBe('enterprise')
  })

  it('should include upgrade URL in metadata', () => {
    const error: LicenseErrorLike = {
      code: 'E004',
      message: 'Upgrade required',
      upgradeUrl: 'https://skillsmith.app/upgrade?feature=sso',
    }

    const response = formatLicenseError(error)

    expect(response._meta?.upgradeUrl).toBe('https://skillsmith.app/upgrade?feature=sso')
    expect(response._meta?.errorCode).toBe('E004')
  })

  it('should use default upgrade URL when not provided', () => {
    const error: LicenseErrorLike = {
      message: 'License error',
    }

    const response = formatLicenseError(error)
    const parsed = JSON.parse(response.content[0].text)

    expect(parsed.error.details.upgradeUrl).toBe('https://skillsmith.app/upgrade')
  })

  it('should handle errors with timestamp', () => {
    const timestamp = new Date('2024-01-15T12:00:00Z')
    const error: LicenseErrorLike = {
      code: 'E001',
      message: 'License expired',
      timestamp,
    }

    const response = formatLicenseError(error)

    expect(response._meta?.errorCode).toBe('E001')
  })

  it('should mark recoverable errors correctly', () => {
    const recoverableError: LicenseErrorLike = {
      code: 'E003',
      message: 'License not found',
    }

    const nonRecoverableError: LicenseErrorLike = {
      code: 'E001',
      message: 'License expired',
    }

    expect(formatLicenseError(recoverableError)._meta?.recoverable).toBe(true)
    expect(formatLicenseError(nonRecoverableError)._meta?.recoverable).toBe(false)
  })

  it('should not include empty details object', () => {
    const error: LicenseErrorLike = {
      code: 'E002',
      message: 'Invalid license',
    }

    const response = formatLicenseError(error)
    const parsed = JSON.parse(response.content[0].text)

    // Details should still be present if upgradeUrl is added by default
    expect(parsed.error.details.upgradeUrl).toBe('https://skillsmith.app/upgrade')
  })
})

// ============================================================================
// formatGenericError Tests
// ============================================================================

describe('formatGenericError', () => {
  it('should format a generic error', () => {
    const error = new Error('Something went wrong')
    const response = formatGenericError(error)

    expect(response.isError).toBe(true)

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.code).toBe('INTERNAL_ERROR')
    expect(parsed.error.message).toBe('Something went wrong')
  })

  it('should use custom error code', () => {
    const error = new Error('Network failure')
    const response = formatGenericError(error, 'NETWORK_ERROR')

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.code).toBe('NETWORK_ERROR')
  })

  it('should not include metadata', () => {
    const error = new Error('Test')
    const response = formatGenericError(error)

    expect(response._meta).toBeUndefined()
  })
})

// ============================================================================
// getUserFriendlyMessage Tests
// ============================================================================

describe('getUserFriendlyMessage', () => {
  it('should return correct message for E001', () => {
    expect(getUserFriendlyMessage('E001')).toContain('expired')
  })

  it('should return correct message for E002', () => {
    expect(getUserFriendlyMessage('E002')).toContain('invalid')
  })

  it('should return correct message for E003', () => {
    expect(getUserFriendlyMessage('E003')).toContain('No license key found')
  })

  it('should return correct message for E004', () => {
    expect(getUserFriendlyMessage('E004')).toContain('not available')
  })

  it('should return correct message for E005', () => {
    expect(getUserFriendlyMessage('E005')).toContain('quota')
  })

  it('should return correct message for LICENSE_EXPIRED', () => {
    expect(getUserFriendlyMessage('LICENSE_EXPIRED')).toContain('expired')
  })

  it('should return default message for unknown codes', () => {
    expect(getUserFriendlyMessage('UNKNOWN')).toContain('contact support')
  })
})

// ============================================================================
// generateUpgradeUrl Tests
// ============================================================================

describe('generateUpgradeUrl', () => {
  it('should generate URL with feature parameter', () => {
    const error: LicenseErrorLike = {
      message: 'Feature required',
      feature: 'sso_saml',
    }

    const url = generateUpgradeUrl(error)

    expect(url).toContain('feature=sso_saml')
  })

  it('should include tier information', () => {
    const error: LicenseErrorLike = {
      message: 'Upgrade needed',
      currentTier: 'team',
      requiredTier: 'enterprise',
    }

    const url = generateUpgradeUrl(error)

    expect(url).toContain('from=team')
    expect(url).toContain('to=enterprise')
  })

  it('should include source tracking', () => {
    const error: LicenseErrorLike = {
      message: 'Error',
      code: 'E004',
    }

    const url = generateUpgradeUrl(error)

    expect(url).toContain('source=mcp-error')
    expect(url).toContain('error_code=E004')
  })

  it('should respect custom base URL', () => {
    const error: LicenseErrorLike = { message: 'Error' }
    const url = generateUpgradeUrl(error, { baseUrl: 'https://custom.com/buy' })

    expect(url).toContain('https://custom.com/buy')
  })

  it('should allow disabling parameters', () => {
    const error: LicenseErrorLike = {
      message: 'Error',
      feature: 'test',
      currentTier: 'team',
    }

    const url = generateUpgradeUrl(error, {
      includeFeature: false,
      includeTiers: false,
      includeSource: false,
    })

    expect(url).not.toContain('feature=')
    expect(url).not.toContain('from=')
    expect(url).not.toContain('source=')
  })
})

// ============================================================================
// Response Builder Tests
// ============================================================================

describe('buildUpgradeRequiredResponse', () => {
  it('should build upgrade required response', () => {
    const response = buildUpgradeRequiredResponse('audit_logging', 'team', 'enterprise')

    expect(response.isError).toBe(true)
    expect(response._meta?.errorCode).toBe('E004')

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.code).toBe('E004')
    expect(parsed.error.details.feature).toBe('audit_logging')
    expect(parsed.error.details.currentTier).toBe('team')
    expect(parsed.error.details.requiredTier).toBe('enterprise')
  })

  it('should include proper upgrade URL', () => {
    const response = buildUpgradeRequiredResponse('sso_saml', 'community', 'enterprise')

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.details.upgradeUrl).toContain('feature=sso_saml')
    expect(parsed.error.details.upgradeUrl).toContain('from=community')
    expect(parsed.error.details.upgradeUrl).toContain('to=enterprise')
  })
})

describe('buildLicenseExpiredResponse', () => {
  it('should build license expired response', () => {
    const expiredAt = new Date('2024-01-15T12:00:00Z')
    const response = buildLicenseExpiredResponse(expiredAt)

    expect(response.isError).toBe(true)
    expect(response._meta?.errorCode).toBe('E001')

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.code).toBe('E001')
    expect(parsed.error.details.expiredAt).toBe('2024-01-15T12:00:00.000Z')
    expect(parsed.error.details.renewUrl).toBe('https://skillsmith.app/renew')
  })

  it('should work without expiredAt date', () => {
    const response = buildLicenseExpiredResponse()

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.code).toBe('E001')
    expect(parsed.error.details.expiredAt).toBeUndefined()
  })
})

describe('buildQuotaExceededResponse', () => {
  it('should build quota exceeded response', () => {
    const response = buildQuotaExceededResponse('seats', 15, 10)

    expect(response.isError).toBe(true)
    expect(response._meta?.errorCode).toBe('E005')

    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.code).toBe('E005')
    expect(parsed.error.details.quotaType).toBe('seats')
    expect(parsed.error.details.current).toBe(15)
    expect(parsed.error.details.max).toBe(10)
  })
})

// ============================================================================
// isLicenseErrorLike Tests
// ============================================================================

describe('isLicenseErrorLike', () => {
  it('should return true for license-like errors', () => {
    expect(
      isLicenseErrorLike({
        message: 'License error',
        code: 'E001',
      })
    ).toBe(true)

    expect(
      isLicenseErrorLike({
        message: 'Feature required',
        feature: 'sso_saml',
      })
    ).toBe(true)

    expect(
      isLicenseErrorLike({
        message: 'Upgrade needed',
        currentTier: 'team',
        requiredTier: 'enterprise',
      })
    ).toBe(true)
  })

  it('should return false for non-license errors', () => {
    expect(isLicenseErrorLike(null)).toBe(false)
    expect(isLicenseErrorLike(undefined)).toBe(false)
    expect(isLicenseErrorLike('string')).toBe(false)
    expect(isLicenseErrorLike(123)).toBe(false)
    expect(isLicenseErrorLike({ notAnError: true })).toBe(false)
    expect(isLicenseErrorLike(new Error('Regular error'))).toBe(false)
  })

  it('should require message property', () => {
    expect(
      isLicenseErrorLike({
        code: 'E001',
        feature: 'test',
      })
    ).toBe(false)
  })
})

// ============================================================================
// safeFormatError Tests
// ============================================================================

describe('safeFormatError', () => {
  it('should format license-like errors', () => {
    const error = {
      message: 'Feature required',
      code: 'E004',
      feature: 'sso_saml',
    }

    const response = safeFormatError(error)

    expect(response.isError).toBe(true)
    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.code).toBe('E004')
  })

  it('should format Error instances', () => {
    const error = new Error('Something failed')
    const response = safeFormatError(error)

    expect(response.isError).toBe(true)
    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.message).toBe('Something failed')
  })

  it('should handle string errors', () => {
    const response = safeFormatError('Error string')

    expect(response.isError).toBe(true)
    const parsed = JSON.parse(response.content[0].text)
    expect(parsed.error.message).toBe('Error string')
  })

  it('should handle unknown error types', () => {
    const response = safeFormatError({ weird: 'object' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('error')
  })
})
