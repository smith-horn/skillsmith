/**
 * @fileoverview Tests for the curated agent tool profile — SMI-5456 Wave 1 Step 2
 *
 * `index.ts` cannot be imported directly in tests (it invokes `main()` at
 * module scope, which starts the real stdio server), so these tests exercise
 * `filterToolsForAgentProfile` / `isAgentToolProfileActive` against a fixture
 * that mirrors today's real `toolDefinitions` registrations in `index.ts`.
 *
 * Names below were verified against actual `tools/*.ts` registrations on
 * 2026-07-01 via:
 *   grep -rhoE "name: '[a-z_]+'" packages/mcp-server/src/tools/ \
 *     --include='*.ts' | grep -v test | sort -u
 */

import { describe, it, expect } from 'vitest'
import {
  AGENT_TOOL_PROFILE_ENV_VAR,
  AGENT_TOOL_PROFILE_NAMES,
  isAgentToolProfileActive,
  filterToolsForAgentProfile,
} from './toolProfile.js'
import { withLicenseAndQuota } from './license.gate.js'
import type { LicenseMiddleware } from './license.js'
import type { QuotaMiddleware } from './quota-types.js'
import type { ToolContext } from '../context.types.js'
import { z } from 'zod'

interface FixtureTool {
  name: string
}

function tool(name: string): FixtureTool {
  return { name }
}

/**
 * A representative slice of `index.ts`'s real `toolDefinitions` array:
 * every one of today's 15 pre-SMI-5470 agent-profile members, plus a
 * sample of non-member tools (Team/Enterprise-only surfaces) to prove
 * exclusion. Deliberately excludes `undo_apply`: as of SMI-5470 it IS a
 * real, registered tool (`audit-tool-dispatch.ts`), but this file tests
 * `filterToolsForAgentProfile` as a pure listing-filter mechanism against
 * a hand-maintained fixture, independent of any one tool's registration
 * state — omitting it here exercises the "profile name with no matching
 * registration is silently inert" contract, which stays true regardless
 * of whether that's a hypothetical or (now) a stale example.
 */
const TODAY_REGISTERED_TOOLS: readonly FixtureTool[] = [
  tool('search'),
  tool('get_skill'),
  tool('install_skill'),
  tool('uninstall_skill'),
  tool('skill_recommend'),
  tool('skill_validate'),
  tool('skill_compare'),
  tool('skill_suggest'),
  tool('index_local'),
  tool('skill_publish'),
  tool('skill_updates'),
  tool('skill_diff'),
  tool('skill_audit'),
  tool('skill_pack_audit'),
  tool('skill_outdated'),
  tool('skill_rescan'),
  tool('audit_export'),
  tool('audit_query'),
  tool('siem_export'),
  tool('team_workspace'),
  tool('share_skill'),
  tool('publish_private'),
  tool('rbac_manage'),
  tool('webhook_configure'),
  tool('compliance_report'),
  tool('inventory_push'),
  tool('skill_inventory_audit'),
  tool('apply_namespace_rename'),
  tool('apply_recommended_edit'),
  tool('skill_recover_source'),
]

const EXPECTED_PROFILE_MEMBER_NAMES = [
  'search',
  'get_skill',
  'install_skill',
  'uninstall_skill',
  'skill_recommend',
  'skill_validate',
  'skill_compare',
  'skill_outdated',
  'skill_updates',
  'skill_diff',
  'skill_pack_audit',
  'skill_inventory_audit',
  'apply_namespace_rename',
  'apply_recommended_edit',
  'skill_audit',
]

describe('AGENT_TOOL_PROFILE_NAMES', () => {
  it('has exactly 16 entries (15 pre-SMI-5470 + undo_apply)', () => {
    expect(AGENT_TOOL_PROFILE_NAMES).toHaveLength(16)
  })

  it('includes undo_apply (registered as of SMI-5470; kept out of this fixture on purpose, see TODAY_REGISTERED_TOOLS)', () => {
    expect(AGENT_TOOL_PROFILE_NAMES).toContain('undo_apply')
  })

  it('every non-undo_apply name matches a real tools/*.ts registration', () => {
    const registeredNames = new Set(TODAY_REGISTERED_TOOLS.map((t) => t.name))
    for (const name of AGENT_TOOL_PROFILE_NAMES) {
      if (name === 'undo_apply') continue
      expect(registeredNames.has(name)).toBe(true)
    }
  })
})

