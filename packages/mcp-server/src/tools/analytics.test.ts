/**
 * @fileoverview Tests for analytics MCP tools
 * @see SMI-3899: Team Usage Analytics MCP Tools (Wave 2b)
 * @see SMI-6362 Wave 4: cloud-first resolution — replaces the old local-SQLite/stub-fallback
 *   coverage (a `{} as ToolContext` caller with no db no longer renders stub markdown; it now hits
 *   the "not signed in" credential-resolution branch, since the local/stub fallback was removed
 *   from the four handlers entirely — see analytics.actions.ts's module doc comment).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'

// ============================================================================
// Mocks — declared before imports (vitest hoists vi.mock; `mock`-prefixed vars
// referenced inside factories are hoisted too, matching skill-recover-source.test.ts's
// established pattern in this package)
// ============================================================================

const mockResolveUserAccessToken = vi.fn()
const mockResolveLicenseTeamId = vi.fn()

vi.mock('./team-resolver.js', () => ({
  resolveUserAccessToken: (...args: unknown[]) => mockResolveUserAccessToken(...args),
  resolveLicenseTeamId: (...args: unknown[]) => mockResolveLicenseTeamId(...args),
}))

const mockGetToolUsage = vi.fn()
const mockGetReportingCoverage = vi.fn()

vi.mock('./analytics.supabase.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./analytics.supabase.service.js')>()
  return {
    ...actual,
    // Must be a regular function (not arrow) so `new SupabaseAnalyticsService()` works.
    SupabaseAnalyticsService: function MockSupabaseAnalyticsService() {
      return {
        getToolUsage: (...args: unknown[]) => mockGetToolUsage(...args),
        getReportingCoverage: (...args: unknown[]) => mockGetReportingCoverage(...args),
      }
    },
  }
})

const mockGetTelemetryEmitStats = vi.fn()

vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    getTelemetryEmitStats: () => mockGetTelemetryEmitStats(),
  }
})

// ============================================================================
// Imports after mocks
// ============================================================================

import {
  executeTeamAnalyticsDashboard,
  executeTeamUsageReport,
  executeAnalyticsDashboard,
  executeUsageReport,
  teamAnalyticsDashboardInputSchema,
  teamUsageReportInputSchema,
  analyticsDashboardInputSchema,
  usageReportInputSchema,
} from './analytics.js'
import { buildCoverageNote, actorDisplayLabel } from './analytics.supabase.service.js'
import type { TeamReportingCoverage } from './analytics.supabase.service.js'

/** analytics handlers no longer read context.db (cloud-first, SMI-6362 Wave 4) */
const mockContext = {} as ToolContext

// ============================================================================
// Fixtures
// ============================================================================

const ACTOR_A = 'a'.repeat(64)
const ACTOR_B = 'b'.repeat(64)

function usageData(
  overrides: Partial<{
    totalToolCalls: number
    uniqueTools: number
    topTools: Array<{ tool: string; count: number }>
    dailyTrend: Array<{ date: string; count: number }>
    periodComparison: { current: number; previous: number; changePercent: number }
    byActor: Array<{ actor: string; count: number }>
  }> = {}
) {
  return {
    totalToolCalls: 100,
    uniqueTools: 5,
    topTools: [
      { tool: 'search', count: 40 },
      { tool: 'install_skill', count: 30 },
    ],
    dailyTrend: [
      { date: '2026-09-01', count: 10 },
      { date: '2026-09-02', count: 20 },
    ],
    periodComparison: { current: 100, previous: 80, changePercent: 25 },
    byActor: [{ actor: ACTOR_A, count: 50 }],
    ...overrides,
  }
}

const FULL_COVERAGE: TeamReportingCoverage = {
  coverageLevel: 'full',
  totalSeats: 10,
  reportingSeats: 8,
  nonReportingSeats: 2,
  optedOutSeats: 1,
  undecidedSeats: 1,
  activeActorsInWindow: 6,
  suppressed: false,
}

function noEmitIssues() {
  return { accepted: 5, rejected: 0, failed: 0, skippedNoIdentity: 0, lastRejectionReason: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveUserAccessToken.mockResolvedValue('token-abc')
  mockResolveLicenseTeamId.mockResolvedValue('team-123')
  mockGetToolUsage.mockResolvedValue({ ok: true, data: usageData() })
  mockGetReportingCoverage.mockResolvedValue({ ok: true, data: FULL_COVERAGE })
  mockGetTelemetryEmitStats.mockReturnValue(noEmitIssues())
})

