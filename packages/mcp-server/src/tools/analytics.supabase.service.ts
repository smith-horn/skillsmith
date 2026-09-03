/**
 * @fileoverview Supabase-backed analytics service — cloud read path for Team/Enterprise tiers
 * @module @skillsmith/mcp-server/tools/analytics.supabase.service
 * @see SMI-5015: W1.S3 — MCP read path for skill-invoke analytics RPCs
 * @see SMI-6362 Wave 4 — D-2c (user-bound client, no SECURITY DEFINER bypass), D-2e (reporting
 *   coverage / k-anonymity), D-9 (self-attestation disclosure)
 *
 * Five RPCs are called against the cloud `search_metrics` table:
 *  - analytics_skill_top              → topSkills panel
 *  - analytics_skill_stale            → staleSkills panel
 *  - analytics_skill_cooccurrence     → co-occurrence panel
 *  - analytics_tool_usage             → AnalyticsData/UsageReportData (D-2c)
 *  - analytics_team_reporting_coverage → TeamReportingCoverage (D-2e)
 *
 * Error handling: methods NEVER throw — errors are returned as a typed
 * error envelope `{ ok: false; error: string }` so callers can branch
 * without try/catch. Success results carry `{ ok: true; data: <panel> }`.
 *
 * RPC params use PostgreSQL snake_case names (p_team_id, p_window_days,
 * p_threshold) matching the function signatures in the migration.
 *
 * Client (D-2c): every method below builds its client via `getSupabaseUserClient(accessToken)`,
 * never the anon-key singleton. All five RPCs are `REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO
 * authenticated` and require a real user's JWT — `p_team_id` is a filter, never an authorization
 * check, so a caller-supplied team id alone must never be sufficient to read that team's data.
 * This file deliberately does NOT special-case "no access token" — that's the caller's job (a
 * different file, analytics.ts) to check before ever calling into this service.
 */

import { getSupabaseUserClient } from '../supabase-client.js'
import type { UsageReportData } from './analytics.service.js'
import type {
  RpcTopRow,
  RpcStaleRow,
  RpcCooccurrenceRow,
  RpcToolUsageRow,
  RpcReportingCoverageRow,
} from './analytics.supabase.service.helpers.js'

export {
  COVERAGE_K,
  buildCoverageNote,
  nicknameFromActor,
  actorDisplayLabel,
} from './analytics.supabase.service.helpers.js'

// ============================================================================
// Panel response types (per M6 spec in skill-invoke-telemetry.md §4)
// ============================================================================

export interface TopSkillRow {
  skill_name: string
  /** skill_name doubles as skill_id — RPCs don't return a separate id column */
  skill_id: string
  invocation_count: number
  distinct_developers: number
  /** -1.0 to +Infinity; null when no prior window data */
  week_over_week_delta: number | null
  framework_breakdown: Record<string, number>
}

export interface TopSkillsPanel {
  panel: 'topSkills'
  window: '7d' | '30d' | '90d'
  rows: TopSkillRow[]
  /** total rows where framework_breakdown has an 'unknown' key */
  unattributed_count: number
  coverage_note: string
}

export interface StaleSkillRow {
  skill_name: string
  /** skill_name doubles as skill_id — RPCs don't return a separate id column */
  skill_id: string
  /** ISO timestamp — null when skill has never been invoked */
  last_invoked: string | null
  invocation_count: number
  /** installed_at not returned by RPC; null in v1 */
  installed_at: string | null
  recommend_action: 'uninstall' | 'review'
}

export interface StaleSkillsPanel {
  panel: 'staleSkills'
  window: '90d'
  threshold: number
  rows: StaleSkillRow[]
}

export interface CooccurrenceRow {
  skill_a: string
  skill_b: string
  cooccurrence_count: number
}

export interface CooccurrencePanel {
  panel: 'cooccurrence'
  window_days: number
  rows: CooccurrenceRow[]
}

