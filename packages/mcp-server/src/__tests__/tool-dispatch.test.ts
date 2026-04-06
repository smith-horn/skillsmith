/**
 * Tool dispatch tests
 *
 * SMI-3913: Verify that every entry in TOOL_FEATURES has either a real
 * handler case or gets the comingSoon response (not "Unknown tool" error).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dispatchToolCall } from '../tool-dispatch.js'
import { TOOL_FEATURES, FEATURE_TIERS } from '../middleware/license.js'
import type { ToolContext } from '../context.types.js'
import type { LicenseMiddleware } from '../middleware/license.js'
import type { QuotaMiddleware } from '../middleware/quota-types.js'

/**
 * Tools that have real dispatch handlers in tool-dispatch.ts.
 * If a new tool is added to the switch-case, add it here.
 */
const HANDLED_TOOLS = new Set([
  'search',
  'get_skill',
  'install_skill',
  'uninstall_skill',
  'skill_recommend',
  'skill_validate',
  'skill_compare',
  'skill_suggest',
  'index_local',
  'skill_outdated',
  'skill_publish',
  'skill_updates',
  'skill_diff',
  'skill_audit',
  'skill_pack_audit',
  'skill_rescan',
  'audit_export',
  'audit_query',
  'siem_export',
  'team_workspace',
  'share_skill',
  'publish_private',
])

function createMockLicenseMiddleware(): LicenseMiddleware {
  return {
    checkFeature: vi.fn().mockResolvedValue({ valid: true }),
    checkTool: vi.fn().mockResolvedValue({ valid: true }),
    getLicenseInfo: vi.fn().mockResolvedValue({
      valid: true,
      tier: 'enterprise' as const,
      features: [],
    }),
    invalidateCache: vi.fn(),
  }
}

function createMockQuotaMiddleware(): QuotaMiddleware {
  return {
    checkAndTrack: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 999,
      limit: 1000,
      percentUsed: 0.1,
      warningLevel: 0,
      resetAt: new Date(),
    }),
    getStatus: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 999,
      limit: 1000,
      percentUsed: 0.1,
      warningLevel: 0,
      resetAt: new Date(),
    }),
    buildMetadata: vi.fn().mockReturnValue({
      remaining: 999,
      limit: 1000,
      resetAt: new Date().toISOString(),
    }),
    buildExceededResponse: vi.fn().mockReturnValue({
      content: [{ type: 'text' as const, text: 'quota exceeded' }],
      isError: true,
    }),
  }
}

describe('dispatchToolCall', () => {
  let licenseMiddleware: LicenseMiddleware
  let quotaMiddleware: QuotaMiddleware

  beforeEach(() => {
    licenseMiddleware = createMockLicenseMiddleware()
    quotaMiddleware = createMockQuotaMiddleware()
  })

  describe('SMI-3913: comingSoon handler for unmapped tools', () => {
    // Collect all tools from TOOL_FEATURES that are not in HANDLED_TOOLS
    // and have a non-null feature (gated tools on the roadmap)
    const unmappedGatedTools = Object.entries(TOOL_FEATURES)
      .filter(([name, feature]) => !HANDLED_TOOLS.has(name) && feature !== null)
      .map(([name, feature]) => ({ name, feature: feature! }))

    it('should have at least one unmapped gated tool for this test to be meaningful', () => {
      expect(unmappedGatedTools.length).toBeGreaterThan(0)
    })

    it.each(unmappedGatedTools)(
      'should return comingSoon for unmapped gated tool "$name"',
      async ({ name, feature }) => {
        const result = await dispatchToolCall(
          name,
          {},
          {} as ToolContext,
          licenseMiddleware,
          quotaMiddleware
        )

        expect(result.content).toHaveLength(1)
        const content = JSON.parse((result.content[0] as { text: string }).text)
        expect(content.status).toBe('coming_soon')
        expect(content.feature).toBe(feature)
        expect(content.requiredTier).toBe(FEATURE_TIERS[feature])
        expect(content.message).toContain(name)
        expect(content.message).toContain('skillsmith.app/pricing#roadmap')
      }
    )

    it('should throw Unknown tool for tools not in TOOL_FEATURES', async () => {
      await expect(
        dispatchToolCall(
          'totally_unknown_tool',
          {},
          {} as ToolContext,
          licenseMiddleware,
          quotaMiddleware
        )
      ).rejects.toThrow('Unknown tool: totally_unknown_tool')
    })

    it('every TOOL_FEATURES entry has either a handler or gets comingSoon', async () => {
      for (const [name, feature] of Object.entries(TOOL_FEATURES)) {
        if (HANDLED_TOOLS.has(name)) {
          // These have real handlers — skip (they require real ToolContext)
          continue
        }

        if (feature === null) {
          // Community tool with null feature that's not handled should throw
          // (this case shouldn't exist in practice — all null-feature tools are handled)
          continue
        }

        // Gated tool without handler should get comingSoon, not throw
        const result = await dispatchToolCall(
          name,
          {},
          {} as ToolContext,
          licenseMiddleware,
          quotaMiddleware
        )

        const content = JSON.parse((result.content[0] as { text: string }).text)
        expect(content.status).toBe('coming_soon')
      }
    })
  })
})
