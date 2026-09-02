/**
 * @fileoverview Live-mode tests for team_workspace + share_skill MCP tools
 * @see SMI-4312: original service-role client post-resolution + cross-team hardening
 * @see SMI-6113 + SMI-6241 Wave 2: moved off the service-role client onto the caller's own JWT via
 *   `team-workspace.live.auth.ts`'s two named getters — this file's fakes now stand in for
 *   `getSupabaseUserClient`/`resolveUserAccessToken`, not `getSupabaseAdminClient`, matching the
 *   convention `registry-tools.live.test.ts` already uses for its own JWT-bound methods.
 *
 * Kept in a sidecar so team-workspace.test.ts stays under the 500-line CI limit.
 * Exercises the live Supabase-backed service by mocking `getSupabaseUserClient`
 * with a recording fake client.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { ToolContext } from '../context.js'

// Live service and handlers: imported AFTER the vi.mock block below so that
// the module under test sees the mocked supabase-client exports.
import {
  executeTeamWorkspace,
  executeShareSkill,
  setTeamWorkspaceService,
  createStubService,
} from './team-workspace.js'
import { createLiveService } from './team-workspace.live.js'

vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveLicenseTeamId: vi.fn(async () => 'team-alpha'),
  resolveUserAccessToken: vi.fn(async () => 'fake-user-access-token'),
}))

// ============================================================================
// Fake Supabase client (recorder + queued scripted responses)
// ============================================================================

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'delete'
  filters: Array<{ column: string; value: unknown }>
  payload?: Record<string, unknown>
}

type SingleResponder = () => { data: unknown; error: { message?: string; code?: string } | null }
type ThenResponder = () => {
  data: unknown[] | null
  error: { message?: string; code?: string } | null
}

interface FakeClientOptions {
  /** Consumed in call order across every `.single()` resolution. Last entry repeats once exhausted. */
  singleResponders?: SingleResponder[]
  /** Consumed in call order across every array (`.then()`) resolution. Last entry repeats once exhausted. */
  thenResponders?: ThenResponder[]
}

function createFakeClient(opts: FakeClientOptions = {}): {
  client: unknown
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  let singleIndex = 0
  let thenIndex = 0

  function makeQuery(table: string, op: 'select' | 'insert' | 'delete') {
    const record: Recorded = { table, op, filters: [] }
    calls.push(record)
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        record.filters.push({ column, value })
        return chain
      },
      insert: (row: Record<string, unknown>) => {
        record.op = 'insert'
        record.payload = row
        return chain
      },
      delete: () => {
        record.op = 'delete'
        return chain
      },
      single: async () => {
        const responders = opts.singleResponders ?? []
        const fn = responders[Math.min(singleIndex, responders.length - 1)]
        singleIndex++
        return fn ? fn() : { data: null, error: null }
      },
      then: (onFulfilled: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
        const responders = opts.thenResponders ?? []
        const fn = responders[Math.min(thenIndex, responders.length - 1)]
        thenIndex++
        const resp = fn ? fn() : { data: [], error: null }
        return Promise.resolve(onFulfilled(resp))
      },
    }
    return chain
  }

  const client = {
    from: (table: string) => makeQuery(table, 'select'),
  }
  return { client, calls }
}

function makeContext(): ToolContext {
  return {} as unknown as ToolContext
}

async function mockUserClient(client: unknown): Promise<void> {
  const { getSupabaseUserClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseUserClient).mockResolvedValue(client)
}

// ============================================================================
// Shared setup
// ============================================================================

beforeEach(() => {
  // Install the live service so handlers hit the mocked user client.
  setTeamWorkspaceService(createLiveService())
})

afterEach(() => {
  // Restore stub so unrelated tests start clean if the file grows.
  setTeamWorkspaceService(createStubService())
  vi.clearAllMocks()
})

// ============================================================================
// Tests — membership-gated methods route through the caller's own JWT
// ============================================================================