describe('analytics tools', () => {
  describe('input schema validation', () => {
    it('teamAnalyticsDashboardInputSchema defaults period to 30d', () => {
      const result = teamAnalyticsDashboardInputSchema.parse({})
      expect(result.period).toBe('30d')
    })

    it('teamAnalyticsDashboardInputSchema accepts valid periods', () => {
      expect(teamAnalyticsDashboardInputSchema.parse({ period: '7d' }).period).toBe('7d')
      expect(teamAnalyticsDashboardInputSchema.parse({ period: '90d' }).period).toBe('90d')
    })

    it('teamAnalyticsDashboardInputSchema rejects invalid periods', () => {
      expect(() => teamAnalyticsDashboardInputSchema.parse({ period: '1d' })).toThrow()
    })

    it('teamUsageReportInputSchema defaults format to summary', () => {
      const result = teamUsageReportInputSchema.parse({})
      expect(result.format).toBe('summary')
    })

    it('teamUsageReportInputSchema accepts detailed format', () => {
      const result = teamUsageReportInputSchema.parse({ format: 'detailed' })
      expect(result.format).toBe('detailed')
    })

    it('analyticsDashboardInputSchema defaults includeRecommendations to false', () => {
      const result = analyticsDashboardInputSchema.parse({})
      expect(result.includeRecommendations).toBe(false)
    })

    it('usageReportInputSchema accepts csv format', () => {
      const result = usageReportInputSchema.parse({ format: 'csv' })
      expect(result.format).toBe('csv')
    })

    it('usageReportInputSchema rejects invalid format', () => {
      expect(() => usageReportInputSchema.parse({ format: 'xml' })).toThrow()
    })
  })

  describe('credential resolution failures (never fall through to local/stub data)', () => {
    it('not signed in renders an actionable error as the entire output', async () => {
      mockResolveUserAccessToken.mockResolvedValue(null)
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain('# Team Analytics Dashboard (30d)')
      expect(result).toContain('## Error')
      expect(result).toContain('Not signed in')
      expect(result).toContain('skillsmith login')
      expect(result).not.toContain('Data source')
      expect(mockGetToolUsage).not.toHaveBeenCalled()
    })

    it('no resolvable team renders an actionable error as the entire output', async () => {
      mockResolveLicenseTeamId.mockResolvedValue(null)
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain('Unable to resolve your team')
      expect(result).toContain('SKILLSMITH_LICENSE_KEY')
      expect(mockGetToolUsage).not.toHaveBeenCalled()
    })

    it('a cloud RPC failure renders an actionable error, not local/stub data', async () => {
      mockGetToolUsage.mockResolvedValue({
        ok: false,
        error: 'analytics_tool_usage RPC failed: boom',
      })
      const input = usageReportInputSchema.parse({})
      const result = await executeUsageReport(input, mockContext)

      expect(result).toContain('# Enterprise Usage Report (30d)')
      expect(result).toContain('## Error')
      expect(result).toContain('analytics_tool_usage RPC failed: boom')
      expect(result).not.toContain('Data source')
    })
  })

  describe('executeTeamAnalyticsDashboard (cloud success)', () => {
    it('renders live-cloud data source and maps getToolUsage fields', async () => {
      const input = teamAnalyticsDashboardInputSchema.parse({ period: '30d' })
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain('# Team Analytics Dashboard (30d)')
      expect(result).toContain('- **Data source**: live-cloud')
      expect(result).toContain('- **Total tool calls**: 100')
      expect(result).toContain('- **Unique tools**: 5')
      expect(result).toContain('| search | 40 | 40% |')
      expect(mockGetToolUsage).toHaveBeenCalledWith({
        teamId: 'team-123',
        accessToken: 'token-abc',
        windowDays: 30,
      })
    })

    it('adjusts the period label for 7d', async () => {
      const input = teamAnalyticsDashboardInputSchema.parse({ period: '7d' })
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain('# Team Analytics Dashboard (7d)')
      expect(result).toContain('Last 7 days')
    })
  })

  describe('executeTeamUsageReport (cloud success)', () => {
    it('returns summary format without a per-user breakdown by default', async () => {
      const input = teamUsageReportInputSchema.parse({})
      const result = await executeTeamUsageReport(input, mockContext)

      expect(result).toContain('# Team Usage Report (30d)')
      expect(result).toContain('- **Data source**: live-cloud')
      expect(result).not.toContain('## Detailed Breakdown by User')
    })

    it('returns detailed format with a per-actor breakdown', async () => {
      const input = teamUsageReportInputSchema.parse({ format: 'detailed' })
      const result = await executeTeamUsageReport(input, mockContext)

      expect(result).toContain('## Detailed Breakdown by User')
      expect(result).toContain(actorDisplayLabel(ACTOR_A))
    })
  })

  describe('executeAnalyticsDashboard (cloud success)', () => {
    it('omits Recommendation Accuracy by default', async () => {
      const input = analyticsDashboardInputSchema.parse({})
      const result = await executeAnalyticsDashboard(input, mockContext)

      expect(result).toContain('# Enterprise Analytics Dashboard (30d)')
      expect(result).toContain('- **Data source**: live-cloud')
      expect(result).not.toContain('## Recommendation Accuracy')
    })

    it('renders an honest not-yet-implemented note when recommendations are requested', async () => {
      const input = analyticsDashboardInputSchema.parse({ includeRecommendations: true })
      const result = await executeAnalyticsDashboard(input, mockContext)

      expect(result).toContain('## Recommendation Accuracy')
      expect(result).toContain('not yet implemented for cloud-backed analytics')
    })
  })

  describe('executeUsageReport (cloud success)', () => {
    it('returns markdown summary by default', async () => {
      const input = usageReportInputSchema.parse({})
      const result = await executeUsageReport(input, mockContext)

      expect(result).toContain('# Enterprise Usage Report (30d)')
      expect(result).toContain('- **Data source**: live-cloud')
    })

    it('returns CSV format with the disclosures embedded as extra rows, not markdown', async () => {
      const input = usageReportInputSchema.parse({ format: 'csv' })
      const result = await executeUsageReport(input, mockContext)

      expect(result).toContain('metric,current_period,previous_period,change_percent')
      expect(result).toContain('total_calls,100,80,25')
      expect(result).not.toContain('##')
      expect(result).toContain('data_coverage_note,')
      expect(result).toContain('skill_invocation_note,')
    })

    it('returns detailed format with a per-user breakdown', async () => {
      const input = usageReportInputSchema.parse({ format: 'detailed' })
      const result = await executeUsageReport(input, mockContext)

      expect(result).toContain('## Per-User Breakdown')
      expect(result).toContain(actorDisplayLabel(ACTOR_A))
    })
  })

  describe('AC-9: all four tools include the data coverage note', () => {
    it.each([
      [
        'team_analytics_dashboard',
        () =>
          executeTeamAnalyticsDashboard(teamAnalyticsDashboardInputSchema.parse({}), mockContext),
      ],
      [
        'team_usage_report',
        () => executeTeamUsageReport(teamUsageReportInputSchema.parse({}), mockContext),
      ],
      [
        'analytics_dashboard',
        () => executeAnalyticsDashboard(analyticsDashboardInputSchema.parse({}), mockContext),
      ],
      ['usage_report', () => executeUsageReport(usageReportInputSchema.parse({}), mockContext)],
    ])(
      '%s includes the Data Coverage note and skill-invocation honesty line',
      async (_name, run) => {
        const result = await run()
        expect(result).toContain('## Data Coverage')
        expect(result).toContain(buildCoverageNote(FULL_COVERAGE))
        expect(result).toContain(
          'Skill-invocation data: not yet captured for teams (Claude Code hook invocations are not team-attributed).'
        )
      }
    )
  })

  describe('data coverage note (buildCoverageNote rendered verbatim)', () => {
    it.each([
      ['full', { ...FULL_COVERAGE, coverageLevel: 'full' as const }],
      ['aggregate', { ...FULL_COVERAGE, coverageLevel: 'aggregate' as const }],
      ['qualitative', { ...FULL_COVERAGE, coverageLevel: 'qualitative' as const }],
    ])('renders buildCoverageNote(...) verbatim for %s coverage', async (_label, coverage) => {
      mockGetReportingCoverage.mockResolvedValue({ ok: true, data: coverage })
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain(buildCoverageNote(coverage))
    })

    it('renders buildCoverageNote(null) verbatim when the coverage RPC itself errors', async () => {
      mockGetReportingCoverage.mockResolvedValue({ ok: false, error: 'coverage RPC failed' })
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain(buildCoverageNote(null))
    })
  })

  describe('per-actor rendering uses actorDisplayLabel, never the raw actor digest', () => {
    it('team_usage_report detailed format', async () => {
      mockGetToolUsage.mockResolvedValue({
        ok: true,
        data: usageData({ byActor: [{ actor: ACTOR_B, count: 12 }] }),
      })
      const input = teamUsageReportInputSchema.parse({ format: 'detailed' })
      const result = await executeTeamUsageReport(input, mockContext)

      expect(result).toContain(actorDisplayLabel(ACTOR_B))
      expect(result).not.toContain(`| ${ACTOR_B} | 12 |`)
    })

    it('usage_report detailed format', async () => {
      mockGetToolUsage.mockResolvedValue({
        ok: true,
        data: usageData({ byActor: [{ actor: ACTOR_B, count: 12 }] }),
      })
      const input = usageReportInputSchema.parse({ format: 'detailed' })
      const result = await executeUsageReport(input, mockContext)

      expect(result).toContain(actorDisplayLabel(ACTOR_B))
      expect(result).not.toContain(`| ${ACTOR_B} | 12 |`)
    })
  })

  describe('skill-invocation honesty line', () => {
    it('is present and carries no counts or table — just the static sentence', async () => {
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      const line =
        'Skill-invocation data: not yet captured for teams (Claude Code hook invocations are not team-attributed).'
      expect(result).toContain(line)
      // No adjacent table markers or digits directly on the honesty line itself.
      expect(line).not.toMatch(/\|/)
      expect(line).not.toMatch(/\d/)
    })
  })

  describe('emit-health disclosure ("This Session" — session-scoped, D-8)', () => {
    it('omits the block entirely when nothing was rejected or failed', async () => {
      mockGetTelemetryEmitStats.mockReturnValue({
        accepted: 3,
        rejected: 0,
        failed: 0,
        skippedNoIdentity: 0,
        lastRejectionReason: null,
      })
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).not.toContain('## This Session')
    })

    it.each([
      ['ambiguous_team', ['ambiguous_team', 'SKILLSMITH_LICENSE_KEY']],
      ['consent_required', ['consent_required', 'skillsmith login']],
      ['consent_denied', ['consent_denied', 'disabled for your account']],
    ])('maps lastRejectionReason %s to its remediation text', async (reason, expectedSnippets) => {
      mockGetTelemetryEmitStats.mockReturnValue({
        accepted: 3,
        rejected: 2,
        failed: 0,
        skippedNoIdentity: 0,
        lastRejectionReason: reason,
      })
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain('## This Session')
      for (const snippet of expectedSnippets) {
        expect(result).toContain(snippet)
      }
    })

    it('falls back to a generic undelivered-count message for an unmapped reason', async () => {
      mockGetTelemetryEmitStats.mockReturnValue({
        accepted: 3,
        rejected: 1,
        failed: 2,
        skippedNoIdentity: 0,
        lastRejectionReason: 'invalid_jwt',
      })
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain(
        '3 events could not be delivered this session (reason: invalid_jwt).'
      )
    })

    it('falls back to the generic message with reason "unknown" when failed>0 with no rejection reason', async () => {
      mockGetTelemetryEmitStats.mockReturnValue({
        accepted: 3,
        rejected: 0,
        failed: 1,
        skippedNoIdentity: 0,
        lastRejectionReason: null,
      })
      const input = teamAnalyticsDashboardInputSchema.parse({})
      const result = await executeTeamAnalyticsDashboard(input, mockContext)

      expect(result).toContain('1 events could not be delivered this session (reason: unknown).')
    })
  })

  // ==========================================================================
  // Team-scoping (SMI-6362 Wave 4 adversarial review)
  //
  // The security property the whole feature protects: one team must never see
  // another team's usage data. Two halves, both pinned here.
  //
  // (a) There is exactly ONE source of `teamId` — `resolveLicenseTeamId()`, via
  //     the single shared `resolveCloudAnalytics()`. No handler may grow its own
  //     team-resolution path (tool input, ToolContext, a direct env read), and
  //     none may hardcode a team. Asserted for all four tools against BOTH
  //     cloud calls, with a non-default resolved value so a hardcoded id fails.
  //
  // (b) A caller who resolves a team they are not actually a member of gets the
  //     boundary's own answer — zeros from analytics_tool_usage (SECURITY
  //     INVOKER, filtered by search_metrics_team_scoped_read, which keys on
  //     auth.uid()'s real team_members rows, not on p_team_id) and a zero-row
  //     coverage response (SECURITY DEFINER with its own auth.uid() membership
  //     check). That must render as honest zeros plus an explicit "unavailable"
  //     coverage line — never a fabricated figure, and never another team's data.
  // ==========================================================================
  describe('team scoping: resolveLicenseTeamId is the only source of teamId', () => {
    const ALL_TOOLS: Array<[string, () => Promise<string>]> = [
      [
        'team_analytics_dashboard',
        () =>
          executeTeamAnalyticsDashboard(teamAnalyticsDashboardInputSchema.parse({}), mockContext),
      ],
      [
        'team_usage_report',
        () => executeTeamUsageReport(teamUsageReportInputSchema.parse({}), mockContext),
      ],
      [
        'analytics_dashboard',
        () => executeAnalyticsDashboard(analyticsDashboardInputSchema.parse({}), mockContext),
      ],
      ['usage_report', () => executeUsageReport(usageReportInputSchema.parse({}), mockContext)],
    ]

    it.each(ALL_TOOLS)(
      '%s forwards the resolved teamId (not a hardcoded one) to both cloud calls',
      async (_name, run) => {
        mockResolveLicenseTeamId.mockResolvedValue('team-resolved-xyz')
        mockResolveUserAccessToken.mockResolvedValue('token-resolved-xyz')

        await run()

        expect(mockGetToolUsage).toHaveBeenCalledWith(
          expect.objectContaining({
            teamId: 'team-resolved-xyz',
            accessToken: 'token-resolved-xyz',
          })
        )
        expect(mockGetReportingCoverage).toHaveBeenCalledWith({
          teamId: 'team-resolved-xyz',
          accessToken: 'token-resolved-xyz',
        })
      }
    )

    it.each(ALL_TOOLS)(
      '%s re-resolves credentials per invocation — a later call never inherits an earlier one',
      async (_name, run) => {
        // Guards against memoizing resolveCloudAnalytics()/the service client at
        // module scope. getSupabaseUserClient() is deliberately not a singleton
        // for exactly this reason (supabase-client.ts); the handlers must not
        // reintroduce the caching one layer up.
        mockResolveLicenseTeamId.mockResolvedValue('team-first')
        mockResolveUserAccessToken.mockResolvedValue('token-first')
        await run()

        mockResolveLicenseTeamId.mockResolvedValue('team-second')
        mockResolveUserAccessToken.mockResolvedValue('token-second')
        await run()

        expect(mockResolveLicenseTeamId).toHaveBeenCalledTimes(2)
        expect(mockResolveUserAccessToken).toHaveBeenCalledTimes(2)
        expect(mockGetToolUsage.mock.calls[0][0]).toMatchObject({
          teamId: 'team-first',
          accessToken: 'token-first',
        })
        expect(mockGetToolUsage.mock.calls[1][0]).toMatchObject({
          teamId: 'team-second',
          accessToken: 'token-second',
        })
        expect(mockGetReportingCoverage.mock.calls[1][0]).toEqual({
          teamId: 'team-second',
          accessToken: 'token-second',
        })
      }
    )

    it.each(ALL_TOOLS)(
      '%s renders honest zeros and an unavailable-coverage line when the caller is not a member of the resolved team',
      async (_name, run) => {
        // Exactly what the Postgres-side boundary produces for a non-member:
        // an all-zero usage row, and zero coverage rows (mapped to ok:false).
        mockResolveLicenseTeamId.mockResolvedValue('team-the-caller-does-not-belong-to')
        mockGetToolUsage.mockResolvedValue({
          ok: true,
          data: {
            totalToolCalls: 0,
            uniqueTools: 0,
            topTools: [],
            dailyTrend: [],
            periodComparison: { current: 0, previous: 0, changePercent: 0 },
            byActor: [],
          },
        })
        mockGetReportingCoverage.mockResolvedValue({
          ok: false,
          error: 'Not a member of this team, or the team has no reporting data.',
        })

        const result = await run()

        // Honest "unavailable", never a fabricated coverage figure.
        expect(result).toContain(buildCoverageNote(null))
        expect(result).toContain('Team reporting-coverage figure is currently unavailable.')
        // No seat figures, and no other team's actors or tools.
        expect(result).not.toContain('seats reporting')
        expect(result).not.toContain('opted out')
        expect(result).not.toMatch(/\| \w+-\w+ \([0-9a-f]{12}\) \|/)
        // The diagnostic-only reason string never surfaces either.
        expect(result).not.toContain('small_sensitive_bucket')
        expect(result).not.toContain('split_bucket_too_small')
        // And the zero state is reported as zero, not hidden.
        expect(result).toMatch(/\*\*(Total tool calls|Unique tools)\*\*: 0|total_calls,0,0,0/)
      }
    )
  })
})
