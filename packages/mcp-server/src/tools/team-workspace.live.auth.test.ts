/**
 * @fileoverview `team-workspace.live.auth.ts` direct unit coverage
 * @see SMI-6113 + SMI-6241: the two named user-client getters this file exercises directly.
 *
 * `team-workspace.live.test.ts` exercises these getters only through the happy path and the
 * no-signed-in-user branch reached via `team-workspace.live.ts`'s call sites. This file mirrors
 * `registry-tools.live.auth.test.ts`'s direct-coverage approach: it calls
 * `getWorkspaceManageUserClient`/`getWorkspaceMemberUserClient` straight, without the full
 * `createLiveService` call surface, so `bindUserClient`'s catch branch (client-creation failure)
 * is exercised even if no `team-workspace.live.ts` call site ever hits it.
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

describe('team-workspace.live.auth — direct unit coverage', () => {
  it('getWorkspaceManageUserClient() returns a bound client with gate "workspace_manage" and the token subject on success', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    const fakeClient = { from: vi.fn() }
    vi.mocked(getSupabaseUserClient).mockResolvedValueOnce(fakeClient as never)

    const { getWorkspaceManageUserClient } = await import('./team-workspace.live.auth.js')
    const binding = await getWorkspaceManageUserClient('create a workspace')

    expect(binding.client).toBe(fakeClient)
    expect(binding.gate).toBe('workspace_manage')
    expect(binding.actorUserId).toBe(FAKE_USER_ID)
  })

  it('getWorkspaceMemberUserClient() returns a bound client with gate "workspace_member" on success', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    const fakeClient = { from: vi.fn() }
    vi.mocked(getSupabaseUserClient).mockResolvedValueOnce(fakeClient as never)

    const { getWorkspaceMemberUserClient } = await import('./team-workspace.live.auth.js')
    const binding = await getWorkspaceMemberUserClient('list workspaces')

    expect(binding.client).toBe(fakeClient)
    expect(binding.gate).toBe('workspace_member')
  })

  it('getWorkspaceManageUserClient() throws a workspace:manage-scoped not-signed-in message naming the operation', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)

    const { getWorkspaceManageUserClient } = await import('./team-workspace.live.auth.js')

    let thrown: unknown
    try {
      await getWorkspaceManageUserClient('delete a workspace')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toMatch(/^Only team admins can delete a workspace/)
    expect(message).toMatch(/"workspace:manage" permission/)
    expect(message).toMatch(/skillsmith login/)
  })

  it('getWorkspaceMemberUserClient() throws a member-scoped (not admin-scoped) not-signed-in message', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)

    const { getWorkspaceMemberUserClient } = await import('./team-workspace.live.auth.js')

    let thrown: unknown
    try {
      await getWorkspaceMemberUserClient('list workspaces')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toMatch(/^To list workspaces, you must run as yourself/)
    expect(message).toMatch(/Any team member can do this once signed in/)
    // Must not claim to be an admin-only gate for a membership-level operation (plan-review H5).
    expect(message).not.toMatch(/team admins/)
  })

  it('wraps a client-creation failure with "Failed to X" for the manage getter', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseUserClient).mockRejectedValueOnce(new Error('network unreachable'))

    const { getWorkspaceManageUserClient } = await import('./team-workspace.live.auth.js')

    await expect(getWorkspaceManageUserClient('create a workspace')).rejects.toThrow(
      'Failed to create a workspace: network unreachable'
    )
  })

  it('wraps a client-creation failure with "Failed to X" for the member getter', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseUserClient).mockRejectedValueOnce(new Error('token expired'))

    const { getWorkspaceMemberUserClient } = await import('./team-workspace.live.auth.js')

    await expect(getWorkspaceMemberUserClient('list workspaces')).rejects.toThrow(
      'Failed to list workspaces: token expired'
    )
  })

  it('falls back to "unknown error" when the thrown value is not an Error instance', async () => {
    const { getSupabaseUserClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseUserClient).mockRejectedValueOnce('a bare string rejection')

    const { getWorkspaceMemberUserClient } = await import('./team-workspace.live.auth.js')

    await expect(getWorkspaceMemberUserClient('list workspaces')).rejects.toThrow(
      'Failed to list workspaces: unknown error'
    )
  })
})
