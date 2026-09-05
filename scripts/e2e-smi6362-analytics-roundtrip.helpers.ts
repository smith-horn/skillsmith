/**
 * e2e-smi6362-analytics-roundtrip.helpers.ts
 *
 * SMI-6362 — HTTP/RPC/sign-in helpers for e2e-smi6362-analytics-roundtrip.ts,
 * split out to stay under the 500-line file-length gate (audit:standards).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import {
  ALL_TEAMS,
  computeExpectedCoverage,
  teamAllMembers,
} from './e2e-smi6362-analytics-fixtures.js'

export interface ActorSession {
  userId: string
  accessToken: string
}

/** Signs in against the STAGING anon client and returns a real access token (JWT). */
export async function signIn(
  url: string,
  anonKey: string,
  email: string,
  password: string
): Promise<ActorSession> {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.session) {
    console.error(`[SMI-6362 e2e] Sign-in failed for ${email}: ${error?.message ?? 'no session'}`)
    process.exit(1)
  }
  return { userId: data.session.user.id, accessToken: data.session.access_token }
}

/** A fresh, valid `anonymous_id` (required on every /events POST regardless of lane). */
export function freshAnonymousId(): string {
  return randomUUID()
}

export interface EventPostResult {
  status: number
  accepted: string | null
  rejected: string | null
  reason: string | null
  body: { ok?: boolean; accepted?: number; rejected?: number; errors?: unknown[] }
}

/**
 * Raw fetch against POST /functions/v1/events — deliberately NOT going
 * through the MCP server's withTelemetry wrapper, so the test can inspect the
 * raw X-Skillsmith-Telemetry-* response headers row-builder.ts stamps.
 */
export async function postEvent(
  eventsUrl: string,
  body: unknown,
  headers: Record<string, string>
): Promise<EventPostResult> {
  const res = await fetch(eventsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  let json: EventPostResult['body'] = {}
  try {
    json = (await res.json()) as EventPostResult['body']
  } catch {
    json = {}
  }
  return {
    status: res.status,
    accepted: res.headers.get('X-Skillsmith-Telemetry-Accepted'),
    rejected: res.headers.get('X-Skillsmith-Telemetry-Rejected'),
    reason: res.headers.get('X-Skillsmith-Telemetry-Reason'),
    body: json,
  }
}

export interface SearchMetricsRow {
  actor: string
  event_type: string
  metadata: Record<string, unknown>
  created_at: string
}

/**
 * Service-role read of search_metrics filtered by event_type + one JSONB
 * metadata key (PostgREST `->>'` column-path filter syntax, e.g.
 * `.eq('metadata->>tool_name', 'x')`), scoped to rows created at/after
 * `sinceIso`. A small bounded retry (read-after-write on the same primary —
 * not expected to need it, but cheap insurance against any read-path lag).
 */
export async function queryEventRows(
  admin: SupabaseClient,
  opts: { eventType: string; metadataKey: string; metadataValue: string; sinceIso: string }
): Promise<SearchMetricsRow[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await admin
      .from('search_metrics')
      .select('actor,event_type,metadata,created_at')
      .eq('event_type', opts.eventType)
      .eq(`metadata->>${opts.metadataKey}`, opts.metadataValue)
      .gte('created_at', opts.sinceIso)
      .order('created_at', { ascending: true })
    if (error) {
      console.error(`[SMI-6362 e2e] search_metrics query failed: ${error.message}`)
      process.exit(1)
    }
    if ((data ?? []).length > 0 || attempt === 2) return (data ?? []) as SearchMetricsRow[]
    await new Promise((r) => setTimeout(r, 300))
  }
  return []
}

