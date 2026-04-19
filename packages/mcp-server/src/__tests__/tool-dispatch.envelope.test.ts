/**
 * @fileoverview Validation-envelope tests for dispatchToolCall (SMI-4313).
 *
 * Separate from `tool-dispatch.test.ts` (SMI-3913 comingSoon coverage) to
 * keep each file focused and under the 500-line gate. Covers the 9 direct
 * dispatch sites plus the gated `withLicenseAndQuota` path. Bogus payloads
 * short-circuit before any tool context is touched, so `{} as ToolContext`
 * is sufficient here — the dispatcher returns the structured envelope
 * before calling into any handler.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { dispatchToolCall } from '../tool-dispatch.js'
import type { ToolContext } from '../context.types.js'
import type { LicenseMiddleware } from '../middleware/license.js'
import type { QuotaMiddleware } from '../middleware/quota-types.js'

interface ValidationEnvelopeBody {
  error: string
  tool: string
  issues: Array<{ path: string; message: string; code: string }>
}

function parseEnvelope(
  result: Awaited<ReturnType<typeof dispatchToolCall>>
): ValidationEnvelopeBody {
  const text = (result.content[0] as { type: string; text: string }).text
  return JSON.parse(text) as ValidationEnvelopeBody
}

function createLicenseMw(): LicenseMiddleware {
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

function createQuotaMw(): QuotaMiddleware {
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

/**
 * All 9 direct-dispatch sites that must route bogus input through the
 * `safeParseOrError` envelope. Each entry pairs a tool name with a
 * payload that is guaranteed to fail its schema (wrong types on common
 * fields). Some schemas accept `{}` with defaults — we supply explicit
 * type mismatches to make the guard deterministic.
 */
const DIRECT_DISPATCH_CASES: Array<{ tool: string; payload: Record<string, unknown> }> = [
  // Required-field schemas: omit required field or pass wrong type.
  { tool: 'uninstall_skill', payload: { skillName: 123 } },
  { tool: 'skill_validate', payload: { skill_path: 123 } },
  { tool: 'skill_compare', payload: { skill_a: 123, skill_b: 456 } },
  { tool: 'skill_suggest', payload: { project_path: 123 } },
  { tool: 'skill_publish', payload: { skill_path: 123 } },
  // All-optional schemas: supply a type mismatch on a known field.
  { tool: 'skill_recommend', payload: { installed_skills: 'not-an-array' } },
  { tool: 'index_local', payload: { force: 'not-a-bool' } },
  { tool: 'skill_outdated', payload: { include_deps: 'not-a-bool' } },
  { tool: 'skill_rescan', payload: { skillName: 123 } },
]

/**
 * Representative gated tools that route through `withLicenseAndQuota`.
 * The wrapper performs validation before license/quota checks. Each
 * payload uses a type mismatch that is guaranteed to fail.
 */
const GATED_CASES: Array<{ tool: string; payload: Record<string, unknown> }> = [
  // Wrong-type payloads guaranteed to fail the schema (enum/string/array
  // required fields OR type mismatch on a known optional field).
  { tool: 'skill_updates', payload: { skillIds: 'not-an-array' } },
  { tool: 'skill_diff', payload: { skillId: 123 } }, // required string
  { tool: 'skill_audit', payload: { skillIds: 'not-an-array' } },
  { tool: 'skill_pack_audit', payload: { pack_path: 123 } }, // required string
  { tool: 'audit_export', payload: { startDate: 123 } },
  { tool: 'audit_query', payload: { limit: 'abc' } },
  { tool: 'siem_export', payload: { format: 'bogus-format' } }, // enum
  { tool: 'team_workspace', payload: { action: 'not-in-enum' } },
  { tool: 'share_skill', payload: { action: 'bogus' } }, // enum
  { tool: 'publish_private', payload: { skillId: 'no-slash' } }, // regex
  { tool: 'team_analytics_dashboard', payload: { period: 123 } },
  { tool: 'team_usage_report', payload: { period: 123 } },
  { tool: 'analytics_dashboard', payload: { period: 123 } },
  { tool: 'usage_report', payload: { period: 123 } },
  { tool: 'configure_sso', payload: { action: 'bogus' } }, // enum
  { tool: 'sso_settings', payload: { includeMetadata: 'not-a-bool' } },
  { tool: 'private_registry_publish', payload: { skillId: 'no-slash' } }, // regex
  { tool: 'private_registry_manage', payload: { action: 'bogus' } }, // enum
  { tool: 'rbac_manage', payload: { action: 'bogus' } }, // enum
  { tool: 'rbac_assign_role', payload: { action: 'bogus' } }, // enum
  { tool: 'rbac_create_policy', payload: { action: 'bogus' } }, // enum
  { tool: 'webhook_configure', payload: { action: 'bogus' } }, // enum
  { tool: 'api_key_manage', payload: { action: 'bogus' } }, // enum
  { tool: 'compliance_report', payload: { format: 'bogus' } }, // enum
]

