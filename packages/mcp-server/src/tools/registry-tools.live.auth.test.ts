/**
 * @fileoverview `registry-tools.live.auth.ts` direct unit coverage — SMI-5821 DoD gap.
 *
 * Every other test file in this directory exercises `getAdminUserClient`/`getMemberUserClient`
 * only through the happy path and the no-signed-in-user branch (via `resolveUserAccessToken`
 * returning `null`). Nothing in the suite ever makes `getSupabaseUserClient` itself throw, so
 * `bindUserClient`'s catch branch — the error-wrapping path, including the three special-cased
 * operation names in `describeClientBindFailure` (`submissions`/`approve`/`reject` vs. the
 * default "Failed to X skill") — was unexercised (0% branch coverage on that function). This
 * file closes that gap directly, without needing the full `createLiveRegistryService` call
 * surface the other test files build around.
 */

import { describe, it, expect, vi } from 'vitest'

const { FAKE_USER_ID, FAKE_JWT } = vi.hoisted(() => {
  const userId = '11111111-2222-3333-4444-555555555555'
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return {
    FAKE_USER_ID: userId,
    FAKE_JWT: `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: userId, role: 'authenticated' })}.sig`,
  }
})

vi.mock('../supabase-client.js', () => ({
  getSupabaseUserClient: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  resolveUserAccessToken: vi.fn(async () => FAKE_JWT),
}))

describe('registry-tools.live.auth — direct unit coverage', () => {
  it('getAdminUserClient() returns a bound client with role "admin" and the token subject on success', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    const fakeClient = { from: vi.fn() }
    vi.mocked(getSupabaseUserClient).mockResolvedValueOnce(fakeClient as never)

    const { getAdminUserClient } = await import('./registry-tools.live.auth.js')
    const binding = await getAdminUserClient('deprecate')

    expect(binding.client).toBe(fakeClient)
    expect(binding.role).toBe('admin')
    expect(binding.actorUserId).toBe(FAKE_USER_ID)
  })

  it('getMemberUserClient() returns a bound client with role "member" on success', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    const fakeClient = { from: vi.fn() }
    vi.mocked(getSupabaseUserClient).mockResolvedValueOnce(fakeClient as never)

    const { getMemberUserClient } = await import('./registry-tools.live.auth.js')
    const binding = await getMemberUserClient('publish')

    expect(binding.client).toBe(fakeClient)
    expect(binding.role).toBe('member')
  })

  it('getAdminUserClient() throws the not-signed-in message with the operation name when no user token is available', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)

    const { getAdminUserClient } = await import('./registry-tools.live.auth.js')

    await expect(getAdminUserClient('deprecate')).rejects.toThrow(
      /Only team admins can deprecate a private-registry skill.*skillsmith login/s
    )
  })

  it('getMemberUserClient() throws a member-scoped (not admin-scoped) not-signed-in message', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)

    const { getMemberUserClient } = await import('./registry-tools.live.auth.js')

    let thrown: unknown
    try {
      await getMemberUserClient('publish')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toMatch(/skillsmith login/)
    // Positively verify the member-scoped wording and the interpolated operation name, not just
    // the absence of admin wording — a GPT-5.6-Sol cross-provider review of PR #2490 found the
    // original version of this test would still pass even if either of these regressed.
    expect(message).toMatch(
      /^A private-registry publish runs as you, not as your team's shared license key/
    )
    expect(message).toMatch(/Any team member can do this once signed in/)
    // Must not claim to be an admin-only gate for a member-level operation (plan-review finding H5).
    expect(message).not.toMatch(/team admins/)
  })

  it('wraps a client-creation failure with the default "Failed to X skill" message for a verb-shaped operation', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseUserClient).mockRejectedValueOnce(new Error('network unreachable'))

    const { getAdminUserClient } = await import('./registry-tools.live.auth.js')

    await expect(getAdminUserClient('deprecate')).rejects.toThrow(
      'Failed to deprecate skill: network unreachable'
    )
  })

  it('wraps a client-creation failure with the "submissions" special case (plural noun, not a verb)', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseUserClient).mockRejectedValueOnce(new Error('token expired'))

    const { getAdminUserClient } = await import('./registry-tools.live.auth.js')

    await expect(getAdminUserClient('submissions')).rejects.toThrow(
      'Failed to list private-registry submissions: token expired'
    )
  })

  it.each(['approve', 'reject'] as const)(
    'wraps a client-creation failure with the "%s submission" special case, not "%s skill"',
    async (operation) => {
      const { getSupabaseUserClient } = await import('../supabase-client.js')
      vi.mocked(getSupabaseUserClient).mockRejectedValueOnce(new Error('rpc unavailable'))

      const { getAdminUserClient } = await import('./registry-tools.live.auth.js')

      await expect(getAdminUserClient(operation)).rejects.toThrow(
        `Failed to ${operation} submission: rpc unavailable`
      )
    }
  )

  it('falls back to "unknown error" when the thrown value is not an Error instance', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseUserClient).mockRejectedValueOnce('a bare string rejection')

    const { getMemberUserClient } = await import('./registry-tools.live.auth.js')

    await expect(getMemberUserClient('install')).rejects.toThrow(
      'Failed to install skill: unknown error'
    )
  })
})
