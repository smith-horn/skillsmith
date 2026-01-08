/**
 * SMI-1061: Error Recovery Test Suite
 *
 * Tests for license error recovery strategies and utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  LicenseExpiredError,
  LicenseInvalidError,
  LicenseNotFoundError,
  FeatureNotAvailableError,
  LicenseQuotaExceededError,
} from '../../../src/license/errors/index.js'

import {
  suggestRecovery,
  canAutoRecover,
  attemptRecovery,
  getErrorLogLevel,
  formatErrorForLogging,
  sanitizeErrorForLogging,
} from '../../../src/license/errors/ErrorRecovery.js'

// ============================================================================
// suggestRecovery Tests
// ============================================================================

describe('suggestRecovery', () => {
  describe('LicenseExpiredError', () => {
    it('should suggest renewing the license', () => {
      const error = new LicenseExpiredError(new Date('2024-01-15'))
      const suggestions = suggestRecovery(error)

      expect(suggestions.length).toBeGreaterThan(0)
      const firstSuggestion = suggestions[0]
      expect(firstSuggestion).toBeDefined()
      expect(firstSuggestion!.action).toBe('renew_license')
      expect(firstSuggestion!.priority).toBe('immediate')
      expect(firstSuggestion!.autoRecoverable).toBe(false)
    })

    it('should include contact support as optional', () => {
      const error = new LicenseExpiredError(new Date())
      const suggestions = suggestRecovery(error)

      const supportSuggestion = suggestions.find((s) => s.action === 'contact_support')
      expect(supportSuggestion).toBeDefined()
      expect(supportSuggestion?.priority).toBe('optional')
    })
  })

  describe('LicenseInvalidError', () => {
    it('should suggest verifying key format first', () => {
      const error = new LicenseInvalidError('Malformed token')
      const suggestions = suggestRecovery(error)
      const firstSuggestion = suggestions[0]

      expect(firstSuggestion).toBeDefined()
      expect(firstSuggestion!.action).toBe('verify_key_format')
      expect(firstSuggestion!.priority).toBe('immediate')
    })

    it('should suggest refresh as auto-recoverable', () => {
      const error = new LicenseInvalidError('Bad signature')
      const suggestions = suggestRecovery(error)

      const refreshSuggestion = suggestions.find((s) => s.action === 'refresh_license')
      expect(refreshSuggestion).toBeDefined()
      expect(refreshSuggestion?.autoRecoverable).toBe(true)
    })
  })

  describe('LicenseNotFoundError', () => {
    it('should suggest setting license key', () => {
      const error = new LicenseNotFoundError()
      const suggestions = suggestRecovery(error)
      const firstSuggestion = suggestions[0]

      expect(firstSuggestion).toBeDefined()
      expect(firstSuggestion!.action).toBe('set_license_key')
      expect(firstSuggestion!.priority).toBe('immediate')
    })

    it('should suggest upgrading tier', () => {
      const error = new LicenseNotFoundError()
      const suggestions = suggestRecovery(error)

      const upgradeSuggestion = suggestions.find((s) => s.action === 'upgrade_tier')
      expect(upgradeSuggestion).toBeDefined()
      expect(upgradeSuggestion?.actionUrl).toContain('pricing')
    })
  })

  describe('FeatureNotAvailableError', () => {
    it('should customize upgrade suggestion with feature details', () => {
      const error = new FeatureNotAvailableError('audit_logging', 'team', 'enterprise')
      const suggestions = suggestRecovery(error)

      const upgradeSuggestion = suggestions.find((s) => s.action === 'upgrade_tier')
      expect(upgradeSuggestion).toBeDefined()
      expect(upgradeSuggestion?.description).toContain('enterprise')
      expect(upgradeSuggestion?.description).toContain('audit_logging')
    })

    it('should sort suggestions by priority', () => {
      const error = new FeatureNotAvailableError('sso_saml', 'community', 'enterprise')
      const suggestions = suggestRecovery(error)

      // Immediate should come before optional
      const immediateIdx = suggestions.findIndex((s) => s.priority === 'immediate')
      const optionalIdx = suggestions.findIndex((s) => s.priority === 'optional')

      if (immediateIdx !== -1 && optionalIdx !== -1) {
        expect(immediateIdx).toBeLessThan(optionalIdx)
      }
    })
  })

  describe('LicenseQuotaExceededError', () => {
    it('should customize reduce usage suggestion', () => {
      const error = new LicenseQuotaExceededError('seats', 10, 15, 'team')
      const suggestions = suggestRecovery(error)

      const reduceSuggestion = suggestions.find((s) => s.action === 'reduce_usage')
      expect(reduceSuggestion).toBeDefined()
      expect(reduceSuggestion?.description).toContain('15')
      expect(reduceSuggestion?.description).toContain('10')
    })
  })
})

// ============================================================================
// canAutoRecover Tests
// ============================================================================

describe('canAutoRecover', () => {
  it('should return true for LicenseInvalidError', () => {
    const error = new LicenseInvalidError('Bad token')
    expect(canAutoRecover(error)).toBe(true)
  })

  it('should return false for LicenseExpiredError', () => {
    const error = new LicenseExpiredError(new Date())
    expect(canAutoRecover(error)).toBe(false)
  })

  it('should return false for LicenseNotFoundError', () => {
    const error = new LicenseNotFoundError()
    expect(canAutoRecover(error)).toBe(false)
  })

  it('should return false for FeatureNotAvailableError', () => {
    const error = new FeatureNotAvailableError('sso_saml', 'team', 'enterprise')
    expect(canAutoRecover(error)).toBe(false)
  })

  it('should return false for LicenseQuotaExceededError', () => {
    const error = new LicenseQuotaExceededError('seats', 10, 15)
    expect(canAutoRecover(error)).toBe(false)
  })
})

// ============================================================================
// attemptRecovery Tests
// ============================================================================

describe('attemptRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return failure when auto recovery is disabled', async () => {
    const error = new LicenseInvalidError('Bad token')
    const result = await attemptRecovery(error, { enableAutoRecovery: false })

    expect(result.success).toBe(false)
    expect(result.message).toContain('disabled')
  })

  it('should return failure when error cannot be auto-recovered', async () => {
    const error = new LicenseExpiredError(new Date())
    const result = await attemptRecovery(error)

    expect(result.success).toBe(false)
    expect(result.message).toContain('cannot be automatically recovered')
  })

  it('should attempt license refresh for invalid license', async () => {
    const error = new LicenseInvalidError('Bad token')
    const onLicenseRefresh = vi.fn().mockResolvedValue(true)

    const resultPromise = attemptRecovery(error, { onLicenseRefresh })
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(onLicenseRefresh).toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.action).toBe('refresh_license')
  })

  it('should retry on refresh failure', async () => {
    const error = new LicenseInvalidError('Bad token')
    const onLicenseRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue(true)

    const resultPromise = attemptRecovery(error, {
      onLicenseRefresh,
      maxRetries: 3,
      retryDelayMs: 100,
    })

    // Advance through all retries and delays
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(onLicenseRefresh).toHaveBeenCalledTimes(3)
    expect(result.success).toBe(true)
  })

  it('should fail after max retries', async () => {
    const error = new LicenseInvalidError('Bad token')
    const onLicenseRefresh = vi.fn().mockRejectedValue(new Error('Persistent error'))

    const resultPromise = attemptRecovery(error, {
      onLicenseRefresh,
      maxRetries: 2,
      retryDelayMs: 100,
    })

    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(onLicenseRefresh).toHaveBeenCalledTimes(2)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error?.message).toBe('Persistent error')
  })

  it('should try cache clearing if provided', async () => {
    const error = new LicenseInvalidError('Bad token')
    const onClearCache = vi.fn().mockResolvedValue(true)

    // No refresh callback, just cache clearing
    const resultPromise = attemptRecovery(error, { onClearCache })
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(onClearCache).toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.action).toBe('clear_cache')
  })

  it('should handle cache clearing failure', async () => {
    const error = new LicenseInvalidError('Bad token')
    const onClearCache = vi.fn().mockRejectedValue(new Error('Cache error'))

    const resultPromise = attemptRecovery(error, { onClearCache })
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.success).toBe(false)
    expect(result.action).toBe('clear_cache')
    expect(result.error?.message).toBe('Cache error')
  })
})

// ============================================================================
// getErrorLogLevel Tests
// ============================================================================

describe('getErrorLogLevel', () => {
  it('should return warn for expired license', () => {
    const error = new LicenseExpiredError(new Date())
    expect(getErrorLogLevel(error)).toBe('warn')
  })

  it('should return error for invalid license', () => {
    const error = new LicenseInvalidError('Bad token')
    expect(getErrorLogLevel(error)).toBe('error')
  })

  it('should return info for license not found', () => {
    const error = new LicenseNotFoundError()
    expect(getErrorLogLevel(error)).toBe('info')
  })

  it('should return info for feature not available', () => {
    const error = new FeatureNotAvailableError('sso_saml', 'team', 'enterprise')
    expect(getErrorLogLevel(error)).toBe('info')
  })

  it('should return warn for quota exceeded', () => {
    const error = new LicenseQuotaExceededError('seats', 10, 15)
    expect(getErrorLogLevel(error)).toBe('warn')
  })
})

// ============================================================================
// formatErrorForLogging Tests
// ============================================================================

describe('formatErrorForLogging', () => {
  it('should format error with all details', () => {
    const error = new FeatureNotAvailableError('audit_logging', 'team', 'enterprise')
    const formatted = formatErrorForLogging(error)

    expect(formatted).toContain('[E004]')
    expect(formatted).toContain('FeatureNotAvailableError')
    expect(formatted).toContain('team')
    expect(formatted).toContain('enterprise')
    expect(formatted).toContain('audit_logging')
    expect(formatted).toContain('https://skillsmith.app')
  })

  it('should include stack trace when requested', () => {
    const error = new LicenseInvalidError('Bad token')
    const formatted = formatErrorForLogging(error, true)

    expect(formatted).toContain('Stack:')
  })

  it('should not include stack trace by default', () => {
    const error = new LicenseInvalidError('Bad token')
    const formatted = formatErrorForLogging(error)

    expect(formatted).not.toContain('Stack:')
  })

  it('should handle errors without feature', () => {
    const error = new LicenseNotFoundError()
    const formatted = formatErrorForLogging(error)

    expect(formatted).toContain('[E003]')
    expect(formatted).not.toContain('Feature: undefined')
  })
})

// ============================================================================
// sanitizeErrorForLogging Tests
// ============================================================================

describe('sanitizeErrorForLogging', () => {
  it('should remove context from error', () => {
    const error = new LicenseInvalidError('Bad token', { sensitiveData: 'secret' })
    const sanitized = sanitizeErrorForLogging(error)

    expect(sanitized['code']).toBe('E002')
    expect(sanitized['message']).toBeDefined()
    expect(sanitized).not.toHaveProperty('context')
    expect(sanitized).not.toHaveProperty('upgradeUrl')
  })

  it('should include basic error properties', () => {
    const error = new FeatureNotAvailableError('sso_saml', 'team', 'enterprise')
    const sanitized = sanitizeErrorForLogging(error)

    expect(sanitized['code']).toBe('E004')
    expect(sanitized['name']).toBe('FeatureNotAvailableError')
    expect(sanitized['currentTier']).toBe('team')
    expect(sanitized['requiredTier']).toBe('enterprise')
    expect(sanitized['feature']).toBe('sso_saml')
    expect(typeof sanitized['timestamp']).toBe('string')
  })

  it('should handle errors with optional fields', () => {
    const error = new LicenseNotFoundError()
    const sanitized = sanitizeErrorForLogging(error)

    expect(sanitized['code']).toBe('E003')
    expect(sanitized['currentTier']).toBe('community')
    expect(sanitized['requiredTier']).toBeUndefined()
  })
})
