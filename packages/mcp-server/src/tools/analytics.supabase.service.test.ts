/**
 * @fileoverview Tests for SupabaseAnalyticsService — cloud read path
 * @see SMI-5015: W1.S3 — MCP read path for skill-invoke analytics RPCs
 *
 * All tests mock the Supabase client — no real database connection.
 * Mocking style matches integration-tools.service.test.ts: manual mock
 * object passed to the factory; `vi.fn()` for each method.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SupabaseAnalyticsService } from './analytics.supabase.service.js'

// ============================================================================
// Supabase client mock
// ============================================================================

/**
 * Build a mock Supabase client whose `.rpc()` resolves with `resolvedValue`.
 * Returns both the mock client object and the `rpc` spy so callers can assert
 * which RPC was called and with which params.
 */
function createMockSupabase(resolvedValue: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(resolvedValue)
  const client = { rpc } as unknown as { rpc: typeof rpc }
  return { client, rpc }
}

// ============================================================================
// supabase-client module mock — swapped per-test via mock factory
// ============================================================================

// We need to intercept `getSupabaseClient()` to avoid real env-var lookups.
// The house style (integration-tools tests) injects the client directly.
// Here we patch the module so `getSupabaseClient` returns our mock.

vi.mock('../supabase-client.js', () => ({
  getSupabaseClient: vi.fn(),
}))

import { getSupabaseClient } from '../supabase-client.js'

const mockGetClient = vi.mocked(getSupabaseClient)

const TEAM_ID = 'team-uuid-001'

// ============================================================================
// getTopSkills
// ============================================================================

