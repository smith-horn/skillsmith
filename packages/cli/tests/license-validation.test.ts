/**
 * Unit tests for license-validation.ts pure logic functions
 *
 * Tests decodeLicenseKey, isExpired, getLicenseStatusLegacy.
 * No mocking of enterprise package — tests only the pure/legacy paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  decodeLicenseKey,
  isExpired,
  getLicenseStatusLegacy,
  _resetEnterpriseValidatorCache,
} from '../src/utils/license-validation.js'
import { TIER_FEATURES } from '../src/utils/license-types.js'

// ============================================================================
// Helpers
// ============================================================================

function encodeLicense(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

// ============================================================================
// decodeLicenseKey
// ============================================================================

describe('decodeLicenseKey', () => {
  it('decodes a valid individual license', () => {
    const key = encodeLicense({
      tier: 'individual',
      expiresAt: '2030-12-31T00:00:00Z',
      features: ['basic_analytics'],
    })
    const result = decodeLicenseKey(key)
    expect(result).not.toBeNull()
    expect(result!.tier).toBe('individual')
    expect(result!.expiresAt).toBe('2030-12-31T00:00:00Z')
  })

  it('decodes a valid team license', () => {
    const key = encodeLicense({
      tier: 'team',
      expiresAt: '2030-06-15T00:00:00Z',
      features: [],
    })
    const result = decodeLicenseKey(key)
    expect(result).not.toBeNull()
    expect(result!.tier).toBe('team')
  })

  it('decodes a valid enterprise license', () => {
    const key = encodeLicense({
      tier: 'enterprise',
      expiresAt: '2030-01-01T00:00:00Z',
      features: ['sso_saml'],
    })
    const result = decodeLicenseKey(key)
    expect(result).not.toBeNull()
    expect(result!.tier).toBe('enterprise')
  })

  it('rejects community tier (not a paid tier)', () => {
    const key = encodeLicense({
      tier: 'community',
      expiresAt: '2030-12-31T00:00:00Z',
      features: [],
    })
    expect(decodeLicenseKey(key)).toBeNull()
  })

  it('rejects unknown tier', () => {
    const key = encodeLicense({
      tier: 'platinum',
      expiresAt: '2030-12-31T00:00:00Z',
      features: [],
    })
    expect(decodeLicenseKey(key)).toBeNull()
  })

  it('rejects missing tier', () => {
    const key = encodeLicense({
      expiresAt: '2030-12-31T00:00:00Z',
      features: [],
    })
    expect(decodeLicenseKey(key)).toBeNull()
  })

  it('rejects missing expiresAt', () => {
    const key = encodeLicense({
      tier: 'individual',
      features: [],
    })
    expect(decodeLicenseKey(key)).toBeNull()
  })

  it('rejects invalid date in expiresAt', () => {
    const key = encodeLicense({
      tier: 'individual',
      expiresAt: 'not-a-date',
      features: [],
    })
    expect(decodeLicenseKey(key)).toBeNull()
  })

  it('rejects non-base64 input', () => {
    expect(decodeLicenseKey('!!not-base64!!')).toBeNull()
  })

  it('rejects non-JSON base64', () => {
    const key = Buffer.from('not json').toString('base64')
    expect(decodeLicenseKey(key)).toBeNull()
  })
})

// ============================================================================
// isExpired
// ============================================================================

describe('isExpired', () => {
  it('returns true for past date', () => {
    expect(isExpired(new Date('2020-01-01'))).toBe(true)
  })

  it('returns false for future date', () => {
    expect(isExpired(new Date('2099-12-31'))).toBe(false)
  })
})

// ============================================================================
// getLicenseStatusLegacy
// ============================================================================

describe('getLicenseStatusLegacy', () => {
  const originalEnv = process.env['SKILLSMITH_LICENSE_KEY']

  beforeEach(() => {
    delete process.env['SKILLSMITH_LICENSE_KEY']
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['SKILLSMITH_LICENSE_KEY'] = originalEnv
    } else {
      delete process.env['SKILLSMITH_LICENSE_KEY']
    }
    _resetEnterpriseValidatorCache()
  })

  it('returns community tier when no license key is set', async () => {
    const status = await getLicenseStatusLegacy()
    expect(status.valid).toBe(true)
    expect(status.tier).toBe('community')
    expect(status.features).toEqual(TIER_FEATURES.community)
  })

  it('returns valid status for valid license key', async () => {
    const key = encodeLicense({
      tier: 'individual',
      expiresAt: '2099-12-31T00:00:00Z',
      features: ['basic_analytics'],
    })
    process.env['SKILLSMITH_LICENSE_KEY'] = key
    const status = await getLicenseStatusLegacy()
    expect(status.valid).toBe(true)
    expect(status.tier).toBe('individual')
    expect(status.features).toEqual(['basic_analytics'])
  })

  it('uses TIER_FEATURES when payload has no features', async () => {
    const key = encodeLicense({
      tier: 'team',
      expiresAt: '2099-12-31T00:00:00Z',
    })
    process.env['SKILLSMITH_LICENSE_KEY'] = key
    const status = await getLicenseStatusLegacy()
    expect(status.valid).toBe(true)
    expect(status.tier).toBe('team')
    expect(status.features).toEqual(TIER_FEATURES.team)
  })

  it('returns error for invalid license key format', async () => {
    process.env['SKILLSMITH_LICENSE_KEY'] = 'garbage'
    const status = await getLicenseStatusLegacy()
    expect(status.valid).toBe(false)
    expect(status.tier).toBe('community')
    expect(status.error).toContain('Invalid license key format')
  })

  it('returns error for expired license', async () => {
    const key = encodeLicense({
      tier: 'individual',
      expiresAt: '2020-01-01T00:00:00Z',
      features: ['basic_analytics'],
    })
    process.env['SKILLSMITH_LICENSE_KEY'] = key
    const status = await getLicenseStatusLegacy()
    expect(status.valid).toBe(false)
    expect(status.tier).toBe('community')
    expect(status.error).toContain('expired')
    expect(status.features).toEqual(TIER_FEATURES.community)
  })

  it('includes expiresAt in expired status', async () => {
    const key = encodeLicense({
      tier: 'individual',
      expiresAt: '2020-06-15T00:00:00Z',
      features: [],
    })
    process.env['SKILLSMITH_LICENSE_KEY'] = key
    const status = await getLicenseStatusLegacy()
    expect(status.expiresAt).toBeInstanceOf(Date)
    expect(status.error).toContain('2020-06-15')
  })
})
