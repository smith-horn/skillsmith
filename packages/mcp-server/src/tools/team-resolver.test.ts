/**
 * @fileoverview Unit tests for shared team-resolver helper
 * @see SMI-4292: Wave 5A — Team workspaces foundation (finding C3)
 * @see SMI-6080: SKILLSMITH_API_KEY fallback for admin-granted (non-JWT) Enterprise access
 *
 * Both `SKILLSMITH_LICENSE_KEY` and `SKILLSMITH_API_KEY` are saved/cleared/restored around every
 * test that reads either. Before SMI-6080 only the license key mattered, so leaving a real
 * `SKILLSMITH_API_KEY` in the ambient environment was harmless; now it is a live input to
 * `readLicenseKey()` and would make these assertions environment-order-dependent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readLicenseKey, resolveLicenseTeamId, resolveUserAccessToken } from './team-resolver.js'

// Mock the supabase-client module BEFORE the import is resolved
const rpcMock = vi.fn()
vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(async () => ({ rpc: rpcMock })),
}))

// SMI-5905 Wave 1: resolveUserAccessToken() now delegates to
// @skillsmith/core's resolveFreshAccessToken() — mock it to assert the
// delegation, not the (now-extracted) skew logic itself, which is covered by
// client.token-refresh.test.ts.
//
// vi.mock() factories are hoisted above ALL module-level code, including
// `const` declarations further up this same file — a plain
// `const resolveFreshAccessTokenMock = vi.fn()` here is still in the
// temporal dead zone when the factory below actually runs (it's invoked
// eagerly, at mock-resolution time, unlike the lazily-evaluated `rpcMock`
// reference above). vi.hoisted() hoists the value's own creation to the
// same point, avoiding the TDZ ReferenceError.
const { resolveFreshAccessTokenMock } = vi.hoisted(() => ({
  resolveFreshAccessTokenMock: vi.fn(),
}))
vi.mock('@skillsmith/core', () => ({
  resolveFreshAccessToken: resolveFreshAccessTokenMock,
}))

/**
 * Snapshot both credential env vars, clear them, and return a restore fn.
 *
 * Every suite below both reads and writes these, so an ambient value (a developer's real
 * `SKILLSMITH_API_KEY`, or leakage from a sibling test) must not reach the code under test.
 */
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

