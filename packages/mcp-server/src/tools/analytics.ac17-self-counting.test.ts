/**
 * @fileoverview AC-17 — analytics tools' own tool_call self-counting ordering.
 * @see docs/internal/implementation/smi-6362-cloud-usage-analytics.md, AC-17: "Calling
 *   team_analytics_dashboard emits its own tool_call event, but after the read completes
 *   (withTelemetry emits in a finally block), so a call never appears in its own output.
 *   Assert: the analytics tool's own call is absent from invocation k and present in
 *   invocation k+1."
 *
 * Sibling to analytics.test.ts (500-line file gate — analytics.test.ts is already at its
 * budget) rather than an addition there. This file ALSO deliberately does NOT reuse
 * analytics.test.ts's `vi.mock('@skillsmith/core', ...)` — that mock only intercepts the
 * `@skillsmith/core` barrel specifier, which the wrapped handlers never use for
 * `withTelemetry` itself (`analytics.actions.ts` imports `withTelemetry` from the separate
 * `@skillsmith/core/telemetry` subpath). AC-17 is specifically a property of the REAL
 * `withTelemetry` finally-block ordering, so this file leaves `@skillsmith/core` and
 * `@skillsmith/core/telemetry` completely unmocked and drives the real emission gate +
 * tool-name context, exactly as `call-tool-handler.ts` does in production.
 *
 * How the ordering is observed without a live search_metrics table: `emitToolCallEvent`'s
 * REAL implementation (no identity provider installed here, matching a Community/local dev
 * environment) short-circuits before any network call but still increments its own real,
 * process-global `skippedNoIdentity` counter (`getTelemetryEmitStats()`, unmocked) — and it
 * does so from inside `withTelemetry`'s `finally` block, i.e. strictly AFTER `handler(...)`
 * (which calls the mocked `getToolUsage`) has already resolved. The mocked `getToolUsage`
 * below reads that same real counter LIVE, at call time, and returns it as `totalToolCalls`.
 * This turns the counter into a faithful proxy for "how many prior invocations have already
 * completed their own self-emit" — precisely the quantity AC-17 requires stay one invocation
 * behind the tool's own reads. This is not a simulation of the ordering; it exercises the
 * real `withTelemetry` code path and observes its real side effect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ToolContext } from '../context.js'
import { setEmissionGate, runWithToolNameContext } from '@skillsmith/core/telemetry'
// `getTelemetryEmitStats` lives in `@skillsmith/core`'s main barrel (re-exported
// from `audit/remote-audit.js`), NOT the `/telemetry` subpath above — unlike
// analytics.test.ts, this file does not mock `@skillsmith/core` at all, so this
// import resolves to the real implementation.
import { getTelemetryEmitStats } from '@skillsmith/core'

// ============================================================================
// Mocks — credential resolution + the Supabase analytics service only.
// `@skillsmith/core` / `@skillsmith/core/telemetry` are intentionally real.
// ============================================================================

const mockResolveUserAccessToken = vi.fn()
const mockResolveLicenseTeamId = vi.fn()

vi.mock('./team-resolver.js', () => ({
  resolveUserAccessToken: (...args: unknown[]) => mockResolveUserAccessToken(...args),
  resolveLicenseTeamId: (...args: unknown[]) => mockResolveLicenseTeamId(...args),
}))

const mockGetReportingCoverage = vi.fn()

vi.mock('./analytics.supabase.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./analytics.supabase.service.js')>()
  return {
    ...actual,
    // Must be a regular function (not arrow) so `new SupabaseAnalyticsService()` works.
    SupabaseAnalyticsService: function MockSupabaseAnalyticsService() {
      return {
        // The live proxy described in the module doc comment: read the REAL
        // skippedNoIdentity counter at call time, not a value fixed up-front.
        getToolUsage: () =>
          Promise.resolve({
            ok: true,
            data: {
              totalToolCalls: getTelemetryEmitStats().skippedNoIdentity,
              uniqueTools: 1,
              topTools: [{ tool: 'team_analytics_dashboard', count: 1 }],
              dailyTrend: [],
              periodComparison: { current: 0, previous: 0, changePercent: 0 },
              byActor: [],
            },
          }),
        getReportingCoverage: (...args: unknown[]) => mockGetReportingCoverage(...args),
      }
    },
  }
})

// ============================================================================
// Imports after mocks
// ============================================================================

import { executeTeamAnalyticsDashboard, teamAnalyticsDashboardInputSchema } from './analytics.js'

const mockContext = {} as ToolContext

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveUserAccessToken.mockResolvedValue('token-abc')
  mockResolveLicenseTeamId.mockResolvedValue('team-123')
  mockGetReportingCoverage.mockResolvedValue({
    ok: true,
    data: {
      coverageLevel: 'full' as const,
      totalSeats: 10,
      reportingSeats: 8,
      nonReportingSeats: 2,
      optedOutSeats: 1,
      undecidedSeats: 1,
      activeActorsInWindow: 6,
      suppressed: false,
    },
  })
  // Real emission gate + no identity provider installed (default null) — every
  // emitToolCallEvent call short-circuits via skippedNoIdentity++ rather than
  // attempting a real network POST, matching how this proxy is designed to be
  // observed (see module doc comment).
  setEmissionGate(() => true)
})

afterEach(() => {
  setEmissionGate(undefined)
})

/** Extracts the `- **Total tool calls**: N` figure a rendered response reports. */
function totalToolCallsIn(markdown: string): number {
  const match = markdown.match(/\*\*Total tool calls\*\*: (\d+)/)
  expect(match).not.toBeNull()
  return Number(match![1])
}

