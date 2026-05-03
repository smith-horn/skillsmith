/**
 * @fileoverview SMI-4590 Step 0b — audit-tool-dispatch regression tests
 * @module @skillsmith/mcp-server/tests/unit/audit-tool-dispatch
 *
 * Asserts the extracted dispatcher:
 * 1. Routes `skill_audit` and `skill_pack_audit` through `withLicenseAndQuota`
 *    (delegating to the same handlers as the pre-extraction parent).
 * 2. Throws `Unknown audit tool: <name>` for unrecognized names — the parent
 *    `tool-dispatch.ts` is responsible for routing predicate; this module
 *    refuses anything outside `AUDIT_TOOL_NAMES`.
 * 3. Exposes a stable `AUDIT_TOOL_NAMES` set + `isAuditToolName()` predicate.
 *
 * No behavioral change vs pre-Step-0b dispatch — handler bodies were moved,
 * not modified. This test pins that contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock middleware/license BEFORE importing the module under test so the
// dispatcher's `withLicenseAndQuota` call hits the spy.
const mocks = vi.hoisted(() => ({
  withLicenseAndQuota: vi.fn(),
}))

vi.mock('../../src/middleware/license.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    withLicenseAndQuota: (...args: unknown[]) => mocks.withLicenseAndQuota(...args),
  }
})

import {
  dispatchAuditTool,
  isAuditToolName,
  AUDIT_TOOL_NAMES,
} from '../../src/audit-tool-dispatch.js'
import type { ToolContext } from '../../src/context.js'
import type { LicenseMiddleware } from '../../src/middleware/license.js'
import type { QuotaMiddleware } from '../../src/middleware/quota.js'

// ============================================================================
// Helpers
// ============================================================================

function fakeContext(): ToolContext {
  return {} as ToolContext
}

function fakeLicense(): LicenseMiddleware {
  return {
    checkFeature: vi.fn().mockResolvedValue({ valid: true }),
    checkTool: vi.fn().mockResolvedValue({ valid: true }),
    getLicenseInfo: vi.fn().mockResolvedValue({
      valid: true,
      tier: 'enterprise' as const,
      features: [],
    }),
    invalidateCache: vi.fn(),
  } as unknown as LicenseMiddleware
}

function fakeQuota(): QuotaMiddleware {
  return {
    checkAndTrack: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 999,
      limit: 1000,
      percentUsed: 0.1,
      warningLevel: 0,
      resetAt: new Date(),
    }),
    buildMetadata: vi.fn(),
    buildExceededResponse: vi.fn(),
  } as unknown as QuotaMiddleware
}

// ============================================================================
// Tests
// ============================================================================

describe('SMI-4590 Step 0b — audit-tool-dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.withLicenseAndQuota.mockResolvedValue({
      content: [{ type: 'text' as const, text: '{}' }],
      isError: false,
    })
  })

  describe('AUDIT_TOOL_NAMES set', () => {
    it('includes the existing pre-extraction tools', () => {
      expect(AUDIT_TOOL_NAMES.has('skill_audit')).toBe(true)
      expect(AUDIT_TOOL_NAMES.has('skill_pack_audit')).toBe(true)
    })

    it('does NOT include non-audit tools (regression guard)', () => {
      expect(AUDIT_TOOL_NAMES.has('search')).toBe(false)
      expect(AUDIT_TOOL_NAMES.has('install_skill')).toBe(false)
      expect(AUDIT_TOOL_NAMES.has('skill_diff')).toBe(false)
    })
  })

  describe('isAuditToolName predicate', () => {
    it('returns true for audit-family tools', () => {
      expect(isAuditToolName('skill_audit')).toBe(true)
      expect(isAuditToolName('skill_pack_audit')).toBe(true)
    })

    it('returns false for non-audit tools', () => {
      expect(isAuditToolName('search')).toBe(false)
      expect(isAuditToolName('totally_unknown')).toBe(false)
    })
  })

  describe('dispatchAuditTool routing', () => {
    it('routes skill_audit through withLicenseAndQuota', async () => {
      await dispatchAuditTool(
        'skill_audit',
        { skillId: 'foo/bar' },
        fakeContext(),
        fakeLicense(),
        fakeQuota()
      )
      expect(mocks.withLicenseAndQuota).toHaveBeenCalledTimes(1)
      const call = mocks.withLicenseAndQuota.mock.calls[0]
      expect(call?.[0]).toBe('skill_audit')
    })

    it('routes skill_pack_audit through withLicenseAndQuota', async () => {
      await dispatchAuditTool(
        'skill_pack_audit',
        { pack_path: '/tmp/pack' },
        fakeContext(),
        fakeLicense(),
        fakeQuota()
      )
      expect(mocks.withLicenseAndQuota).toHaveBeenCalledTimes(1)
      const call = mocks.withLicenseAndQuota.mock.calls[0]
      expect(call?.[0]).toBe('skill_pack_audit')
    })

    it('forwards args verbatim to withLicenseAndQuota', async () => {
      const args = { skillId: 'verbatim/passthrough', extra: 42 }
      await dispatchAuditTool('skill_audit', args, fakeContext(), fakeLicense(), fakeQuota())
      const call = mocks.withLicenseAndQuota.mock.calls[0]
      expect(call?.[1]).toBe(args)
    })

    it('throws "Unknown audit tool: <name>" for unrecognized tool names', async () => {
      await expect(
        dispatchAuditTool('not_an_audit_tool', {}, fakeContext(), fakeLicense(), fakeQuota())
      ).rejects.toThrow('Unknown audit tool: not_an_audit_tool')
      expect(mocks.withLicenseAndQuota).not.toHaveBeenCalled()
    })
  })

  describe('handler/schema wiring (regression vs pre-extraction)', () => {
    it('passes the skill_audit Zod schema and executor to withLicenseAndQuota', async () => {
      await dispatchAuditTool('skill_audit', {}, fakeContext(), fakeLicense(), fakeQuota())
      const [, , schema, executor] = mocks.withLicenseAndQuota.mock.calls[0] ?? []
      expect(schema).toBeDefined()
      expect(typeof executor).toBe('function')
    })

    it('passes the skill_pack_audit Zod schema and executor to withLicenseAndQuota', async () => {
      await dispatchAuditTool('skill_pack_audit', {}, fakeContext(), fakeLicense(), fakeQuota())
      const [, , schema, executor] = mocks.withLicenseAndQuota.mock.calls[0] ?? []
      expect(schema).toBeDefined()
      expect(typeof executor).toBe('function')
    })
  })
})