/** Builds a Supabase client bound to a specific user's JWT — same construction as getSupabaseUserClient(). */
export function userClient(url: string, anonKey: string, accessToken: string): SupabaseClient {
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export interface RpcToolUsageRow {
  total_calls: number | string
  unique_tools: number | string
  top_tools: { tool: string; count: number | string }[]
  daily_trend: { date: string; count: number | string }[]
  previous_period_total: number | string
  by_actor: { actor: string; count: number | string }[]
}

export async function callToolUsageRpc(
  url: string,
  anonKey: string,
  accessToken: string,
  teamId: string,
  windowDays: number
): Promise<RpcToolUsageRow> {
  const client = userClient(url, anonKey, accessToken)
  const { data, error } = await client.rpc('analytics_tool_usage', {
    p_team_id: teamId,
    p_window_days: windowDays,
  })
  if (error) {
    console.error(`[SMI-6362 e2e] analytics_tool_usage RPC failed: ${error.message}`)
    process.exit(1)
  }
  const rows = (data ?? []) as RpcToolUsageRow[]
  if (rows.length !== 1) {
    console.error(
      `[SMI-6362 e2e] analytics_tool_usage returned ${rows.length} rows, expected exactly 1`
    )
    process.exit(1)
  }
  return rows[0]
}

export interface RpcCoverageRow {
  coverage_level: 'full' | 'aggregate' | 'qualitative'
  total_seats: number | null
  reporting_seats: number | null
  non_reporting_seats: number | null
  opted_out_seats: number | null
  undecided_seats: number | null
  active_actors_in_window: number | null
}

export async function callCoverageRpc(
  url: string,
  anonKey: string,
  accessToken: string,
  teamId: string
): Promise<RpcCoverageRow> {
  const client = userClient(url, anonKey, accessToken)
  const { data, error } = await client.rpc('analytics_team_reporting_coverage', {
    p_team_id: teamId,
  })
  if (error) {
    console.error(`[SMI-6362 e2e] analytics_team_reporting_coverage RPC failed: ${error.message}`)
    process.exit(1)
  }
  const rows = (data ?? []) as RpcCoverageRow[]
  if (rows.length !== 1) {
    console.error(
      `[SMI-6362 e2e] analytics_team_reporting_coverage returned ${rows.length} rows, expected exactly 1`
    )
    process.exit(1)
  }
  return rows[0]
}

export interface CoverageCtx {
  a1: ActorSession
  b1: ActorSession
  e1: ActorSession
  teamIds: Map<string, string>
}

/**
 * AC13/AC14: coverage k-anonymity assertions, split out of
 * e2e-smi6362-analytics-roundtrip.ts to stay under the 500-line gate.
 * `record` is injected rather than imported back from roundtrip.ts, since
 * that file imports THIS one (a reverse import would be circular).
 */
export async function runCoverageAssertions(
  url: string,
  anonKey: string,
  ctx: CoverageCtx,
  record: (name: string, pass: boolean, detail?: string) => void
): Promise<void> {
  const callers: Record<string, ActorSession> = {
    GEN_A: ctx.a1,
    GEN_B: ctx.b1,
    COV_4_0: ctx.e1,
    COV_5_0: ctx.e1,
    COV_5_1: ctx.e1,
    COV_10_5A: ctx.e1,
    COV_10_5B: ctx.e1,
  }

  const actual = new Map<string, Awaited<ReturnType<typeof callCoverageRpc>>>()
  for (const team of ALL_TEAMS) {
    const teamId = ctx.teamIds.get(team.key)!
    const caller = callers[team.key]
    const expected = computeExpectedCoverage(teamAllMembers(team))
    const got = await callCoverageRpc(url, anonKey, caller.accessToken, teamId)
    actual.set(team.key, got)

    const numericMatch =
      expected.level === 'full'
        ? got.total_seats === expected.totalSeats &&
          got.reporting_seats === expected.reportingSeats &&
          got.non_reporting_seats === expected.nonReportingSeats &&
          got.opted_out_seats === expected.optedOutSeats &&
          got.undecided_seats === expected.undecidedSeats
        : expected.level === 'aggregate'
          ? got.total_seats === expected.totalSeats &&
            got.reporting_seats === expected.reportingSeats &&
            got.non_reporting_seats === expected.nonReportingSeats &&
            got.opted_out_seats === null &&
            got.undecided_seats === null
          : got.total_seats === null &&
            got.reporting_seats === null &&
            got.non_reporting_seats === null &&
            got.opted_out_seats === null &&
            got.undecided_seats === null

    record(
      `AC13 ${team.key} coverage_level=${expected.level} with exact expected columns`,
      got.coverage_level === expected.level && numericMatch,
      JSON.stringify({ expected, got })
    )
  }

  // AC14: COV_4_0 and COV_5_1 (both qualitative) must render identically in
  // "no numbers leak" terms — same set of null numeric columns, both suppressed.
  const cov40 = actual.get('COV_4_0')!
  const cov51 = actual.get('COV_5_1')!
  const nullShape = (r: {
    total_seats: unknown
    reporting_seats: unknown
    non_reporting_seats: unknown
    opted_out_seats: unknown
    undecided_seats: unknown
  }) =>
    JSON.stringify([
      r.total_seats,
      r.reporting_seats,
      r.non_reporting_seats,
      r.opted_out_seats,
      r.undecided_seats,
    ])
  record(
    'AC14 COV_4_0 and COV_5_1 both qualitative with identical all-null numeric shape',
    cov40.coverage_level === 'qualitative' &&
      cov51.coverage_level === 'qualitative' &&
      nullShape(cov40) === nullShape(cov51) &&
      nullShape(cov40) === JSON.stringify([null, null, null, null, null]),
    JSON.stringify({ cov40, cov51 })
  )
}
