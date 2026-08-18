/**
 * @fileoverview End-to-end team resolution for private-registry tools with only SKILLSMITH_API_KEY
 * @see SMI-6080: `private_registry_publish` / `private_registry_manage` could not resolve a team
 *      from a complimentary/admin-granted API key
 *
 * Every OTHER registry-tools test mocks `./team-resolver.js` wholesale, so none of them exercise
 * the real credential-resolution chain. This file deliberately does NOT mock it: it stubs only the
 * Supabase surface underneath (`isSupabaseConfigured` + a recording `rpc()`), so
 * `readLicenseKey()` → `resolveLicenseTeamId()` → `resolve_team_from_license` runs for real and a
 * regression in the fallback fails here instead of silently passing everywhere.
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
    expect(result.dataSource).toBe('live')
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
})