describe('isAgentToolProfileActive', () => {
  it('is false when the env var is unset', () => {
    expect(isAgentToolProfileActive({})).toBe(false)
  })

  it('is true when set to exactly "agent"', () => {
    expect(isAgentToolProfileActive({ [AGENT_TOOL_PROFILE_ENV_VAR]: 'agent' })).toBe(true)
  })

  it('is false for any other value (case-sensitive, no fuzzy match)', () => {
    expect(isAgentToolProfileActive({ [AGENT_TOOL_PROFILE_ENV_VAR]: 'Agent' })).toBe(false)
    expect(isAgentToolProfileActive({ [AGENT_TOOL_PROFILE_ENV_VAR]: 'true' })).toBe(false)
    expect(isAgentToolProfileActive({ [AGENT_TOOL_PROFILE_ENV_VAR]: '' })).toBe(false)
  })

  // Every other case in this file passes `env` explicitly. The real call
  // site in `index.ts` (`filterToolsForAgentProfile(toolDefinitions)`) never
  // passes a second argument, relying entirely on the `= process.env`
  // default. Without this test that exact production call shape — the one
  // "zero behavior change for existing installs" is actually staked on — is
  // never exercised.
  it('defaults to process.env when no env argument is passed', () => {
    const savedEnv = process.env[AGENT_TOOL_PROFILE_ENV_VAR]
    try {
      delete process.env[AGENT_TOOL_PROFILE_ENV_VAR]
      expect(isAgentToolProfileActive()).toBe(false)

      process.env[AGENT_TOOL_PROFILE_ENV_VAR] = 'agent'
      expect(isAgentToolProfileActive()).toBe(true)
    } finally {
      if (savedEnv === undefined) delete process.env[AGENT_TOOL_PROFILE_ENV_VAR]
      else process.env[AGENT_TOOL_PROFILE_ENV_VAR] = savedEnv
    }
  })
})

describe('filterToolsForAgentProfile — profile unset (zero behavior change)', () => {
  it('returns the exact today-registered name set, unchanged and in order', () => {
    const result = filterToolsForAgentProfile(TODAY_REGISTERED_TOOLS, {})

    expect(result.map((t) => t.name)).toEqual(TODAY_REGISTERED_TOOLS.map((t) => t.name))
  })

  it('is a content-identity no-op for an arbitrary tool list (generic zero-drift guarantee)', () => {
    // Independent of what tools exist today or are added in the future:
    // an unset/absent profile env var must never remove a tool from the
    // listing. This is the actual "zero behavior change" contract —
    // the fixture-pinned test above additionally documents today's set.
    const arbitrary = [tool('foo'), tool('bar'), tool('undo_apply')]

    expect(filterToolsForAgentProfile(arbitrary, {})).toEqual(arbitrary)
  })

  // The real call site in `index.ts` is `filterToolsForAgentProfile(toolDefinitions)`
  // — no second argument. Every other test in this file passes `env` explicitly,
  // so without this one the production default-parameter path (`= process.env`)
  // is never proven to preserve the full surface.
  it('defaults to process.env and is still a no-op when no env argument is passed', () => {
    const savedEnv = process.env[AGENT_TOOL_PROFILE_ENV_VAR]
    try {
      delete process.env[AGENT_TOOL_PROFILE_ENV_VAR]
      const result = filterToolsForAgentProfile(TODAY_REGISTERED_TOOLS)
      expect(result.map((t) => t.name)).toEqual(TODAY_REGISTERED_TOOLS.map((t) => t.name))
    } finally {
      if (savedEnv === undefined) delete process.env[AGENT_TOOL_PROFILE_ENV_VAR]
      else process.env[AGENT_TOOL_PROFILE_ENV_VAR] = savedEnv
    }
  })
})

describe('filterToolsForAgentProfile — SKILLSMITH_TOOL_PROFILE=agent', () => {
  it('returns exactly the profile ∩ fixture set (undo_apply inert against this fixture — see TODAY_REGISTERED_TOOLS)', () => {
    const env = { [AGENT_TOOL_PROFILE_ENV_VAR]: 'agent' }
    const result = filterToolsForAgentProfile(TODAY_REGISTERED_TOOLS, env)

    expect(result.map((t) => t.name).sort()).toEqual([...EXPECTED_PROFILE_MEMBER_NAMES].sort())
    expect(result.map((t) => t.name)).not.toContain('undo_apply')
  })

  it('excludes non-profile tools (Team/Enterprise-only surfaces)', () => {
    const env = { [AGENT_TOOL_PROFILE_ENV_VAR]: 'agent' }
    const result = filterToolsForAgentProfile(TODAY_REGISTERED_TOOLS, env)
    const names = result.map((t) => t.name)

    expect(names).not.toContain('team_workspace')
    expect(names).not.toContain('rbac_manage')
    expect(names).not.toContain('webhook_configure')
    expect(names).not.toContain('compliance_report')
    expect(names).not.toContain('audit_export')
  })

  it('is silently inert for a profile name with no matching registration', () => {
    // undo_apply is in AGENT_TOOL_PROFILE_NAMES but (deliberately, see the
    // fixture comment above) not in TODAY_REGISTERED_TOOLS — must not
    // throw, and must not appear in the result.
    expect(() =>
      filterToolsForAgentProfile(TODAY_REGISTERED_TOOLS, { [AGENT_TOOL_PROFILE_ENV_VAR]: 'agent' })
    ).not.toThrow()
  })

  // Real `process.env`, no second argument — the exact call shape used at
  // the `index.ts` ListTools call site — actually narrows the surface.
  it('narrows the surface via process.env when no env argument is passed', () => {
    const savedEnv = process.env[AGENT_TOOL_PROFILE_ENV_VAR]
    try {
      process.env[AGENT_TOOL_PROFILE_ENV_VAR] = 'agent'
      const result = filterToolsForAgentProfile(TODAY_REGISTERED_TOOLS)

      expect(result.map((t) => t.name).sort()).toEqual([...EXPECTED_PROFILE_MEMBER_NAMES].sort())
    } finally {
      if (savedEnv === undefined) delete process.env[AGENT_TOOL_PROFILE_ENV_VAR]
      else process.env[AGENT_TOOL_PROFILE_ENV_VAR] = savedEnv
    }
  })
})

