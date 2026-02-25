/**
 * SMI-2755 Wave 2: Quota middleware unit tests
 *
 * CRITICAL: This file uses ONLY beforeEach/afterEach-scoped spies.
 * There are NO module-level vi.mock() calls here to avoid conflicts
 * with the existing quota-wiring.test.ts file that lives in the same
 * directory and uses the same modules.
 *
 * @see packages/mcp-server/src/__tests__/middleware/quota-wiring.test.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  createQuotaMiddleware,
  withQuotaEnforcement,
  isUnlimitedTier,
  getQuotaLimit,
  formatQuotaRemaining,
} from '../../middleware/quota.js'
import { createLicenseMiddleware } from '../../middleware/license.js'
import type { LicenseInfo } from '../../middleware/license.js'
import type { QuotaStorage } from '../../middleware/quota.js'

// ============================================================================
// Shared test helpers
// ============================================================================

function makeStorage(used: number): QuotaStorage {
  return {
    getUsage: vi.fn().mockResolvedValue({
      used,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }),
    incrementUsage: vi.fn().mockResolvedValue(undefined),
    initializePeriod: vi.fn().mockResolvedValue(undefined),
  }
}

function makeLicenseInfo(tier: LicenseInfo['tier']): LicenseInfo {
  return {
    valid: true,
    tier,
    features: [],
  }
}

// ============================================================================
// getStatus()
// ============================================================================

describe('createQuotaMiddleware - getStatus()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns unlimited result for enterprise tier', async () => {
    const quota = createQuotaMiddleware()
    const licenseInfo = makeLicenseInfo('enterprise')

    const status = await quota.getStatus(licenseInfo)

    expect(status.allowed).toBe(true)
    expect(status.remaining).toBe(-1)
    expect(status.limit).toBe(-1)
    expect(status.percentUsed).toBe(0)
    expect(status.warningLevel).toBe(0)
  })

  it('returns 0% usage for community tier at zero calls', async () => {
    const storage = makeStorage(0)
    const quota = createQuotaMiddleware({ storage })
    const licenseInfo = makeLicenseInfo('community')

    const status = await quota.getStatus(licenseInfo)

    expect(status.allowed).toBe(true)
    expect(status.limit).toBe(1_000)
    expect(status.remaining).toBe(1_000)
    expect(status.percentUsed).toBe(0)
    expect(status.warningLevel).toBe(0)
    expect(status.message).toBeUndefined()
  })

  it('returns 80% warning for community tier at 800/1000 calls', async () => {
    const storage = makeStorage(800)
    const quota = createQuotaMiddleware({ storage })
    const licenseInfo = makeLicenseInfo('community')

    const status = await quota.getStatus(licenseInfo)

    expect(status.allowed).toBe(true)
    expect(status.percentUsed).toBe(80)
    expect(status.warningLevel).toBe(80)
    expect(status.message).toContain('80%')
  })

  it('returns 90% warning for community tier at 900/1000 calls', async () => {
    const storage = makeStorage(900)
    const quota = createQuotaMiddleware({ storage })
    const licenseInfo = makeLicenseInfo('community')

    const status = await quota.getStatus(licenseInfo)

    expect(status.allowed).toBe(true)
    expect(status.percentUsed).toBe(90)
    expect(status.warningLevel).toBe(90)
    expect(status.message).toContain('90%')
    expect(status.upgradeUrl).toBeDefined()
  })

  it('returns not-allowed for community tier at 1000/1000 calls (quota exhausted)', async () => {
    const storage = makeStorage(1000)
    const quota = createQuotaMiddleware({ storage })
    const licenseInfo = makeLicenseInfo('community')

    const status = await quota.getStatus(licenseInfo)

    expect(status.allowed).toBe(false)
    expect(status.remaining).toBe(0)
    expect(status.percentUsed).toBe(100)
  })

  it('works with null licenseInfo (defaults to community tier)', async () => {
    const storage = makeStorage(0)
    const quota = createQuotaMiddleware({ storage })

    const status = await quota.getStatus(null)

    expect(status.limit).toBe(1_000)
    expect(status.allowed).toBe(true)
  })
})

// ============================================================================
// withQuotaEnforcement()
// ============================================================================

describe('withQuotaEnforcement()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delegates to inner handler when quota allows', async () => {
    const storage = makeStorage(0)
    const quota = createQuotaMiddleware({ storage })
    const license = createLicenseMiddleware()

    const innerHandler = vi.fn().mockResolvedValue({ result: 'success' })
    const wrapped = withQuotaEnforcement(innerHandler, license, quota)

    const result = await wrapped('skill_search', { query: 'commit' })

    expect(innerHandler).toHaveBeenCalledTimes(1)
    expect(innerHandler).toHaveBeenCalledWith({ query: 'commit' })
    expect(result).toEqual({ result: 'success' })
  })

  it('returns quota-exceeded error response when quota is exceeded', async () => {
    const exhaustedStorage = makeStorage(1000) // community limit = 1000
    const quota = createQuotaMiddleware({ storage: exhaustedStorage })
    const license = createLicenseMiddleware()

    const innerHandler = vi.fn().mockResolvedValue({ result: 'should not reach here' })
    const wrapped = withQuotaEnforcement(innerHandler, license, quota)

    const result = await wrapped('skill_search', { query: 'commit' })

    // Inner handler should NOT have been called
    expect(innerHandler).not.toHaveBeenCalled()

    // Result must be MCP error response shape
    const errorResult = result as { isError: boolean; content: Array<{ type: string }> }
    expect(errorResult.isError).toBe(true)
    expect(Array.isArray(errorResult.content)).toBe(true)
    expect(errorResult.content[0].type).toBe('text')
  })
})

// ============================================================================
// isUnlimitedTier()
// ============================================================================

describe('isUnlimitedTier()', () => {
  it('returns true for enterprise tier', () => {
    expect(isUnlimitedTier('enterprise')).toBe(true)
  })

  it('returns false for community tier', () => {
    expect(isUnlimitedTier('community')).toBe(false)
  })

  it('returns false for individual tier', () => {
    expect(isUnlimitedTier('individual')).toBe(false)
  })

  it('returns false for team tier', () => {
    expect(isUnlimitedTier('team')).toBe(false)
  })
})

// ============================================================================
// getQuotaLimit()
// ============================================================================

describe('getQuotaLimit()', () => {
  it('returns 1000 for community tier', () => {
    expect(getQuotaLimit('community')).toBe(1_000)
  })

  it('returns 10000 for individual tier', () => {
    expect(getQuotaLimit('individual')).toBe(10_000)
  })

  it('returns 100000 for team tier', () => {
    expect(getQuotaLimit('team')).toBe(100_000)
  })

  it('returns -1 for enterprise tier (unlimited)', () => {
    expect(getQuotaLimit('enterprise')).toBe(-1)
  })
})

// ============================================================================
// formatQuotaRemaining()
// ============================================================================

describe('formatQuotaRemaining()', () => {
  it('returns "Unlimited" when limit is -1', () => {
    expect(formatQuotaRemaining(-1, -1)).toBe('Unlimited')
  })

  it('formats remaining / limit for finite limits', () => {
    const result = formatQuotaRemaining(750, 1000)
    expect(result).toContain('750')
    expect(result).toContain('1,000')
  })

  it('formats zero remaining correctly', () => {
    const result = formatQuotaRemaining(0, 1000)
    expect(result).toContain('0')
    expect(result).toContain('1,000')
  })
})
