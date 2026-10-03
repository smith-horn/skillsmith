/**
 * @fileoverview End-to-end team resolution for private-registry tools with only SKILLSMITH_API_KEY
 * @see SMI-6080: `private_registry_publish` / `private_registry_manage` could not resolve a team
 *      from a complimentary/admin-granted API key
 * @see SMI-6622: `registry-tools.ts`'s `resolveTeamId()` now delegates to the registry-only
 *      `registry-tools.team.ts` (not `team-resolver.ts`'s `resolveLicenseTeamId()` directly), but
 *      that new module reuses `team-resolver.ts`'s `readLicenseKey()` as-is for its env-credential
 *      half — so the env-var precedence this file exercises is unchanged. Its own dedicated
 *      config.json-fallback and error-typing coverage lives in registry-tools.team.test.ts.
 *
 * Every OTHER registry-tools test mocks `./team-resolver.js` (now: `./registry-tools.team.js`)
 * wholesale, so none of them exercise the real credential-resolution chain. This file deliberately
 * does NOT mock either: it stubs only the Supabase surface underneath (`isSupabaseConfigured` + a
 * recording `rpc()`), so `readLicenseKey()` → `resolveRegistryTeamId()` → `resolve_team_from_license`
 * runs for real and a regression in the fallback fails here instead of silently passing everywhere.
 *
 * Scope: this covers TEAM RESOLUTION only — "which team is this call for". The publish / install /
 * submissions / approve / deprecate actions additionally require a signed-in user's own Supabase
 * JWT (`skillsmith login`, via `resolveUserAccessToken()`), which no team credential can supply.
 * Those user-JWT paths are covered in registry-tools.live.admin-auth.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  executePrivateRegistryManage,
  executePrivateRegistryPublish,
  createStubRegistryService,
  setPrivateRegistryService,
} from './registry-tools.js'

const rpcMock = vi.fn()

// Only the Supabase surface is mocked — team-resolver.js itself runs for real.
vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(async () => ({ rpc: rpcMock })),
  getSupabaseAdminClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

const RESOLVED_TEAM = 'team_from_api_key'

function makeContext(): ToolContext {
  return {} as unknown as ToolContext
}

/** Snapshot both credential env vars, clear them, and return a restore fn. */
function isolateCredentialEnv(): () => void {
  const origLicense = process.env.SKILLSMITH_LICENSE_KEY
  const origApiKey = process.env.SKILLSMITH_API_KEY
  delete process.env.SKILLSMITH_LICENSE_KEY
  delete process.env.SKILLSMITH_API_KEY
  return () => {
    if (origLicense === undefined) delete process.env.SKILLSMITH_LICENSE_KEY
    else process.env.SKILLSMITH_LICENSE_KEY = origLicense
    if (origApiKey === undefined) delete process.env.SKILLSMITH_API_KEY
    else process.env.SKILLSMITH_API_KEY = origApiKey
  }
}