/**
 * Mapped result of `analytics_team_reporting_coverage` (D-2e). Deliberately does NOT carry
 * `suppression_reason` — that RPC column is diagnostic-only and must never reach a renderer, so it
 * is dropped at the mapping boundary in {@link SupabaseAnalyticsService.getReportingCoverage}
 * rather than merely being ignored by callers.
 */
export interface TeamReportingCoverage {
  coverageLevel: 'full' | 'aggregate' | 'qualitative'
  totalSeats: number | null
  reportingSeats: number | null
  nonReportingSeats: number | null
  optedOutSeats: number | null
  undecidedSeats: number | null
  activeActorsInWindow: number | null
  suppressed: boolean
}

// ============================================================================
// Result envelope
// ============================================================================

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: string }

// Raw Supabase RPC row shapes (RpcTopRow / RpcStaleRow / RpcCooccurrenceRow / RpcToolUsageRow /
// RpcReportingCoverageRow) live in analytics.supabase.service.helpers.ts to stay under this
// file's 500-line CI gate — imported as types above.

// ============================================================================
// Input option types
// ============================================================================

export interface GetTopSkillsOpts {
  teamId: string
  accessToken: string
  window: '7d' | '30d' | '90d'
  limit?: number
}

export interface GetStaleSkillsOpts {
  teamId: string
  accessToken: string
  thresholdInvocations: number
  windowDays: number
}

export interface GetCooccurrenceOpts {
  teamId: string
  accessToken: string
  windowDays: number
  minCount?: number
}

export interface GetToolUsageOpts {
  teamId: string
  accessToken: string
  windowDays: number
}

export interface GetReportingCoverageOpts {
  teamId: string
  accessToken: string
}

// ============================================================================
// Coverage note (shared across all callers of topSkills)
// ============================================================================

/**
 * Renamed from `COVERAGE_NOTE` (SMI-6362 Wave 4) — this is the ORIGINAL v1 skill-invoke coverage
 * note, scoped to `getTopSkills()`'s `TopSkillsPanel.coverage_note` field only. Out of scope this
 * wave; unchanged behavior, name only. The NEW tool-call coverage disclosure for the four
 * Team/Enterprise analytics MCP tools is `buildCoverageNote()`, re-exported above from
 * analytics.supabase.service.helpers.ts.
 */
const LEGACY_SKILL_COVERAGE_NOTE =
  'v1 captures Claude Code invocations + Skillsmith MCP tool calls. ' +
  'Context-injection skills (Cursor, Copilot, Codex) not yet captured.'

// ============================================================================
// Window string → days
// ============================================================================

const WINDOW_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 }

function toNumber(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v
}

/**
 * Defensive numeric coercion for RPC output (SMI-6362 Wave 4). PostgREST commonly serializes
 * BIGINT as a JSON number when it fits in a safe integer, but treats every numeric RPC output
 * defensively — a bigint or a numeric string both coerce cleanly.
 */
function toNum(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : (v as number)
}

// ============================================================================
// Minimal RPC client shape (cast target for getSupabaseUserClient()'s `unknown` return)
// ============================================================================

type RpcClient = {
  rpc(
    fn: string,
    params: Record<string, unknown>
  ): Promise<{ data: unknown; error: { message: string } | null }>
}

// ============================================================================
// Service class
// ============================================================================