describe('team-workspace live mode — membership-gated methods — SMI-6113/SMI-6241', () => {
  it('listWorkspaces calls the signed-in user client with a team_id filter', async () => {
    const { client, calls } = createFakeClient({
      thenResponders: [() => ({ data: [], error: null })],
    })
    await mockUserClient(client)
    const { getSupabaseClient } = await import('../supabase-client.js')

    const result = await executeTeamWorkspace({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    // The anon-key client must NOT be used for CRUD in live mode.
    expect(getSupabaseClient).not.toHaveBeenCalled()

    const q = calls.find((c) => c.table === 'team_workspaces')
    expect(q).toBeDefined()
    expect(q!.filters.some((f) => f.column === 'team_id' && f.value === 'team-alpha')).toBe(true)
  })

  it('getWorkspace returns the workspace for a plain member', async () => {
    const { client } = createFakeClient({
      singleResponders: [
        () => ({
          data: {
            id: 'ws-1',
            team_id: 'team-alpha',
            name: 'WS',
            description: null,
            settings: null,
            created_by: null,
            created_at: '2026-09-02T00:00:00Z',
            updated_at: '2026-09-02T00:00:00Z',
          },
          error: null,
        }),
      ],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace(
      { action: 'get', workspaceId: '00000000-0000-0000-0000-000000000001' },
      makeContext()
    )

    expect(result.success).toBe(true)
    expect(result.workspace?.id).toBe('ws-1')
  })

  it('getWorkspace surfaces a genuine query failure as a clear thrown error, not a fabricated "not found"', async () => {
    const { client } = createFakeClient({
      singleResponders: [() => ({ data: null, error: { message: 'connection reset' } })],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace(
      { action: 'get', workspaceId: '00000000-0000-0000-0000-000000000001' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Failed to look up workspace: connection reset/)
    expect(result.error).not.toMatch(/not found/i)
  })

  it('listWorkspaces surfaces a query failure as a clear thrown error', async () => {
    const { client } = createFakeClient({
      thenResponders: [() => ({ data: null, error: { message: 'connection reset' } })],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Failed to list workspaces: connection reset/)
  })

  it('surfaces a clear error when the license key does not resolve to a team', async () => {
    const { resolveLicenseTeamId } = await import('./team-resolver.js')
    vi.mocked(resolveLicenseTeamId).mockResolvedValueOnce(null)

    const result = await executeTeamWorkspace({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Unable to resolve team/)
  })

  it('a member without a signed-in session gets a clear login-required error, not a raw failure', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)

    const result = await executeTeamWorkspace({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.dataSource).toBe('live')
    expect(result.error).toMatch(/skillsmith login/)
    // Reads as membership-only, not admin-gated — it may still name workspace:manage to say it's
    // NOT required (plan-review finding H5's inaccuracy to avoid), so assert the actual phrasing.
    expect(result.error).toMatch(/does not require the "workspace:manage" permission/)
    expect(result.error).not.toMatch(/team admins/)
  })

  it('addSkill / removeSkill / listSkills / getWorkspaceSettings all succeed for a plain member (no workspace:manage needed)', async () => {
    const workspaceRow = {
      id: 'ws-1',
      team_id: 'team-alpha',
      name: 'WS',
      description: null,
      settings: null,
      created_by: null,
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
    }

    // 'add' handler order: getWorkspaceSettings's own fetchTeamScopedWorkspace probe (.single()),
    // then addSkill's assertWorkspaceInTeam probe (.single()), then the insert itself (.single()).
    const addFake = createFakeClient({
      singleResponders: [
        () => ({ data: workspaceRow, error: null }),
        () => ({ data: workspaceRow, error: null }),
        () => ({
          data: { workspace_id: 'ws-1', skill_id: 'author/name', added_by: null, added_at: 'now' },
          error: null,
        }),
      ],
    })
    await mockUserClient(addFake.client)
    const addResult = await executeShareSkill(
      {
        action: 'add',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        skillId: 'author/name',
      },
      makeContext()
    )
    expect(addResult.success).toBe(true)

    // removeSkill: assertWorkspaceInTeam's probe (.single()), then delete+.select() affecting 1 row.
    const removeFake = createFakeClient({
      singleResponders: [() => ({ data: workspaceRow, error: null })],
      thenResponders: [
        () => ({ data: [{ workspace_id: 'ws-1', skill_id: 'author/name' }], error: null }),
      ],
    })
    await mockUserClient(removeFake.client)
    const removeResult = await executeShareSkill(
      {
        action: 'remove',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        skillId: 'author/name',
      },
      makeContext()
    )
    expect(removeResult.success).toBe(true)

    // listSkills: assertWorkspaceInTeam's probe (.single()), then the array read.
    const listFake = createFakeClient({
      singleResponders: [() => ({ data: workspaceRow, error: null })],
      thenResponders: [() => ({ data: [], error: null })],
    })
    await mockUserClient(listFake.client)
    const listResult = await executeShareSkill(
      { action: 'list', workspaceId: '00000000-0000-0000-0000-000000000001' },
      makeContext()
    )
    expect(listResult.success).toBe(true)

    // getWorkspaceSettings is reached indirectly via share_skill add's sharing-policy check above,
    // which already exercised fetchTeamScopedWorkspace on the member getter — no separate call needed.
  })

  it('share_skill add fails CLOSED (not silently past the sharing policy) when the settings read itself fails', async () => {
    // Round-2 adversarial-review regression test: fetchTeamScopedWorkspace() used to collapse
    // EVERY error to null, so getWorkspaceSettings() would return `{}` (no sharing policy) on a
    // transient query failure, letting share_skill add silently bypass a workspace's denyList.
    // A non-PGRST116 error must now propagate as a thrown error instead.
    const { client } = createFakeClient({
      singleResponders: [() => ({ data: null, error: { message: 'connection reset' } })],
    })
    await mockUserClient(client)

    const result = await executeShareSkill(
      {
        action: 'add',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        skillId: 'author/name',
      },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Failed to look up workspace: connection reset/)
  })

  it('addSkill surfaces an insert failure as a clear thrown error', async () => {
    const workspaceRow = {
      id: 'ws-1',
      team_id: 'team-alpha',
      name: 'WS',
      description: null,
      settings: null,
      created_by: null,
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
    }
    const { client } = createFakeClient({
      singleResponders: [
        () => ({ data: workspaceRow, error: null }), // getWorkspaceSettings's probe
        () => ({ data: workspaceRow, error: null }), // addSkill's assertWorkspaceInTeam probe
        () => ({ data: null, error: { message: 'duplicate key value' } }), // insert fails
      ],
    })
    await mockUserClient(client)

    const result = await executeShareSkill(
      {
        action: 'add',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        skillId: 'author/name',
      },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Failed to add skill: duplicate key value/)
  })

  it('removeSkill surfaces the delete-error path as a clear thrown error, not a fabricated false', async () => {
    const workspaceRow = {
      id: 'ws-1',
      team_id: 'team-alpha',
      name: 'WS',
      description: null,
      settings: null,
      created_by: null,
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
    }
    const { client } = createFakeClient({
      singleResponders: [() => ({ data: workspaceRow, error: null })],
      thenResponders: [() => ({ data: null, error: { message: 'connection reset' } })],
    })
    await mockUserClient(client)

    const result = await executeShareSkill(
      {
        action: 'remove',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        skillId: 'author/name',
      },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Failed to remove skill: connection reset/)
  })

  it('removeSkill throws (not a fabricated success/false) when the probe itself fails after a zero-row delete', async () => {
    const workspaceRow = {
      id: 'ws-1',
      team_id: 'team-alpha',
      name: 'WS',
      description: null,
      settings: null,
      created_by: null,
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
    }
    const { client } = createFakeClient({
      singleResponders: [() => ({ data: workspaceRow, error: null })],
      thenResponders: [
        () => ({ data: [], error: null }), // delete: 0 rows, no error
        () => ({ data: null, error: { message: 'token expired' } }), // probe fails too
      ],
    })
    await mockUserClient(client)

    const result = await executeShareSkill(
      {
        action: 'remove',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        skillId: 'author/name',
      },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cannot tell whether it was already removed or you lost access/)
  })

  it('removeSkill throws a clear membership-lost error (not a fabricated success) when the probe finds the row after a zero-row delete', async () => {
    const workspaceRow = {
      id: 'ws-1',
      team_id: 'team-alpha',
      name: 'WS',
      description: null,
      settings: null,
      created_by: null,
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
    }
    const { client } = createFakeClient({
      singleResponders: [() => ({ data: workspaceRow, error: null })],
      thenResponders: [
        () => ({ data: [], error: null }), // delete: 0 rows, no error
        () => ({ data: [{ workspace_id: 'ws-1' }], error: null }), // probe: row IS there
      ],
    })
    await mockUserClient(client)

    const result = await executeShareSkill(
      {
        action: 'remove',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        skillId: 'author/name',
      },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/you may no longer be a member of this team/)
  })

  it('removeSkill reports "not found" when both the delete and the probe find no matching row', async () => {
    const workspaceRow = {
      id: 'ws-1',
      team_id: 'team-alpha',
      name: 'WS',
      description: null,
      settings: null,
      created_by: null,
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
    }
    const { client } = createFakeClient({
      singleResponders: [() => ({ data: workspaceRow, error: null })],
      thenResponders: [() => ({ data: [], error: null }), () => ({ data: [], error: null })],
    })
    await mockUserClient(client)

    const result = await executeShareSkill(
      {
        action: 'remove',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        skillId: 'author/name',
      },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found in workspace/i)
  })

  it('listSkills surfaces a query failure as a clear thrown error', async () => {
    const workspaceRow = {
      id: 'ws-1',
      team_id: 'team-alpha',
      name: 'WS',
      description: null,
      settings: null,
      created_by: null,
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
    }
    const { client } = createFakeClient({
      singleResponders: [() => ({ data: workspaceRow, error: null })],
      thenResponders: [() => ({ data: null, error: { message: 'connection reset' } })],
    })
    await mockUserClient(client)

    const result = await executeShareSkill(
      { action: 'list', workspaceId: '00000000-0000-0000-0000-000000000001' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Failed to list skills: connection reset/)
  })
})

// ============================================================================
// Tests — workspace:manage-gated methods (create/delete), SMI-6113/SMI-6241
// ============================================================================

describe('team-workspace live mode — workspace:manage-gated methods — SMI-6113/SMI-6241', () => {
  it('createWorkspace inserts with team_id from the resolved license when the caller has workspace:manage', async () => {
    const { client, calls } = createFakeClient({
      singleResponders: [
        () => ({
          data: {
            id: 'ws-new',
            team_id: 'team-alpha',
            name: 'New WS',
            description: null,
            settings: null,
            created_by: null,
            created_at: '2026-09-02T00:00:00Z',
            updated_at: '2026-09-02T00:00:00Z',
          },
          error: null,
        }),
      ],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace({ action: 'create', name: 'New WS' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.workspace?.teamId).toBe('team-alpha')
    const insertCall = calls.find((c) => c.op === 'insert')
    expect(insertCall).toBeDefined()
    expect(insertCall!.payload?.team_id).toBe('team-alpha')
  })

  it('createWorkspace surfaces a clear workspace:manage permission error on an RLS WITH CHECK denial, not the raw Postgres text', async () => {
    const { client } = createFakeClient({
      singleResponders: [
        () => ({
          data: null,
          error: {
            code: '42501',
            message: 'new row violates row-level security policy for table "team_workspaces"',
          },
        }),
      ],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace({ action: 'create', name: 'New WS' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/workspace:manage/)
    expect(result.error).not.toMatch(/row-level security policy/)
  })

  it('createWorkspace recognizes an RLS denial by message text alone, when no error code is present', async () => {
    const { client } = createFakeClient({
      singleResponders: [
        () => ({
          data: null,
          error: { message: 'new row violates row-level security policy for table "x"' },
        }),
      ],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace({ action: 'create', name: 'New WS' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/workspace:manage/)
  })

  it('createWorkspace falls back to the generic error message for a non-RLS failure', async () => {
    const { client } = createFakeClient({
      singleResponders: [() => ({ data: null, error: null })],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace({ action: 'create', name: 'New WS' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toBe('Failed to create workspace: unknown error')
  })

  it('deleteWorkspace succeeds when the delete affects a row (admin caller)', async () => {
    const { client } = createFakeClient({
      thenResponders: [() => ({ data: [{ id: 'ws-1' }], error: null })],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace(
      { action: 'delete', workspaceId: '00000000-0000-0000-0000-000000000001' },
      makeContext()
    )

    expect(result.success).toBe(true)
  })

  it('deleteWorkspace throws a clear workspace:manage permission error — not a fabricated success — when RLS silently denies the delete but the row exists', async () => {
    const { client } = createFakeClient({
      thenResponders: [
        // 1) DELETE ... .select() — RLS denies, so 0 rows affected, no error.
        () => ({ data: [], error: null }),
        // 2) probe SELECT via team_workspaces_member_read — the row IS visible to this member.
        () => ({ data: [{ id: 'ws-1' }], error: null }),
      ],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace(
      { action: 'delete', workspaceId: '00000000-0000-0000-0000-000000000001' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/workspace:manage/)
    expect(result.error).not.toMatch(/not found/i)
  })

  it('deleteWorkspace surfaces a direct delete-query failure as a clear thrown error', async () => {
    const { client } = createFakeClient({
      thenResponders: [() => ({ data: null, error: { message: 'connection reset' } })],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace(
      { action: 'delete', workspaceId: '00000000-0000-0000-0000-000000000001' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Failed to delete workspace: connection reset/)
  })

  it('deleteWorkspace throws (not a fabricated success/false) when the probe itself fails after a zero-row delete', async () => {
    const { client } = createFakeClient({
      thenResponders: [
        () => ({ data: [], error: null }), // delete: 0 rows, no error
        () => ({ data: null, error: { message: 'token expired' } }), // probe fails too
      ],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace(
      { action: 'delete', workspaceId: '00000000-0000-0000-0000-000000000001' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cannot tell whether it is missing or you lack/)
  })

  it('deleteWorkspace reports "not found" (not a permission error) when the probe also finds nothing', async () => {
    const { client } = createFakeClient({
      thenResponders: [() => ({ data: [], error: null }), () => ({ data: [], error: null })],
    })
    await mockUserClient(client)

    const result = await executeTeamWorkspace(
      { action: 'delete', workspaceId: '00000000-0000-0000-0000-000000000001' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(result.error).not.toMatch(/workspace:manage/)
  })

  it('a member without a signed-in session gets a clear login-required error attempting create, naming workspace:manage', async () => {
    const { resolveUserAccessToken } = await import('./team-resolver.js')
    vi.mocked(resolveUserAccessToken).mockResolvedValueOnce(null)

    const result = await executeTeamWorkspace({ action: 'create', name: 'New WS' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/workspace:manage/)
    expect(result.error).toMatch(/skillsmith login/)
  })
})

// ============================================================================
// Tests — cross-team workspace access hardening
// ============================================================================

describe('share_skill live mode — cross-team hardening — SMI-4312', () => {
  const foreignWorkspaceId = '00000000-0000-0000-0000-0000000000ff'

  /**
   * Fake that returns "no row" whenever the team_workspaces SELECT is
   * team-scoped — i.e. the caller tried to access a workspace owned by
   * a different team. This is the cross-team attack shape.
   */
  function foreignWorkspaceFake() {
    return createFakeClient({
      // Realistic shape: a team-scoped .single() against a cross-team id is PostgREST's genuine
      // no-rows code (PGRST116), not an arbitrary message — fetchTeamScopedWorkspace() only
      // collapses THIS code to null; any other error now throws (round-2 adversarial-review fix).
      singleResponders: [
        () => ({
          data: null,
          error: {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
          },
        }),
      ],
      thenResponders: [() => ({ data: [], error: null })],
    })
  }

  it('share_skill add rejects a workspaceId that does not belong to the resolved team', async () => {
    const { client } = foreignWorkspaceFake()
    await mockUserClient(client)

    const result = await executeShareSkill(
      { action: 'add', workspaceId: foreignWorkspaceId, skillId: 'author/name' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.dataSource).toBe('live')
    expect(result.error).toMatch(/not found in team/i)
  })

  it('share_skill list rejects a cross-team workspaceId', async () => {
    const { client } = foreignWorkspaceFake()
    await mockUserClient(client)

    const result = await executeShareSkill(
      { action: 'list', workspaceId: foreignWorkspaceId },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found in team/i)
  })

  it('share_skill remove rejects a cross-team workspaceId', async () => {
    const { client } = foreignWorkspaceFake()
    await mockUserClient(client)

    const result = await executeShareSkill(
      { action: 'remove', workspaceId: foreignWorkspaceId, skillId: 'author/name' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found in team/i)
  })
})
