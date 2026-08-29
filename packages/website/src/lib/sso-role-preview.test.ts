import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from './supabase-client'
import { previewSsoRoleMapping, type SsoRoleMapping } from './sso-role-preview'

vi.mock('./supabase-client', () => ({
  getSupabaseClient: vi.fn(),
}))

const mockGetSupabaseClient = vi.mocked(getSupabaseClient)

function makeClient(opts: {
  data?: unknown
  error?: { message: string } | null
  rpcThrows?: boolean
}): { client: SupabaseClient; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async () => {
    if (opts.rpcThrows) throw new Error('network down')
    return { data: opts.data ?? null, error: opts.error ?? null }
  })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

const MAPPING: SsoRoleMapping = { admin: ['eng-leads'], member: ['engineering'] }

describe('previewSsoRoleMapping', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('happy path: resolves to the role sso_map_role() returns', async () => {
    const { client, rpc } = makeClient({ data: 'admin' })
    mockGetSupabaseClient.mockReturnValue(client)

    const role = await previewSsoRoleMapping(['eng-leads'], MAPPING)

    expect(role).toBe('admin')
    expect(rpc).toHaveBeenCalledWith('sso_map_role', {
      p_group_claims: ['eng-leads'],
      p_role_mapping: MAPPING,
    })
  })

  it('happy path: resolves to member for a member-only group match', async () => {
    const { client } = makeClient({ data: 'member' })
    mockGetSupabaseClient.mockReturnValue(client)

    const role = await previewSsoRoleMapping(['engineering'], MAPPING)

    expect(role).toBe('member')
  })

  it('null data (no group matches) resolves to null', async () => {
    const { client } = makeClient({ data: null })
    mockGetSupabaseClient.mockReturnValue(client)

    const role = await previewSsoRoleMapping(['unrelated-group'], MAPPING)

    expect(role).toBeNull()
  })

  it('an unexpected non-role string from the RPC is treated as null, not passed through', async () => {
    const { client } = makeClient({ data: 'owner' })
    mockGetSupabaseClient.mockReturnValue(client)

    const role = await previewSsoRoleMapping(['whatever'], MAPPING)

    expect(role).toBeNull()
  })

  it('RPC error response resolves to null, not a throw', async () => {
    const { client } = makeClient({ error: { message: 'permission denied' } })
    mockGetSupabaseClient.mockReturnValue(client)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(previewSsoRoleMapping(['eng-leads'], MAPPING)).resolves.toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('RPC throw (e.g. network failure) resolves to null, not an uncaught exception', async () => {
    const { client } = makeClient({ rpcThrows: true })
    mockGetSupabaseClient.mockReturnValue(client)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(previewSsoRoleMapping(['eng-leads'], MAPPING)).resolves.toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('no Supabase client configured resolves to null, not a throw', async () => {
    mockGetSupabaseClient.mockReturnValue(null)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(previewSsoRoleMapping(['eng-leads'], MAPPING)).resolves.toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })

  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('an RPC call that never resolves times out gracefully and resolves to null', async () => {
      const rpc = vi.fn(
        () =>
          new Promise(() => {
            /* never resolves — simulates an unreachable RPC */
          })
      )
      mockGetSupabaseClient.mockReturnValue({ rpc } as unknown as SupabaseClient)
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      const pending = previewSsoRoleMapping(['eng-leads'], MAPPING)
      await vi.advanceTimersByTimeAsync(8000)

      await expect(pending).resolves.toBeNull()
      expect(errorSpy).toHaveBeenCalled()
    })
  })
})
