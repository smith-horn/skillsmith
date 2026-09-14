/**
 * @fileoverview registry-tools.team.ts — registry-only team resolution, no env gate (SMI-6622)
 * @see SMI-6622: `registry-tools.ts` must never gate service selection or team resolution on
 *      `SUPABASE_URL`/`SUPABASE_ANON_KEY`. Two independent things are exercised here:
 *
 *   1. `resolveRegistryTeamId()` itself (credential precedence: env, then
 *      `~/.skillsmith/config.json`; every failure mode; never a stub team id) — `isSupabaseConfigured`
 *      is mocked to `false` throughout this file specifically so a green run here cannot be
 *      accidentally explained by Supabase "happening" to look configured.
 *   2. `registry-tools.ts`'s module-level SERVICE selection (live by default, stub only under the
 *      `SKILLSMITH_REGISTRY_STUB` opt-in) — this half needs `vi.resetModules()` + a fresh dynamic
 *      import per test, since the singleton is computed once at module load.
 *
 * `registry-tools.api-key-fallback.test.ts` covers the SAME credential chain end-to-end through
 * the MCP tool handlers (SMI-6080); this file is the resolver's own direct/unit coverage, plus the
 * module-load service-selection tests that file doesn't attempt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../context.js'

const rpcMock = vi.fn()

vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => false),
  getSupabaseClient: vi.fn(async () => ({ rpc: rpcMock })),
  getSupabaseAdminClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

import { resolveRegistryTeamId, RegistryTeamResolutionError } from './registry-tools.team.js'

function makeContext(): ToolContext {
  return {} as unknown as ToolContext
}

/** Snapshot both credential env vars, clear them, and return a restore fn (mirrors
 *  registry-tools.api-key-fallback.test.ts's own isolateCredentialEnv()). */
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

function configPath(): string {
  return join(homedir(), '.skillsmith', 'config.json')
}

/** Writes a real config.json under the vitest.setup.ts $HOME sandbox — never the developer's own
 *  ~/.skillsmith (SMI-6343). */
function writeConfigApiKey(apiKey: string): void {
  mkdirSync(join(homedir(), '.skillsmith'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify({ apiKey }), 'utf-8')
}

function clearConfig(): void {
  rmSync(configPath(), { force: true })
}

describe('resolveRegistryTeamId — credential resolution (SMI-6622)', () => {
  let restoreEnv: () => void

  beforeEach(() => {
    restoreEnv = isolateCredentialEnv()
    clearConfig()
    rpcMock.mockReset()
    rpcMock.mockResolvedValue({ data: null, error: null })
  })

  afterEach(() => {
    restoreEnv()
    clearConfig()
    vi.clearAllMocks()
  })

  it('resolves via SKILLSMITH_LICENSE_KEY even though isSupabaseConfigured() is false — no env gate', async () => {
    const { isSupabaseConfigured } = await import('../supabase-client.js')
    expect(vi.mocked(isSupabaseConfigured)()).toBe(false) // sanity: genuinely "unconfigured"

    process.env.SKILLSMITH_LICENSE_KEY = 'jwt_license_blob'
    rpcMock.mockResolvedValue({ data: 'team-env', error: null })

    await expect(resolveRegistryTeamId()).resolves.toBe('team-env')
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'jwt_license_blob',
    })
  })

  // Test item 3: credential only in the config.json fixture (temp HOME) → team resolved.
  it("falls back to ~/.skillsmith/config.json's apiKey when no env credential is set", async () => {
    writeConfigApiKey('sk_live_from_config_file')
    rpcMock.mockResolvedValue({ data: 'team-config', error: null })

    await expect(resolveRegistryTeamId()).resolves.toBe('team-config')
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'sk_live_from_config_file',
    })
  })

  it('prefers an env credential over config.json when both are present', async () => {
    process.env.SKILLSMITH_API_KEY = 'env_wins'
    writeConfigApiKey('config_loses')
    rpcMock.mockResolvedValue({ data: 'team-env', error: null })

    await resolveRegistryTeamId()
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', { p_license_key: 'env_wins' })
  })

  // Test item 4: no credential anywhere → a clear error, no stub id.
  it('throws a clear, actionable error with no credential anywhere — never a stub id', async () => {
    await expect(resolveRegistryTeamId()).rejects.toThrow(/SKILLSMITH_LICENSE_KEY/)
    await expect(resolveRegistryTeamId()).rejects.toThrow(/SKILLSMITH_API_KEY/)
    await expect(resolveRegistryTeamId()).rejects.toThrow(/skillsmith login/i)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  // Test item 5: malformed key → the RPC returns null → a clear error.
  it('throws a clear error when the RPC resolves no team for an unknown/malformed key', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_unknown'
    rpcMock.mockResolvedValue({ data: null, error: null })

    await expect(resolveRegistryTeamId()).rejects.toThrow(/Unable to resolve team/i)
    await expect(resolveRegistryTeamId()).rejects.not.toThrow(RegistryTeamResolutionError)
  })

  // Test item 6: RPC/network error → a typed error, never a stub fallback.
  it('throws a typed RegistryTeamResolutionError on an RPC-level failure', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_x'
    rpcMock.mockResolvedValue({ data: null, error: { message: 'permission denied' } })

    await expect(resolveRegistryTeamId()).rejects.toBeInstanceOf(RegistryTeamResolutionError)
  })

  it('throws a typed RegistryTeamResolutionError on a network/transport failure', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_x'
    const { getSupabaseClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseClient).mockRejectedValueOnce(new Error('fetch failed'))

    await expect(resolveRegistryTeamId()).rejects.toBeInstanceOf(RegistryTeamResolutionError)
  })
})

