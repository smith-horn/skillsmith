/**
 * @fileoverview Supabase-backed analytics service — cloud read path for Team/Enterprise tiers
 * @module @skillsmith/mcp-server/tools/analytics.supabase.service
 * @see SMI-5015: W1.S3 — MCP read path for skill-invoke analytics RPCs
 *
 * Three RPCs are called against the cloud `search_metrics` table:
 *  - analytics_skill_top     → topSkills panel
 *  - analytics_skill_stale   → staleSkills panel
 *  - analytics_skill_cooccurrence → co-occurrence panel
 *
 * Error handling: methods NEVER throw — errors are returned as a typed
 * error envelope `{ ok: false; error: string }` so callers can branch
 * without try/catch. Success results carry `{ ok: true; data: <panel> }`.
 *
 * RPC params use PostgreSQL snake_case names (p_team_id, p_window_days,
 * p_threshold) matching the function signatures in the migration.
 */

import { getSupabaseClient } from '../supabase-client.js'

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

// ============================================================================
// Result envelope
// ============================================================================

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: string }

// ============================================================================
// Supabase RPC row shapes (raw returns from @supabase/supabase-js)
// ============================================================================

interface RpcTopRow {
  skill_name: string
  invocation_count: bigint | number
  distinct_developers: bigint | number
  week_over_week_delta: string | number | null
  framework_breakdown: Record<string, number> | null
}

interface RpcStaleRow {
  skill_name: string
  last_invoked: string | null
  invocation_count: bigint | number
}

interface RpcCooccurrenceRow {
  skill_a: string
  skill_b: string
  cooccurrence_count: bigint | number
}

// ============================================================================
// Input option types
// ============================================================================

export interface GetTopSkillsOpts {
  teamId: string
  window: '7d' | '30d' | '90d'
  limit?: number
}

export interface GetStaleSkillsOpts {
  teamId: string
  thresholdInvocations: number
  windowDays: number
}

export interface GetCooccurrenceOpts {
  teamId: string
  windowDays: number
  minCount?: number
}

// ============================================================================
// Coverage note (shared across all callers of topSkills)
// ============================================================================

const COVERAGE_NOTE =
  'v1 captures Claude Code invocations + Skillsmith MCP tool calls. ' +
  'Context-injection skills (Cursor, Copilot, Codex) not yet captured.'

// ============================================================================
// Window string → days
// ============================================================================

const WINDOW_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 }

function toNumber(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v
}

// ============================================================================
// Service class
// ============================================================================

export class SupabaseAnalyticsService {
  /**
   * Top skills by invocation count for a team within a rolling window.
   * Calls `analytics_skill_top(p_team_id, p_window_days)`.
   */
  async getTopSkills(opts: GetTopSkillsOpts): Promise<ServiceResult<TopSkillsPanel>> {
    const windowDays = WINDOW_DAYS[opts.window]

    let client: Awaited<ReturnType<typeof getSupabaseClient>>
    try {
      client = await getSupabaseClient()
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const supabase = client as {
      rpc(
        fn: string,
        params: Record<string, unknown>
      ): Promise<{ data: unknown; error: { message: string } | null }>
    }

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
        coverage_note: COVERAGE_NOTE,
      },
    }
  }

  /**
   * Skills installed but invoked fewer than threshold times in the window.
   * Calls `analytics_skill_stale(p_team_id, p_window_days, p_threshold)`.
   */
  async getStaleSkills(opts: GetStaleSkillsOpts): Promise<ServiceResult<StaleSkillsPanel>> {
    let client: Awaited<ReturnType<typeof getSupabaseClient>>
    try {
      client = await getSupabaseClient()
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const supabase = client as {
      rpc(
        fn: string,
        params: Record<string, unknown>
      ): Promise<{ data: unknown; error: { message: string } | null }>
    }

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
    let client: Awaited<ReturnType<typeof getSupabaseClient>>
    try {
      client = await getSupabaseClient()
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const supabase = client as {
      rpc(
        fn: string,
        params: Record<string, unknown>
      ): Promise<{ data: unknown; error: { message: string } | null }>
    }

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
}