describe('private-registry team resolution — SKILLSMITH_API_KEY fallback (SMI-6080)', () => {
  let restoreEnv: () => void

  beforeEach(() => {
    restoreEnv = isolateCredentialEnv()
    rpcMock.mockReset()
    rpcMock.mockResolvedValue({ data: RESOLVED_TEAM, error: null })
    setPrivateRegistryService(createStubRegistryService())
  })

  afterEach(() => {
    restoreEnv()
    vi.clearAllMocks()
  })

  it('resolves a team for private_registry_manage with only SKILLSMITH_API_KEY set', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_admin_granted'

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    // SMI-6622/SMI-6184: dataSource now reflects which SERVICE is actually wired in
    // (dataSourceFor(service)), not isSupabaseConfigured() — this file's own beforeEach injects
    // createStubRegistryService() deliberately (so CRUD stays safe/offline) while still exercising
    // REAL team resolution against the mocked RPC below, so 'stub' here is correct, not a
    // regression: it is the exact drift SMI-6184 fixed for the other tool families.
    expect(result.dataSource).toBe('stub')
    expect(result.error).toBeUndefined()
    // The API key is what actually reached the RPC — the whole point of the fallback.
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'sk_live_admin_granted',
    })
  })

  it('resolves a team for private_registry_publish with only SKILLSMITH_API_KEY set', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_admin_granted'

    const result = await executePrivateRegistryPublish(
      {
        skillId: 'myteam/my-skill',
        version: '1.0.0',
        content: { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' },
      },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'sk_live_admin_granted',
    })
  })

  it('still prefers SKILLSMITH_LICENSE_KEY when both are set', async () => {
    process.env.SKILLSMITH_LICENSE_KEY = 'jwt_license_blob'
    process.env.SKILLSMITH_API_KEY = 'sk_live_admin_granted'

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'jwt_license_blob',
    })
  })

  it('names both env vars in the no-credential error, and points at `skillsmith login`', async () => {
    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toContain('SKILLSMITH_LICENSE_KEY')
    expect(result.error).toContain('SKILLSMITH_API_KEY')
    // Scope boundary: resolving a team is not the same as proving who is calling.
    expect(result.error).toContain('skillsmith login')
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('surfaces a typed error when the API key resolves to no team', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_not_on_a_team'
    rpcMock.mockResolvedValue({ data: null, error: null })

    const result = await executePrivateRegistryManage({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toContain('Unable to resolve team')
    expect(result.error).toContain('SKILLSMITH_API_KEY')
  })

  // ============================================================================
  // SMI-6622 round 6 PR-07 finding 4: end-to-end through the actual MCP tool handlers —
  // registry-tools.ts's publish/manage catch blocks (lines ~253-258, ~341-347) forward
  // resolveRegistryTeamId()'s thrown `.message` directly into the result. A team-resolution
  // failure with credential-shaped text anywhere upstream (an RPC error, a thrown exception, or
  // getSupabaseClient() itself failing) must never let that text reach either tool's result.
  // ============================================================================

  describe('team-resolution failures never leak secrets into either tool result (round 6 PR-07)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'
    const apiKey = 'sk_live_abcdefghijklmnopqrstuvwx'
    const licenseKey = 'sk_test_fake_license'

    it('rpc_error: an RPC error.message containing secrets reaches neither the manage nor the publish result', async () => {
      process.env.SKILLSMITH_API_KEY = 'sk_live_x'
      rpcMock.mockResolvedValue({
        data: null,
        error: {
          message: `permission denied for token ${jwt} key ${apiKey} license ${licenseKey}`,
        },
      })

      const manageResult = await executePrivateRegistryManage({ action: 'list' }, makeContext())
      expect(manageResult.success).toBe(false)
      expect(manageResult.error).not.toContain(jwt)
      expect(manageResult.error).not.toContain(apiKey)
      expect(manageResult.error).not.toContain(licenseKey)

      const publishResult = await executePrivateRegistryPublish(
        {
          skillId: 'myteam/my-skill',
          version: '1.0.0',
          content: { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' },
        },
        makeContext()
      )
      expect(publishResult.success).toBe(false)
      expect(publishResult.error).not.toContain(jwt)
      expect(publishResult.error).not.toContain(apiKey)
      expect(publishResult.error).not.toContain(licenseKey)
    })

    it('transport_error: a thrown RPC-call exception containing secrets reaches neither the manage nor the publish result', async () => {
      process.env.SKILLSMITH_API_KEY = 'sk_live_x'
      rpcMock.mockRejectedValue(
        new Error(`upstream failure: token ${jwt} key ${apiKey} license ${licenseKey}`)
      )

      const manageResult = await executePrivateRegistryManage({ action: 'list' }, makeContext())
      expect(manageResult.success).toBe(false)
      expect(manageResult.error).not.toContain(jwt)
      expect(manageResult.error).not.toContain(apiKey)
      expect(manageResult.error).not.toContain(licenseKey)

      const publishResult = await executePrivateRegistryPublish(
        {
          skillId: 'myteam/my-skill',
          version: '1.0.0',
          content: { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' },
        },
        makeContext()
      )
      expect(publishResult.success).toBe(false)
      expect(publishResult.error).not.toContain(jwt)
      expect(publishResult.error).not.toContain(apiKey)
      expect(publishResult.error).not.toContain(licenseKey)
    })

    it('client_unavailable: getSupabaseClient() throwing with secrets in its message reaches neither the manage nor the publish result', async () => {
      process.env.SKILLSMITH_API_KEY = 'sk_live_x'
      const { getSupabaseClient } = await import('../supabase-client.js')
      vi.mocked(getSupabaseClient).mockRejectedValue(
        new Error(`client init failed: token ${jwt} key ${apiKey} license ${licenseKey}`)
      )

      const manageResult = await executePrivateRegistryManage({ action: 'list' }, makeContext())
      expect(manageResult.success).toBe(false)
      expect(manageResult.error).not.toContain(jwt)
      expect(manageResult.error).not.toContain(apiKey)
      expect(manageResult.error).not.toContain(licenseKey)

      const publishResult = await executePrivateRegistryPublish(
        {
          skillId: 'myteam/my-skill',
          version: '1.0.0',
          content: { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' },
        },
        makeContext()
      )
      expect(publishResult.success).toBe(false)
      expect(publishResult.error).not.toContain(jwt)
      expect(publishResult.error).not.toContain(apiKey)
      expect(publishResult.error).not.toContain(licenseKey)

      vi.mocked(getSupabaseClient).mockReset()
      vi.mocked(getSupabaseClient).mockImplementation(async () => ({ rpc: rpcMock }))
    })
  })
})
