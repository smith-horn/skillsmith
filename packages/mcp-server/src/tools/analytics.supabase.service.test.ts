/**
 * @fileoverview Tests for SupabaseAnalyticsService — cloud read path
 * @see SMI-5015: W1.S3 — MCP read path for skill-invoke analytics RPCs
 * @see SMI-6362 Wave 4 — D-2c (user-bound client), getToolUsage/getReportingCoverage,
 *   buildCoverageNote, nicknameFromActor
 *
 * All tests mock the Supabase client — no real database connection.
 * Mocking style matches integration-tools.service.test.ts: manual mock
 * object passed to the factory; `vi.fn()` for each method.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SupabaseAnalyticsService } from './analytics.supabase.service.js'
import type { TeamReportingCoverage } from './analytics.supabase.service.js'
import {
  buildCoverageNote,
  nicknameFromActor,
  actorDisplayLabel,
} from './analytics.supabase.service.js'

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

// D-2c: every SupabaseAnalyticsService method must build its client via
// getSupabaseUserClient(accessToken), never the anon-key getSupabaseClient() singleton — the
// exact B-5 anon-key bug this whole feature exists to fix. Both are mocked here (not just
// getSupabaseUserClient) so a regression that silently reintroduces getSupabaseClient() is
// caught by "mockGetClient was never called", not merely unnoticed.

vi.mock('../supabase-client.js', () => ({
  getSupabaseClient: vi.fn(),
  getSupabaseUserClient: vi.fn(),
}))

import { getSupabaseClient, getSupabaseUserClient } from '../supabase-client.js'

const mockGetClient = vi.mocked(getSupabaseClient)
const mockGetUserClient = vi.mocked(getSupabaseUserClient)

const TEAM_ID = 'team-uuid-001'
const ACCESS_TOKEN = 'test-access-token'

function mockUserClient(resolvedValue: { data: unknown; error: { message: string } | null }) {
  const { client, rpc } = createMockSupabase(resolvedValue)
  mockGetUserClient.mockResolvedValue(
    client as unknown as Awaited<ReturnType<typeof getSupabaseUserClient>>
  )
  return { client, rpc }
}

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
    const { rpc } = mockUserClient({ data: [], error: null })

    await svc.getTopSkills({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN, window: '7d' })

    expect(rpc).toHaveBeenCalledWith('analytics_skill_top', {
      p_team_id: TEAM_ID,
      p_window_days: 7,
    })
    expect(mockGetUserClient).toHaveBeenCalledWith(ACCESS_TOKEN)
  })

  it('calls analytics_skill_top with 30 days for 30d window', async () => {
    const { rpc } = mockUserClient({ data: [], error: null })

    await svc.getTopSkills({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN, window: '30d' })

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
    mockUserClient({ data: [rpcRow], error: null })

    const result = await svc.getTopSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      window: '30d',
    })

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
    mockUserClient({ data: rows, error: null })

    const result = await svc.getTopSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      window: '30d',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.unattributed_count).toBe(1)
  })

  it('includes coverage_note in response', async () => {
    mockUserClient({ data: [], error: null })

    const result = await svc.getTopSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      window: '30d',
    })

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
    mockUserClient({ data: rpcRows, error: null })

    const result = await svc.getTopSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      window: '30d',
      limit: 3,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rows).toHaveLength(3)
  })

  it('returns error envelope on RPC error — does not throw', async () => {
    mockUserClient({ data: null, error: { message: 'permission denied' } })

    const result = await svc.getTopSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      window: '30d',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('analytics_skill_top')
    expect(result.error).toContain('permission denied')
  })

  it('returns error envelope when getSupabaseUserClient throws', async () => {
    mockGetUserClient.mockRejectedValue(new Error('Supabase not configured'))

    const result = await svc.getTopSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      window: '7d',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Supabase not configured')
  })

  it('handles null week_over_week_delta as null', async () => {
    mockUserClient({
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

    const result = await svc.getTopSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      window: '7d',
    })

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
    const { rpc } = mockUserClient({ data: [], error: null })

    await svc.getStaleSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      thresholdInvocations: 5,
      windowDays: 90,
    })

    expect(rpc).toHaveBeenCalledWith('analytics_skill_stale', {
      p_team_id: TEAM_ID,
      p_window_days: 90,
      p_threshold: 5,
    })
    expect(mockGetUserClient).toHaveBeenCalledWith(ACCESS_TOKEN)
  })

  it('returns staleSkills panel shape on success', async () => {
    const rpcRow = {
      skill_name: 'skillsmith/outdated',
      last_invoked: '2026-03-01T10:00:00Z',
      invocation_count: 2,
    }
    mockUserClient({ data: [rpcRow], error: null })

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
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
    mockUserClient({
      data: [{ skill_name: 'a/dead', last_invoked: null, invocation_count: 0 }],
      error: null,
    })

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      thresholdInvocations: 3,
      windowDays: 90,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rows[0].recommend_action).toBe('uninstall')
  })

  it('returns error envelope on RPC error — does not throw', async () => {
    mockUserClient({ data: null, error: { message: 'rls violation' } })

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      thresholdInvocations: 5,
      windowDays: 90,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('analytics_skill_stale')
    expect(result.error).toContain('rls violation')
  })

  it('returns error envelope when getSupabaseUserClient throws', async () => {
    mockGetUserClient.mockRejectedValue(new Error('SUPABASE_ANON_KEY required'))

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      thresholdInvocations: 5,
      windowDays: 90,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('SUPABASE_ANON_KEY required')
  })

  it('handles null last_invoked as null', async () => {
    mockUserClient({
      data: [{ skill_name: 'a/never-used', last_invoked: null, invocation_count: 0 }],
      error: null,
    })

    const result = await svc.getStaleSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
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
    const { rpc } = mockUserClient({ data: [], error: null })

    await svc.getCooccurrence({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN, windowDays: 30 })

    expect(rpc).toHaveBeenCalledWith('analytics_skill_cooccurrence', {
      p_team_id: TEAM_ID,
      p_window_days: 30,
    })
    expect(mockGetUserClient).toHaveBeenCalledWith(ACCESS_TOKEN)
  })

  it('returns cooccurrence panel shape on success', async () => {
    const rpcRow = {
      skill_a: 'skillsmith/linear',
      skill_b: 'skillsmith/ship',
      cooccurrence_count: 15,
    }
    mockUserClient({ data: [rpcRow], error: null })

    const result = await svc.getCooccurrence({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

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
    mockUserClient({ data: rows, error: null })

    const result = await svc.getCooccurrence({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
      minCount: 5,
    })

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
    mockUserClient({ data: rows, error: null })

    const result = await svc.getCooccurrence({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.rows).toHaveLength(2)
  })

  it('returns error envelope on RPC error — does not throw', async () => {
    mockUserClient({ data: null, error: { message: 'timeout' } })

    const result = await svc.getCooccurrence({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('analytics_skill_cooccurrence')
    expect(result.error).toContain('timeout')
  })

  it('returns error envelope when getSupabaseUserClient throws', async () => {
    mockGetUserClient.mockRejectedValue(new Error('@supabase/supabase-js not installed'))

    const result = await svc.getCooccurrence({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('@supabase/supabase-js not installed')
  })
})

// ============================================================================
// getToolUsage (SMI-6362 Wave 4)
// ============================================================================

describe('SupabaseAnalyticsService.getToolUsage', () => {
  let svc: SupabaseAnalyticsService

  beforeEach(() => {
    svc = new SupabaseAnalyticsService()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls analytics_tool_usage with correct params', async () => {
    const { rpc } = mockUserClient({ data: [], error: null })

    await svc.getToolUsage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN, windowDays: 30 })

    expect(rpc).toHaveBeenCalledWith('analytics_tool_usage', {
      p_team_id: TEAM_ID,
      p_window_days: 30,
    })
    expect(mockGetUserClient).toHaveBeenCalledWith(ACCESS_TOKEN)
  })

  it('maps an RPC row to the AnalyticsData/UsageReportData shape, including numeric-string coercion', async () => {
    const rpcRow = {
      total_calls: 120,
      unique_tools: 8,
      top_tools: [
        { tool: 'search', count: 50 },
        { tool: 'skill_recommend', count: '30' },
      ],
      daily_trend: [
        { date: '2026-08-01', count: 10 },
        { date: '2026-08-02', count: '5' },
      ],
      previous_period_total: 80,
      by_actor: [
        { actor: 'a'.repeat(64), count: 60 },
        { actor: 'b'.repeat(64), count: '60' },
      ],
    }
    mockUserClient({ data: [rpcRow], error: null })

    const result = await svc.getToolUsage({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.totalToolCalls).toBe(120)
    expect(result.data.uniqueTools).toBe(8)
    expect(result.data.topTools).toEqual([
      { tool: 'search', count: 50 },
      { tool: 'skill_recommend', count: 30 },
    ])
    expect(result.data.dailyTrend).toEqual([
      { date: '2026-08-01', count: 10 },
      { date: '2026-08-02', count: 5 },
    ])
    expect(result.data.byActor).toEqual([
      { actor: 'a'.repeat(64), count: 60 },
      { actor: 'b'.repeat(64), count: 60 },
    ])
  })

  it('computes changePercent per the standard formula when previous_period_total is nonzero', async () => {
    mockUserClient({
      data: [
        {
          total_calls: 75,
          unique_tools: 3,
          top_tools: [],
          daily_trend: [],
          previous_period_total: 50,
          by_actor: [],
        },
      ],
      error: null,
    })

    const result = await svc.getToolUsage({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.periodComparison).toEqual({ current: 75, previous: 50, changePercent: 50 })
  })

  it('falls back changePercent to 0 when previous_period_total is 0', async () => {
    mockUserClient({
      data: [
        {
          total_calls: 40,
          unique_tools: 2,
          top_tools: [],
          daily_trend: [],
          previous_period_total: 0,
          by_actor: [],
        },
      ],
      error: null,
    })

    const result = await svc.getToolUsage({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.periodComparison).toEqual({ current: 40, previous: 0, changePercent: 0 })
  })

  // ==========================================================================
  // RLS-isolation negative coverage (SMI-6362 Wave 4 adversarial review)
  //
  // analytics_tool_usage is SECURITY INVOKER, so search_metrics'
  // `search_metrics_team_scoped_read` policy — keyed on auth.uid()'s real
  // team_members rows via user_team_ids(), NOT on p_team_id — is the actual
  // authorization boundary. A caller who passes a team they are not a member of
  // therefore has every candidate row filtered away before aggregation, and the
  // RPC's own scalar-subquery SELECT still yields exactly one all-zero row.
  //
  // These tests pin the CLIENT half of that contract: whatever the boundary
  // hands back for a foreign team must surface as honest zeros, never as a
  // fabricated figure and never as an `ok:false` that a caller might paper over
  // with stub data. They deliberately assert the mapper's behavior under the
  // hostile-input RESULT, since the filtering itself is enforced in Postgres and
  // cannot be exercised against a mocked client.
  // ==========================================================================

  it('maps a zero-row RPC result to an all-zero envelope — the shape a caller passing a team they are not a member of gets', async () => {
    mockUserClient({ data: [], error: null })

    const result = await svc.getToolUsage({
      teamId: 'team-the-caller-does-not-belong-to',
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({
      totalToolCalls: 0,
      uniqueTools: 0,
      topTools: [],
      dailyTrend: [],
      periodComparison: { current: 0, previous: 0, changePercent: 0 },
      byActor: [],
    })
    // No other team's rows may leak in through any collection field.
    expect(result.data.byActor).toHaveLength(0)
    expect(result.data.topTools).toHaveLength(0)
  })

  it('maps an all-zero single-row RPC result (RLS filtered every row away) to zeros, never a fabricated figure', async () => {
    mockUserClient({
      data: [
        {
          total_calls: 0,
          unique_tools: 0,
          top_tools: [],
          daily_trend: [],
          previous_period_total: 0,
          by_actor: [],
        },
      ],
      error: null,
    })

    const result = await svc.getToolUsage({
      teamId: 'team-the-caller-does-not-belong-to',
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.totalToolCalls).toBe(0)
    expect(result.data.uniqueTools).toBe(0)
    expect(result.data.periodComparison).toEqual({ current: 0, previous: 0, changePercent: 0 })
    expect(result.data.byActor).toEqual([])
  })

  it('forwards the caller-supplied teamId verbatim as p_team_id — it is a filter, never an authorization check', async () => {
    const { rpc } = mockUserClient({ data: [], error: null })

    await svc.getToolUsage({
      teamId: 'team-the-caller-does-not-belong-to',
      accessToken: ACCESS_TOKEN,
      windowDays: 7,
    })

    // The service must NOT try to pre-authorize the team itself: a client-side
    // membership check here would be a second, drift-prone copy of the RLS
    // policy. It forwards the id and lets Postgres decide.
    expect(rpc).toHaveBeenCalledWith('analytics_tool_usage', {
      p_team_id: 'team-the-caller-does-not-belong-to',
      p_window_days: 7,
    })
    // And it stays bound to the caller's own JWT while doing so.
    expect(mockGetUserClient).toHaveBeenCalledWith(ACCESS_TOKEN)
    expect(mockGetClient).not.toHaveBeenCalled()
  })

  it('tolerates a null `data` payload without throwing or fabricating', async () => {
    mockUserClient({ data: null, error: null })

    const result = await svc.getToolUsage({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.totalToolCalls).toBe(0)
  })

  it('returns error envelope on RPC error — does not throw', async () => {
    mockUserClient({ data: null, error: { message: 'permission denied' } })

    const result = await svc.getToolUsage({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('analytics_tool_usage')
    expect(result.error).toContain('permission denied')
  })

  it('returns error envelope when getSupabaseUserClient throws', async () => {
    mockGetUserClient.mockRejectedValue(new Error('Supabase not configured'))

    const result = await svc.getToolUsage({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      windowDays: 30,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Supabase not configured')
  })
})

// ============================================================================
// getReportingCoverage (SMI-6362 Wave 4, D-2e)
// ============================================================================

describe('SupabaseAnalyticsService.getReportingCoverage', () => {
  let svc: SupabaseAnalyticsService

  beforeEach(() => {
    svc = new SupabaseAnalyticsService()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls analytics_team_reporting_coverage with correct params', async () => {
    const { rpc } = mockUserClient({ data: [], error: null })

    await svc.getReportingCoverage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN })

    expect(rpc).toHaveBeenCalledWith('analytics_team_reporting_coverage', {
      p_team_id: TEAM_ID,
    })
    expect(mockGetUserClient).toHaveBeenCalledWith(ACCESS_TOKEN)
  })

  it("maps a 'full' coverage_level row — carries numbers, suppressed false", async () => {
    mockUserClient({
      data: [
        {
          coverage_level: 'full',
          suppression_reason: null,
          total_seats: 20,
          reporting_seats: 12,
          non_reporting_seats: 8,
          opted_out_seats: 3,
          undecided_seats: 5,
          active_actors_in_window: 10,
          suppressed: false,
        },
      ],
      error: null,
    })

    const result = await svc.getReportingCoverage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({
      coverageLevel: 'full',
      totalSeats: 20,
      reportingSeats: 12,
      nonReportingSeats: 8,
      optedOutSeats: 3,
      undecidedSeats: 5,
      activeActorsInWindow: 10,
      suppressed: false,
    })
    // suppression_reason must never appear on the mapped object, in either casing.
    expect(Object.keys(result.data)).not.toContain('suppression_reason')
    expect(Object.keys(result.data)).not.toContain('suppressionReason')
  })

  it("maps an 'aggregate' coverage_level row — total/reporting/non-reporting/active numbers, opted-out/undecided withheld", async () => {
    mockUserClient({
      data: [
        {
          coverage_level: 'aggregate',
          suppression_reason: 'split_bucket_too_small',
          total_seats: 20,
          reporting_seats: 12,
          non_reporting_seats: 8,
          opted_out_seats: null,
          undecided_seats: null,
          active_actors_in_window: 10,
          suppressed: true,
        },
      ],
      error: null,
    })

    const result = await svc.getReportingCoverage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({
      coverageLevel: 'aggregate',
      totalSeats: 20,
      reportingSeats: 12,
      nonReportingSeats: 8,
      optedOutSeats: null,
      undecidedSeats: null,
      activeActorsInWindow: 10,
      suppressed: true,
    })
  })

  it("maps a 'qualitative' coverage_level row — every count field null", async () => {
    mockUserClient({
      data: [
        {
          coverage_level: 'qualitative',
          suppression_reason: 'small_sensitive_bucket',
          total_seats: null,
          reporting_seats: null,
          non_reporting_seats: null,
          opted_out_seats: null,
          undecided_seats: null,
          active_actors_in_window: null,
          suppressed: true,
        },
      ],
      error: null,
    })

    const result = await svc.getReportingCoverage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({
      coverageLevel: 'qualitative',
      totalSeats: null,
      reportingSeats: null,
      nonReportingSeats: null,
      optedOutSeats: null,
      undecidedSeats: null,
      activeActorsInWindow: null,
      suppressed: true,
    })
  })

  it('returns error envelope on zero rows — caller is not a team member', async () => {
    mockUserClient({ data: [], error: null })

    const result = await svc.getReportingCoverage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Not a member of this team')
  })

  // analytics_team_reporting_coverage is SECURITY DEFINER (so RLS cannot be the
  // boundary for it) and instead runs its own
  // `EXISTS (SELECT 1 FROM team_members WHERE team_id = p_team_id AND user_id =
  // auth.uid())` check FIRST, returning zero rows — never an error — for a
  // non-member, so the response cannot be used to probe whether a team exists.
  // This pins the client half: a foreign team id is forwarded verbatim and its
  // zero-row answer becomes `ok:false` with no coverage payload at all, so no
  // renderer can reach a fabricated level. (buildCoverageNote(null) is what the
  // handler then renders — asserted in analytics.test.ts.)
  it('forwards a foreign teamId verbatim and yields no coverage payload for a non-member', async () => {
    const { rpc } = mockUserClient({ data: [], error: null })

    const result = await svc.getReportingCoverage({
      teamId: 'team-the-caller-does-not-belong-to',
      accessToken: ACCESS_TOKEN,
    })

    expect(rpc).toHaveBeenCalledWith('analytics_team_reporting_coverage', {
      p_team_id: 'team-the-caller-does-not-belong-to',
    })
    expect(mockGetUserClient).toHaveBeenCalledWith(ACCESS_TOKEN)
    expect(mockGetClient).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The envelope carries an error string only — no `data`, so no coverage
    // level, seat count, or suppression reason can be read off it.
    expect(Object.keys(result)).toEqual(['ok', 'error'])
  })

  it('returns error envelope on RPC error — does not throw', async () => {
    mockUserClient({ data: null, error: { message: 'timeout' } })

    const result = await svc.getReportingCoverage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('analytics_team_reporting_coverage')
    expect(result.error).toContain('timeout')
  })

  it('returns error envelope when getSupabaseUserClient throws', async () => {
    mockGetUserClient.mockRejectedValue(new Error('Supabase not configured'))

    const result = await svc.getReportingCoverage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Supabase not configured')
  })
})

// ============================================================================
// D-2c regression guard: every method uses getSupabaseUserClient, never getSupabaseClient
// ============================================================================

describe('SupabaseAnalyticsService — D-2c user-bound client only', () => {
  let svc: SupabaseAnalyticsService

  beforeEach(() => {
    svc = new SupabaseAnalyticsService()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls getSupabaseUserClient (never the anon-key getSupabaseClient singleton) from all five methods', async () => {
    mockUserClient({
      data: [
        {
          coverage_level: 'qualitative',
          suppression_reason: null,
          total_seats: null,
          reporting_seats: null,
          non_reporting_seats: null,
          opted_out_seats: null,
          undecided_seats: null,
          active_actors_in_window: null,
          suppressed: true,
        },
      ],
      error: null,
    })

    await svc.getTopSkills({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN, window: '7d' })
    await svc.getStaleSkills({
      teamId: TEAM_ID,
      accessToken: ACCESS_TOKEN,
      thresholdInvocations: 5,
      windowDays: 90,
    })
    await svc.getCooccurrence({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN, windowDays: 30 })
    await svc.getToolUsage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN, windowDays: 30 })
    await svc.getReportingCoverage({ teamId: TEAM_ID, accessToken: ACCESS_TOKEN })

    expect(mockGetUserClient).toHaveBeenCalledTimes(5)
    for (const call of mockGetUserClient.mock.calls) {
      expect(call[0]).toBe(ACCESS_TOKEN)
    }
    expect(mockGetClient).not.toHaveBeenCalled()
  })
})

// ============================================================================
// nicknameFromActor / actorDisplayLabel (SMI-6362 Wave 4 — ops-report parity port)
// ============================================================================

describe('nicknameFromActor', () => {
  it('is deterministic — same digest always produces the same nickname', () => {
    const digest = 'a'.repeat(64)
    expect(nicknameFromActor(digest)).toBe(nicknameFromActor(digest))
  })

  it('spot-check: all-zero digest resolves to the first adjective/animal pair', () => {
    // hex.slice(0,2) === '00' -> 0 % 30 === 0 -> ADJECTIVES[0]; same for the second byte.
    expect(nicknameFromActor('0'.repeat(64))).toBe('indigo-falcon')
  })

  it('spot-check: a known non-zero prefix resolves to a different, still-deterministic pair', () => {
    // 0xff % 30 === 15 -> ADJECTIVES[15] ('misty'); 0x00 % 30 === 0 -> ANIMALS[0] ('falcon').
    const digest = `ff00${'0'.repeat(60)}`
    expect(nicknameFromActor(digest)).toBe('misty-falcon')
  })

  it('actorDisplayLabel pairs the nickname with a 12-char digest prefix', () => {
    const digest = '0'.repeat(64)
    expect(actorDisplayLabel(digest)).toBe('indigo-falcon (000000000000)')
  })
})

// ============================================================================
// buildCoverageNote (SMI-6362 Wave 4, D-1/D-2e/D-9)
// ============================================================================

describe('buildCoverageNote', () => {
  const SUPPRESSION_REASON_STRINGS = [
    'small_sensitive_bucket',
    'small_complement',
    'split_bucket_too_small',
  ]

  const FULL: TeamReportingCoverage = {
    coverageLevel: 'full',
    totalSeats: 20,
    reportingSeats: 12,
    nonReportingSeats: 8,
    optedOutSeats: 3,
    undecidedSeats: 5,
    activeActorsInWindow: 10,
    suppressed: false,
  }

  const AGGREGATE: TeamReportingCoverage = {
    coverageLevel: 'aggregate',
    totalSeats: 20,
    reportingSeats: 12,
    nonReportingSeats: 8,
    optedOutSeats: null,
    undecidedSeats: null,
    activeActorsInWindow: 10,
    suppressed: true,
  }

  const QUALITATIVE: TeamReportingCoverage = {
    coverageLevel: 'qualitative',
    totalSeats: null,
    reportingSeats: null,
    nonReportingSeats: null,
    optedOutSeats: null,
    undecidedSeats: null,
    activeActorsInWindow: null,
    suppressed: true,
  }

  it('renders the static capture-status statement before the coverage figure before the self-attestation limitation, for null coverage', () => {
    const note = buildCoverageNote(null)
    expect(note).toContain('MCP tool calls are captured')
    expect(note).toContain('currently unavailable')
    expect(note).toContain('self-reported')

    const captureIdx = note.indexOf('MCP tool calls are captured')
    const coverageIdx = note.indexOf('currently unavailable')
    const selfAttestIdx = note.indexOf('self-reported')
    expect(captureIdx).toBeLessThan(coverageIdx)
    expect(coverageIdx).toBeLessThan(selfAttestIdx)
  })

  it("renders reporting/total seats plus the opted-out/undecided split for 'full'", () => {
    const note = buildCoverageNote(FULL)
    expect(note).toContain('12 of 20 seats reporting')
    expect(note).toContain('3 opted out')
    expect(note).toContain('5 undecided')
  })

  it("renders reporting/total seats but withholds the numeric opted-out/undecided split for 'aggregate'", () => {
    const note = buildCoverageNote(AGGREGATE)
    expect(note).toContain('12 of 20 seats reporting')
    expect(note).toContain('withheld to protect individual privacy')
    // The split is named generically ("opted-out/undecided split") but never with a number
    // attached — that's what "withheld" means here. Contrast with the 'full' case above, which
    // does attach numbers ("3 opted out", "5 undecided").
    expect(note).not.toMatch(/\d+\s+opted out/)
    expect(note).not.toMatch(/\d+\s+undecided/)
  })

  it("renders a purely qualitative sentence with NO digits for 'qualitative'", () => {
    const note = buildCoverageNote(QUALITATIVE)
    expect(note).toContain('at least five seats are reporting and at least five are not')
    // The full note (not just the qualitative sentence) must be entirely digit-free — the
    // capture-status and self-attestation sentences around it never carry numbers either.
    expect(note).toMatch(/^[^\d]*$/)
  })

  it('never renders a suppression_reason-shaped string, for any coverage level or null', () => {
    for (const coverage of [null, FULL, AGGREGATE, QUALITATIVE]) {
      const note = buildCoverageNote(coverage)
      for (const reason of SUPPRESSION_REASON_STRINGS) {
        expect(note).not.toContain(reason)
      }
    }
  })

  // ==========================================================================
  // Null-bucket demotion (SMI-6362 Wave 4 adversarial review)
  //
  // Every count on TeamReportingCoverage is `number | null`. Interpolating a
  // null renders the literal string "null" into a Team admin's dashboard — a
  // wrong figure that reads like data. Today's SQL contract does populate each
  // level's own buckets (all counts are COUNT(...)::INT, never NULL), so these
  // guard a type-level possibility rather than a live RPC shape; the property
  // they pin is that an unexpected null degrades to a LOWER disclosure tier,
  // never to a placeholder and never upward.
  // ==========================================================================

  it('demotes a \'full\' row whose opted-out/undecided split is null to the aggregate sentence — never the string "null"', () => {
    const note = buildCoverageNote({ ...FULL, optedOutSeats: null, undecidedSeats: null })

    expect(note).not.toContain('null')
    expect(note).toContain('12 of 20 seats reporting')
    expect(note).toContain('withheld to protect individual privacy')
    // Demoted, so the split must not appear with numbers attached.
    expect(note).not.toMatch(/\d+\s+opted out/)
    expect(note).not.toMatch(/\d+\s+undecided/)
  })

  it("demotes a 'full' row missing only one half of the split (undecided) to the aggregate sentence", () => {
    const note = buildCoverageNote({ ...FULL, undecidedSeats: null })

    expect(note).not.toContain('null')
    expect(note).toContain('withheld to protect individual privacy')
    expect(note).not.toMatch(/\d+\s+opted out/)
  })

  it("demotes a 'full' row whose seat ratio is null all the way to the digit-free qualitative sentence", () => {
    const note = buildCoverageNote({ ...FULL, reportingSeats: null, totalSeats: null })

    expect(note).not.toContain('null')
    expect(note).toContain('at least five seats are reporting and at least five are not')
    expect(note).toMatch(/^[^\d]*$/)
  })

  it("demotes an 'aggregate' row whose seat ratio is null to the digit-free qualitative sentence", () => {
    const note = buildCoverageNote({ ...AGGREGATE, reportingSeats: null })

    expect(note).not.toContain('null')
    expect(note).toMatch(/^[^\d]*$/)
  })

  it("never renders totals for a 'qualitative' row, even if the RPC contradicted itself and sent numbers", () => {
    // Defence against a future RPC edit that populates buckets on a suppressed
    // level: the declared level wins, and qualitative renders no numbers ever.
    const note = buildCoverageNote({ ...QUALITATIVE, totalSeats: 20, reportingSeats: 12 })

    expect(note).toMatch(/^[^\d]*$/)
    expect(note).not.toContain('seats reporting')
  })

  it('never renders the literal string "null" for any combination of null buckets at any level', () => {
    const levels = ['full', 'aggregate', 'qualitative'] as const
    const bucketKeys = [
      'totalSeats',
      'reportingSeats',
      'nonReportingSeats',
      'optedOutSeats',
      'undecidedSeats',
      'activeActorsInWindow',
    ] as const

    for (const coverageLevel of levels) {
      // Every single-bucket-nulled variant, plus the all-null variant.
      for (const key of bucketKeys) {
        const note = buildCoverageNote({ ...FULL, coverageLevel, [key]: null })
        expect(note, `${coverageLevel} with ${key}=null`).not.toContain('null')
        expect(note, `${coverageLevel} with ${key}=null`).not.toContain('undefined')
      }
      const allNull = buildCoverageNote({ ...QUALITATIVE, coverageLevel })
      expect(allNull, `${coverageLevel} with every bucket null`).not.toContain('null')
      expect(allNull, `${coverageLevel} with every bucket null`).toMatch(/^[^\d]*$/)
    }
  })
})