async function invoke(): Promise<string> {
  const input = teamAnalyticsDashboardInputSchema.parse({})
  // Mirrors call-tool-handler.ts's real dispatch-level context install — without
  // this, emitToolCallEvent's toolName guard skips the second sink entirely and
  // the counter would never move, which would make this test's premise false
  // rather than merely unproven.
  return runWithToolNameContext('team_analytics_dashboard', () =>
    executeTeamAnalyticsDashboard(input, mockContext)
  )
}

describe('AC-17: team_analytics_dashboard self-counting is correct and non-recursive', () => {
  // `skippedNoIdentity` is real, process-global module state (no public
  // `_resetTelemetryEmitStatsForTests` export reaches this package) — it is
  // NOT reset between `it` blocks in this file. Every assertion below is
  // therefore expressed as a DELTA from a `before` snapshot taken at the
  // start of each test, not an absolute value; that also makes each test
  // robust to running in isolation or as part of the full suite.

  it('an invocation never sees its own call in its own results (reads the count as of BEFORE its own emit)', async () => {
    const before = getTelemetryEmitStats().skippedNoIdentity
    const result = await invoke()
    expect(totalToolCallsIn(result)).toBe(before)
  })

  it("a call's own self-emitted event appears starting the NEXT invocation, not before", async () => {
    const before = getTelemetryEmitStats().skippedNoIdentity
    const result1 = await invoke()
    const result2 = await invoke()

    // Invocation 1 reads before its own emit landed — sees the pre-existing count.
    expect(totalToolCallsIn(result1)).toBe(before)
    // Invocation 2 reads after invocation 1's finally-block emit landed —
    // sees exactly one more (invocation 1's own call), never its own (which
    // hasn't landed yet either).
    expect(totalToolCallsIn(result2)).toBe(before + 1)
  })

  it('the pattern holds across three consecutive invocations — always exactly one behind', async () => {
    const before = getTelemetryEmitStats().skippedNoIdentity
    const results = [await invoke(), await invoke(), await invoke()]
    const counts = results.map(totalToolCallsIn)

    // Invocation k's own reported count is `before + (k-1)`: it reflects
    // every PRIOR invocation's self-emit, and never its own.
    expect(counts).toEqual([before, before + 1, before + 2])

    // The real emit-stats counter itself has advanced by exactly 3 (one
    // skippedNoIdentity increment per completed invocation's finally block)
    // — confirms the emits actually happened and this isn't a test that
    // trivially passes because the second sink was silently never reached.
    expect(getTelemetryEmitStats().skippedNoIdentity).toBe(before + 3)
  })

  it('without the dispatch-level tool-name context, the second sink never fires — the counter stays flat (negative control)', async () => {
    // Guards the guard: proves the counts above genuinely come from the
    // second sink firing, not from some unrelated source. Calling WITHOUT
    // runWithToolNameContext must never increment skippedNoIdentity — the
    // exact `if (toolNameStorage.getStore() !== undefined)` guard in wrap.ts.
    const input = teamAnalyticsDashboardInputSchema.parse({})
    const before = getTelemetryEmitStats().skippedNoIdentity
    await executeTeamAnalyticsDashboard(input, mockContext)
    await executeTeamAnalyticsDashboard(input, mockContext)
    expect(getTelemetryEmitStats().skippedNoIdentity).toBe(before)
  })
})