export class SupabaseAnalyticsService {
  /**
   * Build a user-bound RPC client for `accessToken` (D-2c). Shared by every method below instead
   * of each repeating its own try/catch — never falls back to the anon-key singleton, and never
   * throws (a construction failure becomes a `{ ok: false }` envelope like every other error
   * path).
   */
  private async client(
    accessToken: string
  ): Promise<{ ok: true; client: RpcClient } | { ok: false; error: string }> {
    try {
      const client = (await getSupabaseUserClient(accessToken)) as RpcClient
      return { ok: true, client }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Top skills by invocation count for a team within a rolling window.
   * Calls `analytics_skill_top(p_team_id, p_window_days)`.
   */
  async getTopSkills(opts: GetTopSkillsOpts): Promise<ServiceResult<TopSkillsPanel>> {
    const windowDays = WINDOW_DAYS[opts.window]

    const bound = await this.client(opts.accessToken)
    if (!bound.ok) return bound
    const { client: supabase } = bound

    const { data, error } = await supabase.rpc('analytics_skill_top', {
      p_team_id: opts.teamId,
      p_window_days: windowDays,
    })

    if (error) {
      return { ok: false, error: `analytics_skill_top RPC failed: ${error.message}` }
    }

    const rawRows = (data ?? []) as RpcTopRow[]
    let unattributed = 0

    const rows: TopSkillRow[] = rawRows.map((r) => {
      const breakdown: Record<string, number> = {}
      for (const [k, v] of Object.entries(r.framework_breakdown ?? {})) {
        breakdown[k] = typeof v === 'number' ? v : Number(v)
      }
      if ('unknown' in breakdown) unattributed++
      const delta = r.week_over_week_delta !== null ? Number(r.week_over_week_delta) : null
      return {
        skill_name: r.skill_name,
        skill_id: r.skill_name,
        invocation_count: toNumber(r.invocation_count),
        distinct_developers: toNumber(r.distinct_developers),
        week_over_week_delta: delta,
        framework_breakdown: breakdown,
      }
    })

    const limited = opts.limit !== undefined ? rows.slice(0, opts.limit) : rows

    return {
      ok: true,
      data: {
        panel: 'topSkills',
        window: opts.window,
        rows: limited,
        unattributed_count: unattributed,
        coverage_note: LEGACY_SKILL_COVERAGE_NOTE,
      },
    }
  }

  /**
   * Skills installed but invoked fewer than threshold times in the window.
   * Calls `analytics_skill_stale(p_team_id, p_window_days, p_threshold)`.
   */
  async getStaleSkills(opts: GetStaleSkillsOpts): Promise<ServiceResult<StaleSkillsPanel>> {
    const bound = await this.client(opts.accessToken)
    if (!bound.ok) return bound
    const { client: supabase } = bound

    const { data, error } = await supabase.rpc('analytics_skill_stale', {
      p_team_id: opts.teamId,
      p_window_days: opts.windowDays,
      p_threshold: opts.thresholdInvocations,
    })

    if (error) {
      return { ok: false, error: `analytics_skill_stale RPC failed: ${error.message}` }
    }

    const rawRows = (data ?? []) as RpcStaleRow[]

    const rows: StaleSkillRow[] = rawRows.map((r) => {
      const count = toNumber(r.invocation_count)
      return {
        skill_name: r.skill_name,
        skill_id: r.skill_name,
        last_invoked: r.last_invoked ?? null,
        invocation_count: count,
        // installed_at not returned by RPC in v1 — set null
        installed_at: null,
        recommend_action: count === 0 ? 'uninstall' : 'review',
      }
    })

    return {
      ok: true,
      data: {
        panel: 'staleSkills',
        window: '90d',
        threshold: opts.thresholdInvocations,
        rows,
      },
    }
  }

  /**
   * Skill co-occurrence pairs invoked within the same session.
   * Calls `analytics_skill_cooccurrence(p_team_id, p_window_days)`.
   * Client-side `minCount` filter applied post-RPC (RPC has no threshold param).
   */
  async getCooccurrence(opts: GetCooccurrenceOpts): Promise<ServiceResult<CooccurrencePanel>> {
    const bound = await this.client(opts.accessToken)
    if (!bound.ok) return bound
    const { client: supabase } = bound

    const { data, error } = await supabase.rpc('analytics_skill_cooccurrence', {
      p_team_id: opts.teamId,
      p_window_days: opts.windowDays,
    })

    if (error) {
      return { ok: false, error: `analytics_skill_cooccurrence RPC failed: ${error.message}` }
    }

    const rawRows = (data ?? []) as RpcCooccurrenceRow[]
    const minCount = opts.minCount ?? 1

    const rows: CooccurrenceRow[] = rawRows
      .map((r) => ({
        skill_a: r.skill_a,
        skill_b: r.skill_b,
        cooccurrence_count: toNumber(r.cooccurrence_count),
      }))
      .filter((r) => r.cooccurrence_count >= minCount)

    return {
      ok: true,
      data: {
        panel: 'cooccurrence',
        window_days: opts.windowDays,
        rows,
      },
    }
  }

  /**
   * Team tool-call usage for a rolling window — the AnalyticsData/UsageReportData shape shared
   * with the local SQLite-backed service (analytics.service.ts). Calls
   * `analytics_tool_usage(p_team_id, p_window_days)`.
   */
  async getToolUsage(opts: GetToolUsageOpts): Promise<ServiceResult<UsageReportData>> {
    const bound = await this.client(opts.accessToken)
    if (!bound.ok) return bound
    const { client: supabase } = bound

    const { data, error } = await supabase.rpc('analytics_tool_usage', {
      p_team_id: opts.teamId,
      p_window_days: opts.windowDays,
    })

    if (error) {
      return { ok: false, error: `analytics_tool_usage RPC failed: ${error.message}` }
    }

    const row = ((data ?? []) as RpcToolUsageRow[])[0]
    if (!row) {
      return {
        ok: true,
        data: {
          totalToolCalls: 0,
          uniqueTools: 0,
          topTools: [],
          dailyTrend: [],
          periodComparison: { current: 0, previous: 0, changePercent: 0 },
          byActor: [],
        },
      }
    }

    const current = toNum(row.total_calls)
    const previous = toNum(row.previous_period_total)
    const changePercent = previous > 0 ? Math.round(((current - previous) / previous) * 100) : 0

    return {
      ok: true,
      data: {
        totalToolCalls: current,
        uniqueTools: toNum(row.unique_tools),
        topTools: (row.top_tools ?? []).map((t) => ({ tool: t.tool, count: toNum(t.count) })),
        dailyTrend: (row.daily_trend ?? []).map((t) => ({ date: t.date, count: toNum(t.count) })),
        periodComparison: { current, previous, changePercent },
        byActor: (row.by_actor ?? []).map((a) => ({ actor: a.actor, count: toNum(a.count) })),
      },
    }
  }

  /**
   * Team reporting-coverage figure (D-2e) — how much of the team's usage data is actually
   * captured, k-anonymized to avoid identifying individual opt-out/undecided seats. Calls
   * `analytics_team_reporting_coverage(p_team_id)`.
   *
   * The RPC returns exactly one row for a team member, zero rows for a non-member (never an
   * error) — a zero-row result is mapped here to `{ ok: false }` rather than a fabricated coverage
   * level.
   */
  async getReportingCoverage(
    opts: GetReportingCoverageOpts
  ): Promise<ServiceResult<TeamReportingCoverage>> {
    const bound = await this.client(opts.accessToken)
    if (!bound.ok) return bound
    const { client: supabase } = bound

    const { data, error } = await supabase.rpc('analytics_team_reporting_coverage', {
      p_team_id: opts.teamId,
    })

    if (error) {
      return {
        ok: false,
        error: `analytics_team_reporting_coverage RPC failed: ${error.message}`,
      }
    }

    const row = ((data ?? []) as RpcReportingCoverageRow[])[0]
    if (!row) {
      return {
        ok: false,
        error: 'Not a member of this team, or the team has no reporting data.',
      }
    }

    // `row.suppression_reason` is deliberately never read here (D-2e) — it must never reach a
    // renderer, so it is dropped at this exact boundary rather than merely unused downstream.
    return {
      ok: true,
      data: {
        coverageLevel: row.coverage_level,
        totalSeats: row.total_seats,
        reportingSeats: row.reporting_seats,
        nonReportingSeats: row.non_reporting_seats,
        optedOutSeats: row.opted_out_seats,
        undecidedSeats: row.undecided_seats,
        activeActorsInWindow: row.active_actors_in_window,
        suppressed: row.suppressed,
      },
    }
  }
}