// ============================================================================
// Module-level SERVICE selection (registry-tools.ts) — items 1, 2, 9
// ============================================================================

describe('registry-tools.ts — module-level service selection (SMI-6622)', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.doUnmock('./registry-tools.team.js')
    // Re-establish this file's top-level supabase-client mock for every subsequent test,
    // regardless of run order — the two regression-guard tests below deliberately
    // vi.doUnmock('../supabase-client.js') to exercise the REAL module, and doUnmock has no
    // automatic expiry.
    vi.doMock('../supabase-client.js', () => ({
      isSupabaseConfigured: vi.fn(() => false),
      getSupabaseClient: vi.fn(async () => ({ rpc: rpcMock })),
      getSupabaseAdminClient: vi.fn(),
      getSupabaseUserClient: vi.fn(),
      resetSupabaseClients: vi.fn(),
    }))
  })

  // Test item 1: no SUPABASE_* env and no stub flag → the live service is selected, and
  // dataSource === 'live' (network mocked via this file's own top-level supabase-client mock).
  it('selects the live service by default — no SKILLSMITH_REGISTRY_STUB, no Supabase env', async () => {
    delete process.env.SKILLSMITH_REGISTRY_STUB
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_ANON_KEY

    vi.doMock('./registry-tools.team.js', () => ({
      resolveRegistryTeamId: vi.fn(async () => 'team-live-default'),
    }))

    const registryTools = await import('./registry-tools.js')
    const { isStubService, dataSourceFor } = await import('./stub-data-source.js')

    const service = registryTools.getPrivateRegistryService()
    expect(isStubService(service)).toBe(false)
    expect(dataSourceFor(service)).toBe('live')

    const result = await registryTools.executePrivateRegistryManage(
      { action: 'list' },
      makeContext()
    )
    expect(result.dataSource).toBe('live')
  })

  // Test item 2: stub flag set → stub selected, dataSource === 'stub', and zero network calls.
  it('selects the stub service under SKILLSMITH_REGISTRY_STUB, making zero network calls', async () => {
    process.env.SKILLSMITH_REGISTRY_STUB = '1'

    vi.doMock('./registry-tools.team.js', () => ({
      resolveRegistryTeamId: vi.fn(async () => 'team-stub-default'),
    }))

    const registryTools = await import('./registry-tools.js')
    const { isStubService } = await import('./stub-data-source.js')
    const { getSupabaseClient, getSupabaseUserClient, getSupabaseAdminClient } =
      await import('../supabase-client.js')

    expect(isStubService(registryTools.getPrivateRegistryService())).toBe(true)

    const result = await registryTools.executePrivateRegistryManage(
      { action: 'list' },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('stub')
    expect(getSupabaseClient).not.toHaveBeenCalled()
    expect(getSupabaseUserClient).not.toHaveBeenCalled()
    expect(getSupabaseAdminClient).not.toHaveBeenCalled()
  })
})

// Test item 9's regression guards (team-resolver.ts's resolveLicenseTeamId() unchanged;
// team-workspace/rbac/sso service selection unchanged) deliberately live in the standalone
// registry-tools.team-regression-guards.test.ts, NOT here — they must keep passing even against a
// reverted/deleted registry-tools.team.ts (the SMI-6598 revert-check this file's own new-behavior
// tests are held to), and a top-level import of that module in THIS file would otherwise fail the
// whole file to load under that revert, including these two unrelated guards.
