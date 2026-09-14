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

    // Round 2 finding 3: the result now also names WHICH source resolved it.
    await expect(resolveRegistryTeamId()).resolves.toEqual({
      teamId: 'team-env',
      source: 'env:SKILLSMITH_LICENSE_KEY',
    })
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'jwt_license_blob',
    })
  })

  it('labels SKILLSMITH_API_KEY (not SKILLSMITH_LICENSE_KEY) as the source when only it is set', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_api_key_only'
    rpcMock.mockResolvedValue({ data: 'team-env', error: null })

    await expect(resolveRegistryTeamId()).resolves.toMatchObject({
      source: 'env:SKILLSMITH_API_KEY',
    })
  })

  // Test item 3: credential only in the config.json fixture (temp HOME) → team resolved.
  it("falls back to ~/.skillsmith/config.json's apiKey when no env credential is set", async () => {
    writeConfigApiKey('sk_live_from_config_file')
    rpcMock.mockResolvedValue({ data: 'team-config', error: null })

    await expect(resolveRegistryTeamId()).resolves.toEqual({
      teamId: 'team-config',
      source: 'config.json',
    })
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'sk_live_from_config_file',
    })
  })

  it('prefers an env credential over config.json when both are present', async () => {
    process.env.SKILLSMITH_API_KEY = 'env_wins'
    writeConfigApiKey('config_loses')
    rpcMock.mockResolvedValue({ data: 'team-env', error: null })

    const result = await resolveRegistryTeamId()
    expect(result.source).toBe('env:SKILLSMITH_API_KEY')
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', { p_license_key: 'env_wins' })
  })

  // Round 2 finding 3: "Add tests for the env-over-config precedence message" — the error text
  // itself must name the env source, not config.json, when both are present and resolution fails.
  it('names the env source (not config.json) in the error when both are present and the RPC fails', async () => {
    process.env.SKILLSMITH_LICENSE_KEY = 'env_wins_error_path'
    writeConfigApiKey('config_loses_error_path')
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } })

    await expect(resolveRegistryTeamId()).rejects.toThrow(
      /SKILLSMITH_LICENSE_KEY environment variable/
    )
    await expect(resolveRegistryTeamId()).rejects.not.toThrow(/config\.json/)
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

/** The exact env keys any test in this describe block touches — snapshotted/restored per-key
 *  (not a wholesale `process.env = {...}` reassignment, which could drop or clobber a key some
 *  OTHER concurrent piece of test infra depends on). */
const SERVICE_SELECTION_ENV_KEYS = [
  'SKILLSMITH_REGISTRY_STUB',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SKILLSMITH_LICENSE_KEY',
  'SKILLSMITH_API_KEY',
  'VITEST',
] as const

function snapshotServiceSelectionEnv(): () => void {
  const saved: Partial<Record<(typeof SERVICE_SELECTION_ENV_KEYS)[number], string>> = {}
  for (const key of SERVICE_SELECTION_ENV_KEYS) saved[key] = process.env[key]
  return () => {
    for (const key of SERVICE_SELECTION_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

describe('registry-tools.ts — module-level service selection (SMI-6622)', () => {
  let restoreEnv: () => void

  beforeEach(() => {
    restoreEnv = snapshotServiceSelectionEnv()
    vi.resetModules()
  })

  afterEach(() => {
    restoreEnv()
    vi.doUnmock('./registry-tools.team.js')
    vi.doUnmock('../supabase-client.js')
    // Re-establish this file's top-level supabase-client mock for every subsequent test in THIS
    // file, regardless of run order — some tests below deliberately vi.doUnmock() it to exercise
    // the real module (team resolution running for real against a mocked RPC), and doUnmock has
    // no automatic expiry.
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

    // importOriginal + spread (SMI-6622 round 2) — see registry-tools.install-action.test.ts's
    // identical comment for why (a future new export never needs re-adding to every mock).
    vi.doMock('./registry-tools.team.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./registry-tools.team.js')>()
      return {
        ...actual,
        resolveRegistryTeamId: vi.fn(async () => ({
          teamId: 'team-live-default',
          source: 'env:SKILLSMITH_LICENSE_KEY',
        })),
        readRegistryCredential: vi.fn(() => 'sk_test_fake_license'),
      }
    })

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

  // Test item 2 (round-2 adversarial finding 5): the property actually worth proving is NOT "zero
  // network calls at all" — team resolution (registry-tools.team.ts) is deliberately independent
  // of which CRUD service is selected and must NEVER be mocked away or skipped just because the
  // stub is active (the original task's own "never fall back to a stub id" requirement). Mocking
  // away registry-tools.team.js here (the original version of this test did) only proved "a
  // function we replaced with a no-op was not called," which is circular. Left UNMOCKED below —
  // team resolution runs for REAL against a mocked RPC (`getSupabaseClient`) — the actually
  // load-bearing assertion is that the LIVE-only client getters (`getSupabaseUserClient`,
  // `getSupabaseAdminClient` — the two `registry-tools.live.ts` calls for every CRUD op and audit
  // write) are never reached, while `getSupabaseClient` (team resolution's own anon-key client) IS
  // called exactly once. That is the real boundary the stub SERVICE selection draws: CRUD/content
  // never leaves memory; team resolution still genuinely runs.
  it('selects the stub service under SKILLSMITH_REGISTRY_STUB — CRUD stays offline while team resolution runs for real', async () => {
    process.env.SKILLSMITH_REGISTRY_STUB = '1'
    process.env.SKILLSMITH_API_KEY = 'sk_live_stub_service_test'
    rpcMock.mockReset()
    rpcMock.mockResolvedValue({ data: 'team-stub-network-test', error: null })
    // Real registry-tools.team.js for this test — see the comment above for why mocking it away
    // would make the assertions below circular.
    vi.doUnmock('./registry-tools.team.js')

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
    // Team resolution ran for real and reached the RPC exactly once.
    expect(getSupabaseClient).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'sk_live_stub_service_test',
    })
    // The stub's own CRUD path never touches either LIVE-only client getter.
    expect(getSupabaseUserClient).not.toHaveBeenCalled()
    expect(getSupabaseAdminClient).not.toHaveBeenCalled()
  })

  // Round-2 adversarial finding 1a: SKILLSMITH_REGISTRY_STUB is honored only under the Vitest
  // runner — outside it (a stray value in a real MCP host's config), the live service must still
  // be selected. Simulated here by deleting process.env.VITEST for one fresh import; every other
  // test in this describe block runs with VITEST left at its real ('true', set by Vitest itself)
  // value, so this is the only place that override is needed.
  it('ignores SKILLSMITH_REGISTRY_STUB entirely when process.env.VITEST is not "true"', async () => {
    delete process.env.VITEST
    process.env.SKILLSMITH_REGISTRY_STUB = '1'
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const registryTools = await import('./registry-tools.js')
      const { isStubService } = await import('./stub-data-source.js')

      expect(isStubService(registryTools.getPrivateRegistryService())).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/SKILLSMITH_REGISTRY_STUB/))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// Test item 9's regression guards (team-resolver.ts's resolveLicenseTeamId() unchanged;
// team-workspace/rbac/sso service selection unchanged) deliberately live in the standalone
// registry-tools.team-regression-guards.test.ts, NOT here — they must keep passing even against a
// reverted/deleted registry-tools.team.ts (the SMI-6598 revert-check this file's own new-behavior
// tests are held to), and a top-level import of that module in THIS file would otherwise fail the
// whole file to load under that revert, including these two unrelated guards.