describe('SupabaseAnalyticsService.getTopSkills', () => {
  let svc: SupabaseAnalyticsService

  beforeEach(() => {
    svc = new SupabaseAnalyticsService()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls analytics_skill_top with correct params for 7d window', async () => {
    const { client, rpc } = createMockSupabase({ data: [], error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    await svc.getTopSkills({ teamId: TEAM_ID, window: '7d' })

    expect(rpc).toHaveBeenCalledWith('analytics_skill_top', {
      p_team_id: TEAM_ID,
      p_window_days: 7,
    })
  })

  it('calls analytics_skill_top with 30 days for 30d window', async () => {
    const { client, rpc } = createMockSupabase({ data: [], error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    await svc.getTopSkills({ teamId: TEAM_ID, window: '30d' })

    expect(rpc).toHaveBeenCalledWith('analytics_skill_top', {
      p_team_id: TEAM_ID,
      p_window_days: 30,
    })
  })

  it('returns topSkills panel shape on success', async () => {
    const rpcRow = {
      skill_name: 'skillsmith/linear',
      invocation_count: 42,
      distinct_developers: 3,
      week_over_week_delta: 0.15,
      framework_breakdown: { 'claude-code': 35, unknown: 7 },
    }
    const { client } = createMockSupabase({ data: [rpcRow], error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getTopSkills({ teamId: TEAM_ID, window: '30d' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.panel).toBe('topSkills')
    expect(result.data.window).toBe('30d')
    expect(result.data.rows).toHaveLength(1)

    const row = result.data.rows[0]
    expect(row.skill_name).toBe('skillsmith/linear')
    expect(row.skill_id).toBe('skillsmith/linear')
    expect(row.invocation_count).toBe(42)
    expect(row.distinct_developers).toBe(3)
    expect(row.week_over_week_delta).toBeCloseTo(0.15)
    expect(row.framework_breakdown).toEqual({ 'claude-code': 35, unknown: 7 })
  })

  it('sets unattributed_count to count of rows with unknown framework key', async () => {
    const rows = [
      {
        skill_name: 'a/foo',
        invocation_count: 10,
        distinct_developers: 1,
        week_over_week_delta: null,
        framework_breakdown: { unknown: 5 },
      },
      {
        skill_name: 'a/bar',
        invocation_count: 8,
        distinct_developers: 2,
        week_over_week_delta: null,
        framework_breakdown: { 'claude-code': 8 },
      },
    ]
    const { client } = createMockSupabase({ data: rows, error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getTopSkills({ teamId: TEAM_ID, window: '30d' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.unattributed_count).toBe(1)
  })

  it('includes coverage_note in response', async () => {
    const { client } = createMockSupabase({ data: [], error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getTopSkills({ teamId: TEAM_ID, window: '30d' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.coverage_note).toContain('Claude Code')
    expect(result.data.coverage_note).toContain('Context-injection')
  })

  it('applies limit when provided', async () => {
    const rpcRows = Array.from({ length: 10 }, (_, i) => ({
      skill_name: `a/skill-${i}`,
      invocation_count: 10 - i,
      distinct_developers: 1,
      week_over_week_delta: null,
      framework_breakdown: {},
    }))
    const { client } = createMockSupabase({ data: rpcRows, error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getTopSkills({ teamId: TEAM_ID, window: '30d', limit: 3 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rows).toHaveLength(3)
  })

  it('returns error envelope on RPC error — does not throw', async () => {
    const { client } = createMockSupabase({ data: null, error: { message: 'permission denied' } })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getTopSkills({ teamId: TEAM_ID, window: '30d' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('analytics_skill_top')
    expect(result.error).toContain('permission denied')
  })

  it('returns error envelope when getSupabaseClient throws', async () => {
    mockGetClient.mockRejectedValue(new Error('Supabase not configured'))

    const result = await svc.getTopSkills({ teamId: TEAM_ID, window: '7d' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Supabase not configured')
  })

  it('handles null week_over_week_delta as null', async () => {
    const { client } = createMockSupabase({
      data: [
        {
          skill_name: 'a/new',
          invocation_count: 5,
          distinct_developers: 1,
          week_over_week_delta: null,
          framework_breakdown: {},
        },
      ],
      error: null,
    })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getTopSkills({ teamId: TEAM_ID, window: '7d' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rows[0].week_over_week_delta).toBeNull()
  })
})

// ============================================================================
// getStaleSkills
// ============================================================================

describe('SupabaseAnalyticsService.getStaleSkills', () => {
  let svc: SupabaseAnalyticsService

  beforeEach(() => {
    svc = new SupabaseAnalyticsService()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls analytics_skill_stale with correct params', async () => {
    const { client, rpc } = createMockSupabase({ data: [], error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    await svc.getStaleSkills({ teamId: TEAM_ID, thresholdInvocations: 5, windowDays: 90 })

    expect(rpc).toHaveBeenCalledWith('analytics_skill_stale', {
      p_team_id: TEAM_ID,
      p_window_days: 90,
      p_threshold: 5,
    })
  })

  it('returns staleSkills panel shape on success', async () => {
    const rpcRow = {
      skill_name: 'skillsmith/outdated',
      last_invoked: '2026-03-01T10:00:00Z',
      invocation_count: 2,
    }
    const { client } = createMockSupabase({ data: [rpcRow], error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      thresholdInvocations: 5,
      windowDays: 90,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.panel).toBe('staleSkills')
    expect(result.data.window).toBe('90d')
    expect(result.data.threshold).toBe(5)
    expect(result.data.rows).toHaveLength(1)

    const row = result.data.rows[0]
    expect(row.skill_name).toBe('skillsmith/outdated')
    expect(row.skill_id).toBe('skillsmith/outdated')
    expect(row.last_invoked).toBe('2026-03-01T10:00:00Z')
    expect(row.invocation_count).toBe(2)
    expect(row.installed_at).toBeNull()
    expect(row.recommend_action).toBe('review')
  })

  it('sets recommend_action to uninstall when invocation_count is 0', async () => {
    const { client } = createMockSupabase({
      data: [{ skill_name: 'a/dead', last_invoked: null, invocation_count: 0 }],
      error: null,
    })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      thresholdInvocations: 3,
      windowDays: 90,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rows[0].recommend_action).toBe('uninstall')
  })

  it('returns error envelope on RPC error — does not throw', async () => {
    const { client } = createMockSupabase({ data: null, error: { message: 'rls violation' } })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      thresholdInvocations: 5,
      windowDays: 90,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('analytics_skill_stale')
    expect(result.error).toContain('rls violation')
  })

  it('returns error envelope when getSupabaseClient throws', async () => {
    mockGetClient.mockRejectedValue(new Error('SUPABASE_ANON_KEY required'))

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      thresholdInvocations: 5,
      windowDays: 90,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('SUPABASE_ANON_KEY required')
  })

  it('handles null last_invoked as null', async () => {
    const { client } = createMockSupabase({
      data: [{ skill_name: 'a/never-used', last_invoked: null, invocation_count: 0 }],
      error: null,
    })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      thresholdInvocations: 5,
      windowDays: 90,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rows[0].last_invoked).toBeNull()
  })
})

// ============================================================================
// getCooccurrence
// ============================================================================

describe('SupabaseAnalyticsService.getCooccurrence', () => {
  let svc: SupabaseAnalyticsService

  beforeEach(() => {
    svc = new SupabaseAnalyticsService()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls analytics_skill_cooccurrence with correct params', async () => {
    const { client, rpc } = createMockSupabase({ data: [], error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    await svc.getCooccurrence({ teamId: TEAM_ID, windowDays: 30 })

    expect(rpc).toHaveBeenCalledWith('analytics_skill_cooccurrence', {
      p_team_id: TEAM_ID,
      p_window_days: 30,
    })
  })

  it('returns cooccurrence panel shape on success', async () => {
    const rpcRow = {
      skill_a: 'skillsmith/linear',
      skill_b: 'skillsmith/ship',
      cooccurrence_count: 15,
    }
    const { client } = createMockSupabase({ data: [rpcRow], error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getCooccurrence({ teamId: TEAM_ID, windowDays: 30 })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.panel).toBe('cooccurrence')
    expect(result.data.window_days).toBe(30)
    expect(result.data.rows).toHaveLength(1)
    expect(result.data.rows[0]).toEqual({
      skill_a: 'skillsmith/linear',
      skill_b: 'skillsmith/ship',
      cooccurrence_count: 15,
    })
  })

  it('applies minCount filter post-RPC', async () => {
    const rows = [
      { skill_a: 'a/foo', skill_b: 'a/bar', cooccurrence_count: 10 },
      { skill_a: 'a/baz', skill_b: 'a/qux', cooccurrence_count: 2 },
    ]
    const { client } = createMockSupabase({ data: rows, error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getCooccurrence({ teamId: TEAM_ID, windowDays: 30, minCount: 5 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rows).toHaveLength(1)
    expect(result.data.rows[0].skill_a).toBe('a/foo')
  })

  it('defaults minCount to 1 — includes all non-zero rows', async () => {
    const rows = [
      { skill_a: 'a/foo', skill_b: 'a/bar', cooccurrence_count: 1 },
      { skill_a: 'a/baz', skill_b: 'a/qux', cooccurrence_count: 3 },
    ]
    const { client } = createMockSupabase({ data: rows, error: null })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getCooccurrence({ teamId: TEAM_ID, windowDays: 30 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rows).toHaveLength(2)
  })

  it('returns error envelope on RPC error — does not throw', async () => {
    const { client } = createMockSupabase({ data: null, error: { message: 'timeout' } })
    mockGetClient.mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getSupabaseClient>>
    )

    const result = await svc.getCooccurrence({ teamId: TEAM_ID, windowDays: 30 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('analytics_skill_cooccurrence')
    expect(result.error).toContain('timeout')
  })

  it('returns error envelope when getSupabaseClient throws', async () => {
    mockGetClient.mockRejectedValue(new Error('@supabase/supabase-js not installed'))

    const result = await svc.getCooccurrence({ teamId: TEAM_ID, windowDays: 30 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('@supabase/supabase-js not installed')
  })
})