describe('readLicenseKey', () => {
  let restoreEnv: () => void

  beforeEach(() => {
    restoreEnv = isolateCredentialEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  it('prefers an explicit value over env', () => {
    process.env.SKILLSMITH_LICENSE_KEY = 'env_key'
    expect(readLicenseKey('arg_key')).toBe('arg_key')
  })

  // SMI-6080: the explicit argument outranks BOTH env vars, not just the license key.
  it('prefers an explicit value over both env vars', () => {
    process.env.SKILLSMITH_LICENSE_KEY = 'env_license_key'
    process.env.SKILLSMITH_API_KEY = 'sk_live_env_api_key'
    expect(readLicenseKey('arg_key')).toBe('arg_key')
  })

  it('falls back to env when no explicit value', () => {
    process.env.SKILLSMITH_LICENSE_KEY = 'env_key'
    expect(readLicenseKey()).toBe('env_key')
  })

  // SMI-6080: precedence is preserved — an account that does hold a real signed license blob
  // keeps resolving through it, unchanged, even when an API key is also configured.
  it('prefers SKILLSMITH_LICENSE_KEY over SKILLSMITH_API_KEY when both are set', () => {
    process.env.SKILLSMITH_LICENSE_KEY = 'env_license_key'
    process.env.SKILLSMITH_API_KEY = 'sk_live_env_api_key'
    expect(readLicenseKey()).toBe('env_license_key')
  })

  // SMI-6080: the actual bug — an admin-granted account holds only a plain API key.
  it('falls back to SKILLSMITH_API_KEY when SKILLSMITH_LICENSE_KEY is unset', () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_env_api_key'
    expect(readLicenseKey()).toBe('sk_live_env_api_key')
  })

  it('returns null when all sources are empty', () => {
    expect(readLicenseKey()).toBeNull()
    expect(readLicenseKey('')).toBeNull()
  })

  // An empty-string env var is "unset" for this purpose, at both levels of the chain.
  it('treats an empty SKILLSMITH_LICENSE_KEY as unset and still reads the API key', () => {
    process.env.SKILLSMITH_LICENSE_KEY = ''
    process.env.SKILLSMITH_API_KEY = 'sk_live_env_api_key'
    expect(readLicenseKey()).toBe('sk_live_env_api_key')
  })

  it('returns null when both env vars are empty strings', () => {
    process.env.SKILLSMITH_LICENSE_KEY = ''
    process.env.SKILLSMITH_API_KEY = ''
    expect(readLicenseKey()).toBeNull()
  })
})

describe('resolveLicenseTeamId', () => {
  let restoreEnv: () => void

  beforeEach(() => {
    rpcMock.mockReset()
    restoreEnv = isolateCredentialEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  it('returns null when Supabase is not configured', async () => {
    const { isSupabaseConfigured } = await import('../supabase-client.js')
    vi.mocked(isSupabaseConfigured).mockReturnValueOnce(false)
    const result = await resolveLicenseTeamId('sk_live_something')
    expect(result).toBeNull()
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('returns null when no credential is available in either env var', async () => {
    const result = await resolveLicenseTeamId()
    expect(result).toBeNull()
    expect(rpcMock).not.toHaveBeenCalled()
  })

  // SMI-6080: `resolve_team_from_license` SHA-256-hashes whatever string it is given and matches
  // `license_keys.key_hash` — a plain `sk_live_*` API key resolves through the identical lookup,
  // which is the whole reason the fallback is safe.
  it('resolves a team from SKILLSMITH_API_KEY alone', async () => {
    process.env.SKILLSMITH_API_KEY = 'sk_live_admin_granted'
    rpcMock.mockResolvedValueOnce({ data: 'team_from_api_key', error: null })

    const result = await resolveLicenseTeamId()

    expect(result).toBe('team_from_api_key')
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'sk_live_admin_granted',
    })
  })

  it('sends SKILLSMITH_LICENSE_KEY, not SKILLSMITH_API_KEY, when both are set', async () => {
    process.env.SKILLSMITH_LICENSE_KEY = 'jwt_license_blob'
    process.env.SKILLSMITH_API_KEY = 'sk_live_admin_granted'
    rpcMock.mockResolvedValueOnce({ data: 'team_from_license', error: null })

    const result = await resolveLicenseTeamId()

    expect(result).toBe('team_from_license')
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'jwt_license_blob',
    })
  })

  it('returns null when RPC returns an error', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'nope' } })
    const result = await resolveLicenseTeamId('sk_live_TEST')
    expect(result).toBeNull()
  })

  it('returns team_id when RPC resolves a team', async () => {
    rpcMock.mockResolvedValueOnce({ data: 'team_abc', error: null })
    const result = await resolveLicenseTeamId('sk_live_TEST')
    expect(result).toBe('team_abc')
    expect(rpcMock).toHaveBeenCalledWith('resolve_team_from_license', {
      p_license_key: 'sk_live_TEST',
    })
  })

  it('returns null when RPC data is null (no matching team)', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null })
    const result = await resolveLicenseTeamId('sk_live_TEST')
    expect(result).toBeNull()
  })
})

// SMI-5905 Wave 1 (SMI-4402 originally): resolveUserAccessToken() is now a thin delegate to
// @skillsmith/core's resolveFreshAccessToken() — the skew/refresh logic itself is tested there.
describe('resolveUserAccessToken (SMI-5905 delegation)', () => {
  beforeEach(() => {
    resolveFreshAccessTokenMock.mockReset()
  })

  it('returns whatever resolveFreshAccessToken() resolves', async () => {
    resolveFreshAccessTokenMock.mockResolvedValueOnce('delegated_at')

    const result = await resolveUserAccessToken()

    expect(result).toBe('delegated_at')
    expect(resolveFreshAccessTokenMock).toHaveBeenCalledTimes(1)
  })

  it('returns null when resolveFreshAccessToken() resolves null', async () => {
    resolveFreshAccessTokenMock.mockResolvedValueOnce(null)

    const result = await resolveUserAccessToken()

    expect(result).toBeNull()
  })
})
