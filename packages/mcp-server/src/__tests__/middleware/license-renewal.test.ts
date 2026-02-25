/**
 * SMI-2756: Wave 3 — License middleware supplemental tests
 *
 * Companion file to license.test.ts (which exceeds the 500-line limit).
 * Covers: expiration warning thresholds, getExpirationWarning boundary cases,
 * invalidateCache forces re-validation, checkTool for community tools,
 * createLicenseErrorResponse shape, and requireFeature HOF.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createLicenseMiddleware,
  getExpirationWarning,
  requireFeature,
  createLicenseErrorResponse,
  isEnterpriseFeature,
  requiresLicense,
} from '../../middleware/license.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

describe('License middleware — supplemental (SMI-2756)', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.SKILLSMITH_LICENSE_KEY
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.SKILLSMITH_LICENSE_KEY
  })

  // -------------------------------------------------------------------------
  // getExpirationWarning boundary cases
  // -------------------------------------------------------------------------

  describe('getExpirationWarning', () => {
    it('returns undefined when expiresAt is undefined', () => {
      expect(getExpirationWarning(undefined)).toBeUndefined()
    })

    it('returns undefined when license expires in more than 30 days', () => {
      const future = new Date(Date.now() + 60 * MS_PER_DAY)
      expect(getExpirationWarning(future)).toBeUndefined()
    })

    it('returns a warning string when license expires in <= 30 days', () => {
      const soon = new Date(Date.now() + 15 * MS_PER_DAY)
      const warning = getExpirationWarning(soon)
      expect(typeof warning).toBe('string')
      expect(warning).toContain('day')
    })

    it('returns singular "day" when exactly 1 day remains', () => {
      const tomorrow = new Date(Date.now() + 1 * MS_PER_DAY + 60_000) // +1 min buffer
      const warning = getExpirationWarning(tomorrow)
      expect(warning).toContain('1 day')
      // Should not say "1 days"
      expect(warning).not.toContain('1 days')
    })

    it('returns undefined when license is already expired', () => {
      const expired = new Date(Date.now() - MS_PER_DAY)
      // daysUntilExpiry <= 0 — condition requires > 0
      expect(getExpirationWarning(expired)).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // checkTool — community tool (no license required)
  // -------------------------------------------------------------------------

  describe('checkTool — community tools', () => {
    it('returns valid:true for a community tool even without license key', async () => {
      const middleware = createLicenseMiddleware()
      const result = await middleware.checkTool('search')
      expect(result.valid).toBe(true)
    })

    it('returns valid:true for get_skill (community)', async () => {
      const middleware = createLicenseMiddleware()
      const result = await middleware.checkTool('get_skill')
      expect(result.valid).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // invalidateCache forces community re-evaluation
  // -------------------------------------------------------------------------

  describe('invalidateCache', () => {
    it('does not throw when called before any cache is populated', () => {
      const middleware = createLicenseMiddleware()
      expect(() => middleware.invalidateCache()).not.toThrow()
    })

    it('returns updated info after invalidation', async () => {
      const middleware = createLicenseMiddleware()

      // Populate cache
      const first = await middleware.getLicenseInfo()
      expect(first?.tier).toBe('community')

      middleware.invalidateCache()

      // Re-evaluate — should still succeed without error
      const second = await middleware.getLicenseInfo()
      expect(second?.tier).toBe('community')
    })
  })

  // -------------------------------------------------------------------------
  // createLicenseErrorResponse
  // -------------------------------------------------------------------------

  describe('createLicenseErrorResponse', () => {
    it('returns isError:true', () => {
      const response = createLicenseErrorResponse({
        valid: false,
        message: 'Upgrade required',
        feature: 'audit_logging',
        upgradeUrl: 'https://skillsmith.app/pricing',
      })
      expect(response.isError).toBe(true)
    })

    it('includes the message in content text', () => {
      const response = createLicenseErrorResponse({
        valid: false,
        message: 'You need a team license',
        feature: 'audit_logging',
        upgradeUrl: 'https://skillsmith.app/pricing?feature=audit_logging',
      })
      const text = response.content[0].text
      const parsed = JSON.parse(text) as { message?: string }
      expect(parsed.message).toBe('You need a team license')
    })

    it('includes _meta.upgradeUrl when upgradeUrl is set', () => {
      const response = createLicenseErrorResponse({
        valid: false,
        message: 'Upgrade',
        upgradeUrl: 'https://skillsmith.app/pricing',
      })
      expect(response._meta?.upgradeUrl).toBe('https://skillsmith.app/pricing')
    })
  })

  // -------------------------------------------------------------------------
  // requireFeature HOF
  // -------------------------------------------------------------------------

  describe('requireFeature', () => {
    it('returns a function that delegates to middleware.checkFeature', async () => {
      const checkFeatureMock = vi.fn().mockResolvedValue({ valid: true })
      const mockMiddleware = {
        checkFeature: checkFeatureMock,
        checkTool: vi.fn(),
        getLicenseInfo: vi.fn(),
        invalidateCache: vi.fn(),
      }

      const requireAuditLogging = requireFeature('audit_logging')
      const result = await requireAuditLogging(mockMiddleware)

      expect(checkFeatureMock).toHaveBeenCalledWith('audit_logging')
      expect(result.valid).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // isEnterpriseFeature / requiresLicense helpers
  // -------------------------------------------------------------------------

  describe('helper functions', () => {
    it('isEnterpriseFeature returns false for unknown tool name', () => {
      expect(isEnterpriseFeature('nonexistent_tool')).toBe(false)
    })

    it('requiresLicense returns false for community tools', () => {
      expect(requiresLicense('search')).toBe(false)
      expect(requiresLicense('get_skill')).toBe(false)
    })

    it('requiresLicense returns false for unknown tools', () => {
      expect(requiresLicense('completely_made_up_tool')).toBe(false)
    })
  })
})