describe('filterToolsForAgentProfile — junk profile value', () => {
  it('falls back to the full surface for an unrecognized value', () => {
    const env = { [AGENT_TOOL_PROFILE_ENV_VAR]: 'not-a-real-profile' }
    const result = filterToolsForAgentProfile(TODAY_REGISTERED_TOOLS, env)

    expect(result.map((t) => t.name)).toEqual(TODAY_REGISTERED_TOOLS.map((t) => t.name))
  })
})

// ============================================================================
// Tier-gating middleware behavior unchanged under the profile
// ============================================================================

const mockCtx = {} as ToolContext

const mockQuota: QuotaMiddleware = {
  checkAndTrack: async () => ({
    allowed: true,
    remaining: 999,
    limit: 1000,
    percentUsed: 0.1,
    warningLevel: 0,
    resetAt: new Date(),
  }),
  getStatus: (() => undefined) as unknown as QuotaMiddleware['getStatus'],
  buildMetadata: (() => undefined) as unknown as QuotaMiddleware['buildMetadata'],
  buildExceededResponse: (() => undefined) as unknown as QuotaMiddleware['buildExceededResponse'],
}

/** A license middleware that denies `skill_audit` — mirrors a Community-tier user. */
function denyingLicense(): LicenseMiddleware {
  return {
    checkFeature: async () => ({ valid: true }),
    checkTool: async () => ({
      valid: false,
      feature: 'skill_security_audit',
      message: 'skill_audit requires the Team tier or above.',
      upgradeUrl: 'https://skillsmith.app/pricing',
    }),
    getLicenseInfo: async () => ({ valid: true, tier: 'community', features: [] }),
    invalidateCache: () => undefined,
  }
}

describe('tier-gating is unaffected by SKILLSMITH_TOOL_PROFILE (listing-only filter)', () => {
  const inputSchema = z.object({ skillId: z.string() })

  it('gate still fires for a gated tool with the profile active', async () => {
    const savedEnv = process.env[AGENT_TOOL_PROFILE_ENV_VAR]
    process.env[AGENT_TOOL_PROFILE_ENV_VAR] = 'agent'
    try {
      let handlerCalled = false
      const handler = async () => {
        handlerCalled = true
        return { ok: true }
      }

      const result = await withLicenseAndQuota(
        'skill_audit',
        { skillId: 'foo/bar' },
        inputSchema,
        handler,
        mockCtx,
        denyingLicense(),
        mockQuota
      )

      expect(result.isError).toBe(true)
      expect(handlerCalled).toBe(false)
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<
        string,
        unknown
      >
      expect(body.error).toBe('license_required')
    } finally {
      if (savedEnv === undefined) delete process.env[AGENT_TOOL_PROFILE_ENV_VAR]
      else process.env[AGENT_TOOL_PROFILE_ENV_VAR] = savedEnv
    }
  })

  it('gate fires identically with the profile unset (same outcome, profile is listing-only)', async () => {
    const savedEnv = process.env[AGENT_TOOL_PROFILE_ENV_VAR]
    delete process.env[AGENT_TOOL_PROFILE_ENV_VAR]
    try {
      let handlerCalled = false
      const handler = async () => {
        handlerCalled = true
        return { ok: true }
      }

      const result = await withLicenseAndQuota(
        'skill_audit',
        { skillId: 'foo/bar' },
        inputSchema,
        handler,
        mockCtx,
        denyingLicense(),
        mockQuota
      )

      expect(result.isError).toBe(true)
      expect(handlerCalled).toBe(false)
    } finally {
      if (savedEnv === undefined) delete process.env[AGENT_TOOL_PROFILE_ENV_VAR]
      else process.env[AGENT_TOOL_PROFILE_ENV_VAR] = savedEnv
    }
  })
})
