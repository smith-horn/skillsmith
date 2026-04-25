// SMI-4402: license.gate.ts tests
// LG-1: createProfileIncompleteResponse returns code -32001 + profile_incomplete data
// LG-2: withLicenseAndQuota intercepts profile_incomplete ApiClientError → profile response
// LG-3: withLicenseAndQuota rethrows non-profile_incomplete errors
// LG-4: withLicenseAndQuota passes through on success
// LG-5: checkAndTrack IS called before the handler (quota decremented for profile_incomplete)
// LG-6 (SMI-4463): NETWORK_QUOTA_EXCEEDED → JSON-RPC -32050 + structured quotaInfo

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApiClientError, SkillsmithError, ErrorCodes } from '@skillsmith/core'
import {
  createProfileIncompleteResponse,
  withLicenseAndQuota,
  MCP_MONTHLY_QUOTA_EXCEEDED_CODE,
} from '../license.gate.js'
import type { LicenseMiddleware } from '../license.js'
import type { QuotaMiddleware } from '../quota-types.js'
import type { ToolContext } from '../../context.types.js'
import { z } from 'zod'

const mockLicense: LicenseMiddleware = {
  checkFeature: vi.fn().mockResolvedValue({ valid: true }),
  checkTool: vi.fn().mockResolvedValue({ valid: true }),
  getLicenseInfo: vi.fn().mockResolvedValue({ valid: true, tier: 'community', features: [] }),
  invalidateCache: vi.fn(),
}

const mockQuota: QuotaMiddleware = {
  checkAndTrack: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 999,
    limit: 1000,
    percentUsed: 0.1,
    warningLevel: 0,
    resetAt: new Date(),
  }),
  getStatus: vi.fn(),
  buildMetadata: vi.fn(),
  buildExceededResponse: vi.fn(),
}

const mockCtx = {} as ToolContext

const inputSchema = z.object({ query: z.string() })

describe('license.gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('LG-1: createProfileIncompleteResponse has code -32001 and profile_incomplete=true', () => {
    const resp = createProfileIncompleteResponse()
    expect(resp.isError).toBe(true)
    const body = JSON.parse(resp.content[0].text) as Record<string, unknown>
    expect(body.code).toBe(-32001)
    expect(body.error).toBe('profile_incomplete')
    expect((body.data as Record<string, unknown>).profile_incomplete).toBe(true)
    expect(typeof body.complete_url).toBe('string')
  })

  it('LG-2: withLicenseAndQuota catches profile_incomplete ApiClientError', async () => {
    const handler = vi.fn().mockRejectedValue(new ApiClientError('profile_incomplete', false, 403))

    const result = await withLicenseAndQuota(
      'search',
      { query: 'test' },
      inputSchema,
      handler,
      mockCtx,
      mockLicense,
      mockQuota
    )

    expect(result.isError).toBe(true)
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<
      string,
      unknown
    >
    expect(body.code).toBe(-32001)
    expect(body.error).toBe('profile_incomplete')
  })

  it('LG-3: withLicenseAndQuota rethrows non-profile-incomplete errors', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('network timeout'))

    await expect(
      withLicenseAndQuota(
        'search',
        { query: 'test' },
        inputSchema,
        handler,
        mockCtx,
        mockLicense,
        mockQuota
      )
    ).rejects.toThrow('network timeout')
  })

  it('LG-4: withLicenseAndQuota returns ok on success', async () => {
    const handler = vi.fn().mockResolvedValue({ data: [{ id: 'skill/foo' }] })

    const result = await withLicenseAndQuota(
      'search',
      { query: 'test' },
      inputSchema,
      handler,
      mockCtx,
      mockLicense,
      mockQuota
    )

    expect(result.isError).toBeUndefined()
    expect(result.content).toBeDefined()
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<
      string,
      unknown
    >
    expect(body).toHaveProperty('data')
  })

  it('LG-5: checkAndTrack is called before handler (quota consumed even for profile_incomplete)', async () => {
    // H9 design note: QuotaMiddleware.checkAndTrack atomically checks + increments.
    // There is no split check/track API, so quota IS consumed before profile_incomplete
    // is detected. This test documents actual behavior to prevent misreading the comment.
    const handler = vi.fn().mockRejectedValue(new ApiClientError('profile_incomplete', false, 403))

    await withLicenseAndQuota(
      'search',
      { query: 'test' },
      inputSchema,
      handler,
      mockCtx,
      mockLicense,
      mockQuota
    )

    expect(mockQuota.checkAndTrack).toHaveBeenCalledOnce()
  })

  it('LG-6 (SMI-4463): NETWORK_QUOTA_EXCEEDED → JSON-RPC -32050 with quotaInfo', async () => {
    const resetsAt = new Date(Date.now() + 5 * 86400000).toISOString()
    const handler = vi
      .fn()
      .mockRejectedValue(
        new SkillsmithError(
          ErrorCodes.NETWORK_QUOTA_EXCEEDED,
          'Monthly quota reached (1000/1000 community tier).\nUpgrade: https://skillsmith.app/pricing',
          { details: { used: 1000, limit: 1000, tier: 'community', resetsAt } }
        )
      )

    const result = await withLicenseAndQuota(
      'search',
      { query: 'test' },
      inputSchema,
      handler,
      mockCtx,
      mockLicense,
      mockQuota
    )

    expect(result.isError).toBe(true)
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<
      string,
      unknown
    >
    expect(body.code).toBe(MCP_MONTHLY_QUOTA_EXCEEDED_CODE)
    expect(body.code).toBe(-32050)
    expect(body.error).toBe('monthly_quota_exceeded')
    expect(body.message).toContain('Monthly quota reached')
    const quotaInfo = (body.data as Record<string, unknown>).quotaInfo as Record<string, unknown>
    expect(quotaInfo.used).toBe(1000)
    expect(quotaInfo.limit).toBe(1000)
    expect(quotaInfo.tier).toBe('community')
    expect(quotaInfo.resetsAt).toBe(resetsAt)
  })
})
