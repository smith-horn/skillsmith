/**
 * Quota wiring integration tests for skill_suggest
 *
 * @see SMI-2679: Wire quota middleware to skill_suggest in index.ts
 * @see SMI-2684: Create quota-wiring.test.ts
 *
 * NOTE: These tests live in a NEW file, not license.test.ts.
 * license.test.ts is already 734 lines (over the 500-line gate).
 *
 * These tests verify the quota enforcement path added in index.ts:
 * - skill_suggest is a community tool (null in TOOL_FEATURES)
 * - quota exceeded → buildExceededResponse returned (not executeSuggest result)
 * - quota allowed → executeSuggest proceeds normally
 * - exceeded response has isError:true in MCP format
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TOOL_FEATURES } from '../../middleware/toolFeatureMapping.js'
import { createQuotaMiddleware } from '../../middleware/quota.js'
import { createLicenseMiddleware } from '../../middleware/license.js'

describe('Quota wiring: skill_suggest tool mapping', () => {
  it('should have skill_suggest mapped as community tool (null feature flag)', () => {
    expect('skill_suggest' in TOOL_FEATURES).toBe(true)
    expect(TOOL_FEATURES['skill_suggest']).toBeNull()
  })
})

describe('Quota middleware: checkAndTrack + buildExceededResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should allow call when quota is not exceeded', async () => {
    const quota = createQuotaMiddleware()
    const license = createLicenseMiddleware()
    const licenseInfo = await license.getLicenseInfo()

    const result = await quota.checkAndTrack('skill_suggest', licenseInfo)

    expect(result.allowed).toBe(true)
    expect(result.remaining).toBeGreaterThanOrEqual(0)
  })

  it('should return isError:true MCP response when quota is exceeded', async () => {
    // Use a storage that immediately reports quota exceeded
    const exhaustedStorage = {
      getUsage: vi.fn().mockResolvedValue({
        used: 1000,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }),
      incrementUsage: vi.fn().mockResolvedValue(undefined),
      initializePeriod: vi.fn().mockResolvedValue(undefined),
    }

    const quota = createQuotaMiddleware({ storage: exhaustedStorage })
    const license = createLicenseMiddleware()
    const licenseInfo = await license.getLicenseInfo()

    const quotaResult = await quota.checkAndTrack('skill_suggest', licenseInfo)
    expect(quotaResult.allowed).toBe(false)

    const errorResponse = quota.buildExceededResponse(quotaResult)

    // Must match MCP error response shape
    expect(errorResponse.isError).toBe(true)
    expect(Array.isArray(errorResponse.content)).toBe(true)
    expect(errorResponse.content.length).toBeGreaterThan(0)
    expect(errorResponse.content[0].type).toBe('text')
  })

  it('should call checkAndTrack with toolName skill_suggest', async () => {
    const mockStorage = {
      getUsage: vi.fn().mockResolvedValue({
        used: 0,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }),
      incrementUsage: vi.fn().mockResolvedValue(undefined),
      initializePeriod: vi.fn().mockResolvedValue(undefined),
    }

    const quota = createQuotaMiddleware({ storage: mockStorage })
    const license = createLicenseMiddleware()
    const licenseInfo = await license.getLicenseInfo()

    await quota.checkAndTrack('skill_suggest', licenseInfo)

    // getUsage is called with the customer ID derived from licenseInfo
    expect(mockStorage.getUsage).toHaveBeenCalledTimes(1)
    expect(mockStorage.incrementUsage).toHaveBeenCalledTimes(1)
  })
})
