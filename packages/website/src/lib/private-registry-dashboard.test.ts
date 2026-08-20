import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  badgeForRegistryVersion,
  groupRegistryVersions,
  loadRegistryDashboardData,
  reviewRegistrySubmission,
  setRegistryVersionDeprecated,
  type PrivateRegistryDashboardRow,
} from './private-registry-dashboard'

function registryRow(
  skillId: string,
  version: string,
  overrides: Partial<PrivateRegistryDashboardRow> = {}
): PrivateRegistryDashboardRow {
  return {
    skill_id: skillId,
    version,
    description: null,
    approval_status: 'approved',
    deprecated: false,
    published_by: '00000000-0000-0000-0000-000000000001',
    published_at: '2026-08-19T12:00:00.000Z',
    ...overrides,
  }
}

describe('groupRegistryVersions', () => {
  it('groups multiple versions of the same skill together', () => {
    const rows = [
      registryRow('acme/code-review', '1.0.0'),
      registryRow('acme/code-review', '1.1.0'),
      registryRow('acme/release-notes', '2.0.0'),
    ]

    expect(groupRegistryVersions(rows)).toEqual([
      {
        skillId: 'acme/code-review',
        versions: [rows[0], rows[1]],
      },
      {
        skillId: 'acme/release-notes',
        versions: [rows[2]],
      },
    ])
  })

  it('returns an empty list for no registry rows', () => {
    expect(groupRegistryVersions([])).toEqual([])
  })
})

describe('badgeForRegistryVersion', () => {
  it('badges a deprecated approved version distinctly from a non-deprecated one', () => {
    expect(badgeForRegistryVersion('approved', false)).toEqual({
      label: 'Approved',
      className: 'status-approved',
    })
    expect(badgeForRegistryVersion('approved', true)).toEqual({
      label: 'Deprecated',
      className: 'status-deprecated',
    })
  })

  it.each([
    ['pending', 'Pending', 'status-pending'],
    ['approved', 'Approved', 'status-approved'],
    ['rejected', 'Rejected', 'status-rejected'],
  ])('maps %s to the expected badge', (status, label, className) => {
    expect(badgeForRegistryVersion(status, false)).toEqual({
      label,
      className,
    })
  })
})

/**
 * Mock SupabaseClient covering the two query shapes the dashboard uses
 * (chained .from() builders and .rpc()), same idiom as team-access.test.ts.
 * Every builder method call is recorded so tests can pin the read-path
 * invariant: pending/rejected via RPC, approved via RLS-scoped select.
 */
interface MockResult {
  data: unknown
  error: { message: string } | null
}

interface RecordedCall {
  method: string
  args: unknown[]
}

function chainableBuilder(result: MockResult, calls: RecordedCall[]) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'update', 'eq', 'order']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return builder
    }
  }
  builder.single = () => {
    calls.push({ method: 'single', args: [] })
    return Promise.resolve(result)
  }
  builder.then = (
    onFulfilled: (value: MockResult) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(onFulfilled, onRejected)
  return builder
}

function mockRegistryClient(results: {
  teams?: MockResult
  registry?: MockResult
  rpc?: (fn: string, args: Record<string, unknown>) => MockResult
}) {
  const tableCalls: Record<string, RecordedCall[]> = {}
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []

  const client = {
    from(table: string) {
      tableCalls[table] = tableCalls[table] ?? []
      const result =
        table === 'teams'
          ? (results.teams ?? { data: null, error: null })
          : (results.registry ?? { data: [], error: null })
      return chainableBuilder(result, tableCalls[table])
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args })
      return Promise.resolve(results.rpc?.(fn, args) ?? { data: [], error: null })
    },
  }

  return { client: client as unknown as SupabaseClient, tableCalls, rpcCalls }
}