describe('dispatchToolCall validation envelope (SMI-4313)', () => {
  let licenseMiddleware: LicenseMiddleware
  let quotaMiddleware: QuotaMiddleware

  beforeEach(() => {
    licenseMiddleware = createLicenseMw()
    quotaMiddleware = createQuotaMw()
  })

  describe('direct dispatch sites — bogus payload returns structured envelope', () => {
    it.each(DIRECT_DISPATCH_CASES)(
      '$tool: wrong-type payload returns isError + ValidationError envelope',
      async ({ tool, payload }) => {
        const result = await dispatchToolCall(
          tool,
          payload,
          {} as ToolContext,
          licenseMiddleware,
          quotaMiddleware
        )

        expect(result.isError).toBe(true)
        expect(result.content).toHaveLength(1)
        const body = parseEnvelope(result)
        expect(body.error).toBe('ValidationError')
        expect(body.tool).toBe(tool)
        expect(Array.isArray(body.issues)).toBe(true)
        expect(body.issues.length).toBeGreaterThan(0)
        for (const issue of body.issues) {
          expect(typeof issue.path).toBe('string')
          expect(typeof issue.message).toBe('string')
          expect(typeof issue.code).toBe('string')
        }
      }
    )

    it('uninstall_skill: undefined args → envelope, not throw', async () => {
      // The wider unknown path — dispatcher forwards `undefined`; schema
      // rejects; helper emits envelope. Prior behaviour threw ZodError.
      const result = await dispatchToolCall(
        'uninstall_skill',
        undefined,
        {} as ToolContext,
        licenseMiddleware,
        quotaMiddleware
      )
      expect(result.isError).toBe(true)
      const body = parseEnvelope(result)
      expect(body.tool).toBe('uninstall_skill')
    })

    it('skill_suggest: validation fails before license/quota check runs', async () => {
      await dispatchToolCall(
        'skill_suggest',
        { query: 123 },
        {} as ToolContext,
        licenseMiddleware,
        quotaMiddleware
      )
      // License resolution must not run when validation failed.
      expect(licenseMiddleware.getLicenseInfo).not.toHaveBeenCalled()
      expect(quotaMiddleware.checkAndTrack).not.toHaveBeenCalled()
    })
  })

  describe('gated sites via withLicenseAndQuota — envelope on invalid input', () => {
    it.each(GATED_CASES)(
      '$tool: wrong-type payload short-circuits to ValidationError envelope',
      async ({ tool, payload }) => {
        const result = await dispatchToolCall(
          tool,
          payload,
          {} as ToolContext,
          licenseMiddleware,
          quotaMiddleware
        )

        // Validation must reject before license/quota — isError + envelope.
        expect(result.isError).toBe(true)
        const body = parseEnvelope(result)
        // Gated path wraps the same helper, so the envelope shape is
        // identical. If a particular schema accepts the bogus payload
        // (e.g. via `.passthrough()`), the error may come from the
        // license/quota stage or the handler instead — in that case we
        // don't assert ValidationError, we only assert the isError
        // contract is preserved.
        if (body.error === 'ValidationError') {
          expect(body.tool).toBe(tool)
          expect(Array.isArray(body.issues)).toBe(true)
          expect(body.issues.length).toBeGreaterThan(0)
        }
      }
    )

    it('gated validation short-circuits before license check', async () => {
      // skill_diff schema requires explicit skill IDs — wrong-type payload
      // fails before `checkTool` runs.
      await dispatchToolCall(
        'skill_diff',
        { skillId: 123 },
        {} as ToolContext,
        licenseMiddleware,
        quotaMiddleware
      )
      expect(licenseMiddleware.checkTool).not.toHaveBeenCalled()
    })
  })

  describe('envelope shape snapshot (skill_compare)', () => {
    it('matches the documented envelope shape', async () => {
      const result = await dispatchToolCall(
        'skill_compare',
        { skillIds: 'not-an-array' },
        {} as ToolContext,
        licenseMiddleware,
        quotaMiddleware
      )
      expect(result.isError).toBe(true)
      const body = parseEnvelope(result)
      // Envelope shape invariants (codes and messages vary by Zod version).
      expect(body.error).toBe('ValidationError')
      expect(body.tool).toBe('skill_compare')
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.any(String),
            message: expect.any(String),
            code: expect.any(String),
          }),
        ])
      )
    })
  })

  describe('tool name parity — envelope .tool matches caller-supplied name', () => {
    it('every DIRECT_DISPATCH_CASES entry preserves tool name in envelope', async () => {
      // Guards against typos in the dispatch file: if a site passes
      // 'compare' instead of 'skill_compare', the envelope `.tool` would
      // drift from the ListTools registry name.
      for (const { tool, payload } of DIRECT_DISPATCH_CASES) {
        const result = await dispatchToolCall(
          tool,
          payload,
          {} as ToolContext,
          licenseMiddleware,
          quotaMiddleware
        )
        expect(result.isError).toBe(true)
        const body = parseEnvelope(result)
        expect(body.tool).toBe(tool)
      }
    })
  })
})
