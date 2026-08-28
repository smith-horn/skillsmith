/**
 * @fileoverview Live RBAC service — RPC wiring and refusal mapping
 * @see SMI-6203 Wave 2: `createLiveRBACService()` (`rbac-tools.live.ts`)
 * @see SMI-6203 security round: `rpcError()` must carry the PostgREST SQLSTATE across, or the
 *   whole `PASSTHROUGH_REFUSALS` allowlist is unreachable in production AND a raw Postgres
 *   `42501` (which names internal schema objects) leaks verbatim to the customer.
 *
 * Split into its own file rather than appended to `rbac-tools.test.ts` — that file is a
 * stub-mode suite and is already at its 500-line audit:standards budget. Mock style deliberately
 * mirrors `registry-tools.live.review-rbac-widening.test.ts`'s (hoisted fake JWT, `vi.mock` of
 * `../supabase-client.js` + `./team-resolver.js`, a local scripted client), so the two live-service
 * suites read the same way.
 *
 * These are passthrough tests. The authorization decisions themselves are proven by the
 * migration's own inline smoke block (`20260828000000_rbac_grant_writes.sql`, w0-w7); this file
 * only confirms the TypeScript layer forwards the caller's parameters unmodified and renders
 * whatever the database refused with, without inventing, dropping, or leaking anything.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ToolContext } from '../context.js'

const { FAKE_JWT } = vi.hoisted(() => {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const userId = '11111111-2222-3333-4444-555555555555'
  return {
    FAKE_JWT: `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: userId, role: 'authenticated' })}.sig`,
  }
})

vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveLicenseTeamId: vi.fn(async () => 'team-alpha'),
  resolveUserAccessToken: vi.fn(async () => FAKE_JWT),
}))

import { getSupabaseUserClient } from '../supabase-client.js'
import { executeRbacManage, setRBACService } from './rbac-tools.js'
import { createLiveRBACService } from './rbac-tools.live.js'
import { isPermissionDeniedError, permissionErrorText } from './team-permission-error.js'

const mockContext = {} as ToolContext

interface RpcErrorShape {
  code?: string
  message?: string
}

interface RecordedCall {
  fn: string
  params?: Record<string, unknown>
}

const calls: RecordedCall[] = []

/** Script the single `rpc()` the next tool call will make. */
function respondWith(response: { data: unknown; error: RpcErrorShape | null }): void {
  vi.mocked(getSupabaseUserClient).mockResolvedValue({
    rpc: async (fn: string, params?: Record<string, unknown>) => {
      calls.push({ fn, params })
      return response
    },
    // The real client carries far more surface; RbacSupabaseClient only needs `rpc`.
  } as unknown as Awaited<ReturnType<typeof getSupabaseUserClient>>)
}

describe('createLiveRBACService — refusal mapping', () => {
  beforeEach(() => {
    calls.length = 0
    setRBACService(createLiveRBACService())
  })

  it('forwards set_role_permission parameters to the RPC verbatim, adding nothing', async () => {
    respondWith({ data: null, error: null })
    const result = await executeRbacManage(
      {
        action: 'set_role_permission',
        role: 'member',
        permission: 'registry:approve',
        effect: 'deny',
      },
      mockContext
    )
    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    expect(calls).toEqual([
      {
        fn: 'set_team_role_permission',
        params: {
          p_team_id: 'team-alpha',
          p_role: 'member',
          p_permission: 'registry:approve',
          p_effect: 'deny',
        },
      },
    ])
  })

  it('maps the generic permission_denied refusal to the standard sentence', async () => {
    respondWith({ data: null, error: { code: '42501', message: 'permission_denied' } })
    const result = await executeRbacManage({ action: 'list_roles' }, mockContext)
    expect(result.success).toBe(false)
    expect(isPermissionDeniedError(result.error)).toBe(true)
    expect(permissionErrorText(result.error)).toContain('team:manage_rbac')
  })

  it.each([
    'Only the team owner can change who holds the "team:manage_rbac" permission.',
    'Only the team owner can change who holds the "team:manage_sso" permission.',
    "Only owners and admins can widen a role's permissions. You can review permissions and " +
      'remove grants, but not add an allow.',
  ])('renders the authored gate-4/gate-5 refusal verbatim: %s', async (message) => {
    respondWith({ data: null, error: { code: '42501', message } })
    const result = await executeRbacManage(
      {
        action: 'set_role_permission',
        role: 'admin',
        permission: 'team:manage_sso',
        effect: 'allow',
      },
      mockContext
    )
    expect(result.success).toBe(false)
    // Structured — a live refusal must be indistinguishable from the stub's.
    expect(isPermissionDeniedError(result.error)).toBe(true)
    expect(permissionErrorText(result.error)).toBe(message)
  })

  // `rpcError()` is applied at five call sites; the cases above only exercise two of them
  // (`set_team_role_permission` and `get_effective_team_permissions`). This covers the RESET
  // call site with the exact refusal the gate-4 widening created there — clearing a
  // `team:manage_sso` row is now owner-only too — which renders as authored copy ONLY if
  // `resetRolePermission`'s own throw carries the SQLSTATE across, not just `setRolePermission`'s.
  it('carries the SQLSTATE across on the reset call site too, not only on set', async () => {
    const message = 'Only the team owner can change who holds the "team:manage_sso" permission.'
    respondWith({ data: null, error: { code: '42501', message } })
    const result = await executeRbacManage(
      { action: 'reset_role_permission', role: 'admin', permission: 'team:manage_sso' },
      mockContext
    )
    expect(calls.map((c) => c.fn)).toEqual(['reset_team_role_permission'])
    expect(result.success).toBe(false)
    expect(isPermissionDeniedError(result.error)).toBe(true)
    expect(permissionErrorText(result.error)).toBe(message)
  })

  it('never leaks a raw Postgres 42501 that names internal schema objects', async () => {
    respondWith({
      data: null,
      error: { code: '42501', message: 'permission denied for table team_permission_grants' },
    })
    const result = await executeRbacManage({ action: 'list_roles' }, mockContext)
    expect(result.success).toBe(false)
    expect(isPermissionDeniedError(result.error)).toBe(true)
    const text = permissionErrorText(result.error)
    expect(text).not.toContain('team_permission_grants')
    expect(text).toContain('team:manage_rbac')
  })

  it('leaves a typed 22023 input refusal as a plain string, not a permission denial', async () => {
    respondWith({
      data: null,
      error: { code: '22023', message: 'effect must be allow or deny (got bogus)' },
    })
    const result = await executeRbacManage(
      {
        action: 'set_role_permission',
        role: 'admin',
        permission: 'registry:approve',
        effect: 'allow',
      },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(isPermissionDeniedError(result.error)).toBe(false)
    expect(result.error).toContain('effect must be allow or deny')
  })

  it('does not mislabel a transport/auth outage as a permission denial', async () => {
    respondWith({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } })
    const result = await executeRbacManage({ action: 'list_roles' }, mockContext)
    expect(result.success).toBe(false)
    expect(isPermissionDeniedError(result.error)).toBe(false)
    expect(result.error).toContain('JWT expired')
  })

  it('treats a null reset result as an error rather than silently reporting "no override"', async () => {
    respondWith({ data: null, error: null })
    const result = await executeRbacManage(
      { action: 'reset_role_permission', role: 'admin', permission: 'registry:approve' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(isPermissionDeniedError(result.error)).toBe(false)
    expect(result.error).toContain('returned no value')
  })
})
