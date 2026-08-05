/**
 * @fileoverview Unit tests for shared team-resolver helper
 * @see SMI-4292: Wave 5A — Team workspaces foundation (finding C3)
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

describe('readLicenseKey', () => {
  const origEnv = process.env.SKILLSMITH_LICENSE_KEY

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.SKILLSMITH_LICENSE_KEY
    } else {
      process.env.SKILLSMITH_LICENSE_KEY = origEnv
    }
  })

  it('prefers an explicit value over env', () => {
    process.env.SKILLSMITH_LICENSE_KEY = 'env_key'
    expect(readLicenseKey('arg_key')).toBe('arg_key')
  })

  it('falls back to env when no explicit value', () => {
    process.env.SKILLSMITH_LICENSE_KEY = 'env_key'
    expect(readLicenseKey()).toBe('env_key')
  })

  it('returns null when both sources are empty', () => {
    delete process.env.SKILLSMITH_LICENSE_KEY
    expect(readLicenseKey()).toBeNull()
    expect(readLicenseKey('')).toBeNull()
  })
})

describe('resolveLicenseTeamId', () => {
  beforeEach(() => {
    rpcMock.mockReset()
  })

  it('returns null when Supabase is not configured', async () => {
    const { isSupabaseConfigured } = await import('../supabase-client.js')
    vi.mocked(isSupabaseConfigured).mockReturnValueOnce(false)
    const result = await resolveLicenseTeamId('sk_live_something')
    expect(result).toBeNull()
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('returns null when no license key is available', async () => {
    delete process.env.SKILLSMITH_LICENSE_KEY
    const result = await resolveLicenseTeamId()
    expect(result).toBeNull()
    expect(rpcMock).not.toHaveBeenCalled()
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
