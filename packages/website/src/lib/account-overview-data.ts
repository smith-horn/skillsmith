/**
 * Team Overview (formerly Team Dashboard, now mounted at /account) data
 * loading + gate branching (M7, Decision #4/C1).
 *
 * Extracted out of account/index.astro's inline client script to keep the
 * rewritten page under the repo's 500-line-per-file standard, and so the
 * gate-redirect branching and entitlement signal are independently
 * unit-testable (same extraction pattern as account-nav.ts / team-access.ts).
 *
 * @see docs/internal/implementation/account-dashboard-ux-consolidation.md
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveGateRedirect, type TeamAccessResult, type TeamGateReason } from './team-access'
import {
  humanizeActivity,
  type ActivityEvent,
  type FormattedActivity,
} from './team-activity-format'

export interface TeamOverviewUsage {
  totalEvents: number
  apiCalls: number
  skillsInstalled: number
  auditsRun: number
}

export interface TeamOverviewData {
  teamName: string
  memberCount: number
  workspaceCount: number
  skillCount: number
  usage: TeamOverviewUsage | null
  activity: FormattedActivity[]
}

/**
 * Decision #4 / plan-review issue C1: on `/account`, these three
 * tier/subscription gate reasons redirect to the personal `/account/summary`
 * dashboard instead of `resolveGateRedirect()`'s default
 * `/account/subscription?gated=<reason>` destination — a non-team user
 * should land somewhere useful, not a gated notice. `not_member` and
 * `not_authenticated` are intentionally NOT in this set: both already
 * resolve correctly via `resolveGateRedirect()` (inline "not a member"
 * state / `/login?redirect=/account`).
 */
const SUMMARY_REDIRECT_REASONS: ReadonlySet<TeamGateReason> = new Set([
  'not_team_tier',
  'no_active_subscription',
  'subscription_paused',
])

/**
 * Resolve where `/account` should send a user given their team-gate result.
 * `resolveGateRedirect()` and `check_team_tier_access` are frozen per the
 * plan — this only changes how the Overview call site branches on the
 * result it already returns.
 */
export function resolveOverviewRedirect(gate: TeamAccessResult): string | null {
  if (!gate.ok && gate.reason !== null && SUMMARY_REDIRECT_REASONS.has(gate.reason)) {
    return '/account/summary'
  }
  return resolveGateRedirect(gate, '/account')
}

/**
 * M9 entitlement signal for the hub tab row's lock affordance (Section 3,
 * L2-8). "Entitled" means the account's tier grants team-administration
 * access — true when the gate fully passes, or when the only shortfall is
 * `not_member` (correct tier, just no team set up yet — the four
 * team-administration tabs are not a paywall dead end for this user, only
 * an empty state). False for the three tier/subscription reasons that also
 * drive the Decision #4 redirect above.
 */
export function isTeamEntitled(gate: TeamAccessResult): boolean {
  return gate.ok || gate.reason === 'not_member'
}

/**
 * Fetch the Team Overview stats, 30-day usage summary, and humanized
 * recent-activity feed for `teamId`. Pure data-fetch + shape — DOM binding
 * stays in the page's own script.
 */
export async function loadTeamOverviewData(
  supabase: SupabaseClient,
  teamId: string
): Promise<TeamOverviewData> {
  const { data: memberships, error: memberErr } = await supabase
    .from('team_members')
    .select('team_id, role')
    .eq('team_id', teamId)
  if (memberErr) throw new Error(memberErr.message)

  const [teamRes, workspacesRes, skillsRes] = await Promise.all([
    supabase.from('teams').select('id, name, slug, max_members').eq('id', teamId).single(),
    supabase.from('team_workspaces').select('id').eq('team_id', teamId),
    supabase
      .from('workspace_skills')
      .select('workspace_id, team_workspaces!inner(team_id)')
      .eq('team_workspaces.team_id', teamId),
  ])
  if (teamRes.error) throw new Error(teamRes.error.message)

  const team = teamRes.data as { name: string }
  const workspaceCount = workspacesRes.data?.length ?? 0
  const skillCount = skillsRes.data?.length ?? 0

  let usage: TeamOverviewUsage | null = null
  const periodEnd = new Date()
  const periodStart = new Date()
  periodStart.setDate(periodStart.getDate() - 30)
  const { data: usageData, error: usageErr } = await supabase.rpc('get_team_usage_for_period', {
    p_team_id: teamId,
    p_period_start: periodStart.toISOString(),
    p_period_end: periodEnd.toISOString(),
  })
  if (!usageErr && usageData) {
    usage = {
      totalEvents: Number(usageData.total_events ?? 0),
      apiCalls: Number(usageData.api_calls ?? 0),
      skillsInstalled: Number(usageData.skills_installed ?? 0),
      auditsRun: Number(usageData.audits_run ?? 0),
    }
  }

  // Member display-name map for humanizing the activity feed. Fetched in
  // its own try/catch — a member-lookup failure degrades to a generic
  // actor label, not a blank dashboard (SMI-5151, plan-review #10).
  const nameMap = new Map<string, string>()
  try {
    const { data: memberRows } = await supabase.rpc('list_team_members_with_profile', {
      p_team_id: teamId,
    })
    for (const m of (memberRows ?? []) as Array<{
      user_id: string
      full_name: string | null
      email: string | null
    }>) {
      if (m.user_id) {
        nameMap.set(m.user_id, m.full_name || m.email?.split('@')[0] || 'Team member')
      }
    }
  } catch {
    // Leave nameMap empty; humanizeActivity falls back to "A team member".
  }

  // Recent activity — audit_logs filtered by team_id in metadata, then
  // rendered as human-readable lines (no raw UUIDs). (SMI-5151)
  const { data: activityRows } = await supabase
    .from('audit_logs')
    .select('id, event_type, actor, resource, action, timestamp, metadata')
    .eq('metadata->>team_id', teamId)
    .order('timestamp', { ascending: false })
    .limit(10)

  const activity = ((activityRows ?? []) as ActivityEvent[]).map((row) =>
    humanizeActivity(row, nameMap)
  )

  return {
    teamName: team.name,
    memberCount: memberships.length,
    workspaceCount,
    skillCount,
    usage,
    activity,
  }
}
