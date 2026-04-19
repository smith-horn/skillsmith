/**
 * @fileoverview Live-mode tests for team_workspace + share_skill MCP tools
 * @see SMI-4312: service-role client post-resolution + cross-team hardening
 *
 * Kept in a sidecar so team-workspace.test.ts stays under the 500-line CI limit.
 * Exercises the live Supabase-backed service by mocking `getSupabaseAdminClient`
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
  getSupabaseAdminClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

vi.mock('./team-resolver.js', () => ({
  readLicenseKey: vi.fn(() => 'sk_test_fake_license'),
  resolveLicenseTeamId: vi.fn(async () => 'team-alpha'),
}))

// ============================================================================
// Fake Supabase client (recorder + scripted responses)
// ============================================================================

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'delete'
  filters: Array<{ column: string; value: unknown }>
  payload?: Record<string, unknown>
}

type SingleResponder = () => { data: unknown; error: { message?: string } | null }
type ThenResponder = () => { data: unknown[] | null; error: { message?: string } | null }

interface FakeClientOptions {
  singleResponder?: SingleResponder
  thenResponder?: ThenResponder
}

function createFakeClient(opts: FakeClientOptions = {}): {
  client: unknown
  calls: Recorded[]
} {
  const calls: Recorded[] = []

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
        return (
          opts.singleResponder?.() ?? {
            data: null,
            error: null,
          }
        )
      },
      then: (onFulfilled: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
        const resp = opts.thenResponder?.() ?? { data: [], error: null }
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

// ============================================================================
// Shared setup
// ============================================================================

beforeEach(() => {
  // Install the live service so handlers hit the mocked admin client.
  setTeamWorkspaceService(createLiveService())
})

afterEach(() => {
  // Restore stub so unrelated tests start clean if the file grows.
  setTeamWorkspaceService(createStubService())
  vi.clearAllMocks()
})

// ============================================================================
// Tests — admin client is used post license resolution
// ============================================================================

describe('team-workspace live mode — SMI-4312', () => {
  it('listWorkspaces calls the admin (service-role) client with team_id filter', async () => {
    const { client, calls } = createFakeClient({
      thenResponder: () => ({ data: [], error: null }),
    })
    const { getSupabaseAdminClient, getSupabaseClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executeTeamWorkspace({ action: 'list' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    expect(getSupabaseAdminClient).toHaveBeenCalled()
    // The anon-key client must NOT be used for CRUD in live mode.
    expect(getSupabaseClient).not.toHaveBeenCalled()

    // team_id filter must be applied on the query.
    const q = calls.find((c) => c.table === 'team_workspaces')
    expect(q).toBeDefined()
    expect(q!.filters.some((f) => f.column === 'team_id' && f.value === 'team-alpha')).toBe(true)
  })

  it('createWorkspace inserts with team_id from the resolved license', async () => {
    const { client, calls } = createFakeClient({
      singleResponder: () => ({
        data: {
          id: 'ws-new',
          team_id: 'team-alpha',
          name: 'New WS',
          description: null,
          settings: null,
          created_by: null,
          created_at: '2026-04-19T00:00:00Z',
          updated_at: '2026-04-19T00:00:00Z',
        },
        error: null,
      }),
    })
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executeTeamWorkspace({ action: 'create', name: 'New WS' }, makeContext())

    expect(result.success).toBe(true)
    expect(result.workspace?.teamId).toBe('team-alpha')
    const insertCall = calls.find((c) => c.op === 'insert')
    expect(insertCall).toBeDefined()
    expect(insertCall!.payload?.team_id).toBe('team-alpha')
  })

  it('surfaces a typed error when SUPABASE_SERVICE_ROLE_KEY is not configured', async () => {
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockRejectedValueOnce(
      new Error('Supabase admin not configured: SUPABASE_SERVICE_ROLE_KEY required')
    )

    const result = await executeTeamWorkspace({ action: 'list' }, makeContext())

    expect(result.success).toBe(false)
    expect(result.dataSource).toBe('live')
    expect(result.error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
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
      singleResponder: () => ({
        data: null,
        error: { message: 'No rows found' },
      }),
      thenResponder: () => ({ data: [], error: null }),
    })
  }

  it('share_skill add rejects a workspaceId that does not belong to the resolved team', async () => {
    const { client } = foreignWorkspaceFake()
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

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
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executeShareSkill(
      { action: 'list', workspaceId: foreignWorkspaceId },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found in team/i)
  })

  it('share_skill remove rejects a cross-team workspaceId', async () => {
    const { client } = foreignWorkspaceFake()
    const { getSupabaseAdminClient } = await import('../supabase-client.js')
    vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)

    const result = await executeShareSkill(
      { action: 'remove', workspaceId: foreignWorkspaceId, skillId: 'author/name' },
      makeContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found in team/i)
  })
})