describe('loadRegistryDashboardData (read-path invariant, plan P-5)', () => {
  it('reads pending and rejected ONLY via get_private_registry_submissions, approved ONLY via the RLS-scoped select', async () => {
    const pendingRow = registryRow('acme/pending-skill', '0.1.0', { approval_status: 'pending' })
    const rejectedRow = registryRow('acme/rejected-skill', '0.2.0', {
      approval_status: 'rejected',
    })
    const approvedRow = registryRow('acme/approved-skill', '1.0.0')

    const { client, tableCalls, rpcCalls } = mockRegistryClient({
      teams: { data: { skill_namespace: 'acme' }, error: null },
      registry: { data: [approvedRow], error: null },
      rpc: (_fn, args) => ({
        data: args.p_status === 'pending' ? [pendingRow] : [rejectedRow],
        error: null,
      }),
    })

    const result = await loadRegistryDashboardData(client, 'team_1')

    // Pending/rejected: exactly two RPC calls, both to the submissions RPC.
    expect(rpcCalls).toEqual([
      {
        fn: 'get_private_registry_submissions',
        args: { p_team_id: 'team_1', p_status: 'pending' },
      },
      {
        fn: 'get_private_registry_submissions',
        args: { p_team_id: 'team_1', p_status: 'rejected' },
      },
    ])

    // Approved: a plain select on private_registry_skills, explicitly
    // scoped to approval_status='approved' (matching what RLS exposes).
    const registryCalls = tableCalls['private_registry_skills'] ?? []
    expect(registryCalls.some((c) => c.method === 'select')).toBe(true)
    expect(registryCalls).toContainEqual({
      method: 'eq',
      args: ['approval_status', 'approved'],
    })
    expect(registryCalls.some((c) => c.method === 'update')).toBe(false)

    expect(result).toEqual({
      namespace: 'acme',
      approved: [approvedRow],
      pending: [pendingRow],
      rejected: [rejectedRow],
    })
  })

  it('maps a missing namespace to the empty string', async () => {
    const { client } = mockRegistryClient({
      teams: { data: { skill_namespace: null }, error: null },
    })

    const result = await loadRegistryDashboardData(client, 'team_1')
    expect(result.namespace).toBe('')
    expect(result.approved).toEqual([])
  })

  it('throws when the submissions RPC errors instead of silently blanking the queue', async () => {
    const { client } = mockRegistryClient({
      teams: { data: { skill_namespace: 'acme' }, error: null },
      rpc: () => ({ data: null, error: { message: 'submissions unavailable' } }),
    })

    await expect(loadRegistryDashboardData(client, 'team_1')).rejects.toThrow(
      'submissions unavailable'
    )
  })
})

describe('reviewRegistrySubmission', () => {
  it('calls review_private_registry_submission with the exact RPC parameter names', async () => {
    const { client, rpcCalls } = mockRegistryClient({
      rpc: () => ({ data: [], error: null }),
    })

    await reviewRegistrySubmission(client, 'team_1', 'acme/skill', '1.0.0', 'rejected', 'nope')

    expect(rpcCalls).toEqual([
      {
        fn: 'review_private_registry_submission',
        args: {
          p_team_id: 'team_1',
          p_skill_id: 'acme/skill',
          p_version: '1.0.0',
          p_decision: 'rejected',
          p_note: 'nope',
        },
      },
    ])
  })

  it('surfaces server-side refusals (e.g. self-approval) as thrown errors', async () => {
    const { client } = mockRegistryClient({
      rpc: () => ({ data: null, error: { message: 'submitter cannot review their own' } }),
    })

    await expect(
      reviewRegistrySubmission(client, 'team_1', 'acme/skill', '1.0.0', 'approved', null)
    ).rejects.toThrow('submitter cannot review their own')
  })
})

describe('setRegistryVersionDeprecated', () => {
  it('updates only the deprecated column, fully scoped, and calls the load-bearing .select()', async () => {
    const { client, tableCalls } = mockRegistryClient({
      registry: { data: [registryRow('acme/skill', '1.0.0', { deprecated: true })], error: null },
    })

    await setRegistryVersionDeprecated(client, 'team_1', 'acme/skill', '1.0.0', true)

    const calls = tableCalls['private_registry_skills'] ?? []
    expect(calls).toContainEqual({ method: 'update', args: [{ deprecated: true }] })
    expect(calls).toContainEqual({ method: 'eq', args: ['team_id', 'team_1'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['skill_id', 'acme/skill'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['version', '1.0.0'] })
    // Without .select(), Supabase reports success with null data even when
    // RLS matched zero rows — the next assertion's zero-row test depends on it.
    expect(calls.some((c) => c.method === 'select')).toBe(true)
  })

  it('throws when RLS filtered the update to zero rows (non-admin silent no-op)', async () => {
    const { client } = mockRegistryClient({
      registry: { data: [], error: null },
    })

    await expect(
      setRegistryVersionDeprecated(client, 'team_1', 'acme/skill', '1.0.0', true)
    ).rejects.toThrow('The skill version could not be updated.')
  })
})
