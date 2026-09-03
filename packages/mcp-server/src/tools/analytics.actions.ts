/**
 * @fileoverview Team/Enterprise analytics MCP tools — action-handler implementations
 * @module @skillsmith/mcp-server/tools/analytics.actions
 * @see SMI-6362 Wave 4: Wire Team/Enterprise analytics tools to cloud-aggregated MCP tool-call data
 * @see SMI-5127: the `*.action(s).ts` sibling convention for a tool file whose `withTelemetry`-
 *   wrapped action handlers push it over the 500-line audit:standards budget — this file holds the
 *   four handler implementations and their wrapped exports; `analytics.ts` keeps the MCP tool
 *   registration, Zod input schemas, and JSON tool schemas, re-exporting the wrapped handlers below
 *   unchanged. Precedent: `sso-tools.ts` / `sso-tools.action.ts`.
 *
 * All four tools (team_analytics_dashboard, team_usage_report, analytics_dashboard, usage_report)
 * are tier-gated to Team/Enterprise one layer above this file (MCP tool registration /
 * license.gate.ts, not touched by this wave) — a caller that reaches these handlers is assumed to
 * have real Team/Enterprise intent, so there is no more silent stub fallback here. Resolution is
 * cloud-first, three possible outcomes per handler:
 *
 * 1. `resolveCloudAnalytics()` resolves the caller's identity (a `skillsmith login` access token —
 *    who is calling) and team (a Team/Enterprise license/API key — which team). Either missing
 *    renders an actionable error as the tool's ENTIRE output (`renderCloudError()`); these handlers
 *    never throw.
 * 2. `SupabaseAnalyticsService.getToolUsage()` is called against the cloud `search_metrics`
 *    aggregate. An RPC-level failure renders the same actionable-error shape as step 1 — a
 *    Team/Enterprise caller whose cloud path is broken must see the real error, never local
 *    (in practice empty) SQLite data silently standing in for their team's data.
 * 3. On success, every response also carries a `## Data Coverage` note (`buildCoverageNote()`,
 *    best-effort — a coverage-RPC failure renders "unavailable", never a fabricated figure) plus a
 *    one-line skill-invocation-data honesty disclosure (AC-9), and an optional `## This Session`
 *    block surfacing THIS PROCESS's own telemetry emit-health (`getTelemetryEmitStats()`) only
 *    when this session had any rejected/failed `tool_call` events (D-8) — a narrower,
 *    session-scoped signal, deliberately distinct from the team-wide coverage note above it.
 *
 * The pre-Wave-4 local-SQLite path (`analytics.service.ts` / `analytics.stub.ts`) is deliberately
 * NOT called from any handler below. This is not because `ToolContext.db` is normally absent for a
 * real MCP server invocation — it isn't: `ToolContext.db` is a required field, always a real open
 * SQLite connection (see `context.ts`/`context.async.ts`). It's a product decision: a
 * Team/Enterprise-tier caller must never see local/stub data silently standing in for their team's
 * real cloud data, so the local-service resolver that made that substitution pre-Wave-4 was removed
 * outright rather than left as unreachable dead code (it had no other caller in this package).
 */

import type { ToolContext } from '../context.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { getTelemetryEmitStats } from '@skillsmith/core'
import { periodDays } from './analytics.stub.js'
import {
  SupabaseAnalyticsService,
  buildCoverageNote,
  actorDisplayLabel,
} from './analytics.supabase.service.js'
import type { ServiceResult, TeamReportingCoverage } from './analytics.supabase.service.js'
import { resolveUserAccessToken, resolveLicenseTeamId } from './team-resolver.js'
import type {
  TeamAnalyticsDashboardInput,
  TeamUsageReportInput,
  AnalyticsDashboardInput,
  UsageReportInput,
} from './analytics.js'

// ============================================================================
// Cloud credential resolution (D-2c)
// ============================================================================

/** Resolved credentials needed to call the cloud analytics service. */
export interface CloudAnalyticsResolution {
  teamId: string
  accessToken: string
}

/**
 * Resolve the credentials needed to call the cloud analytics service (SMI-6362 Wave 4, D-2c).
 * Returns an actionable error string (never a thrown exception, never a silent empty state) when
 * either credential is missing — the caller must render this error rather than falling through to
 * a stub/zero result, per AC-10's "never print Data source: live beside zeros" rule, extended here
 * to "never silently substitute local/stub data for a Team/Enterprise caller's real team data."
 *
 * Two distinct credentials, mirroring team-resolver.ts's own header comment: `resolveUserAccessToken`
 * answers "who is calling" (a `skillsmith login` session — a license/API key alone identifies only
 * the TEAM, never the individual caller); `resolveLicenseTeamId` answers "which team" (the
 * SKILLSMITH_LICENSE_KEY/SKILLSMITH_API_KEY-resolved team, the same RPC path registry-tools.ts's
 * `resolveTeamId()` and team-workspace.ts already share).
 */
export async function resolveCloudAnalytics(): Promise<
  { ok: true; data: CloudAnalyticsResolution } | { ok: false; error: string }
> {
  const accessToken = await resolveUserAccessToken()
  if (!accessToken) {
    return {
      ok: false,
      error:
        'Not signed in. Run `skillsmith login` to view Team/Enterprise usage analytics — ' +
        'a license/API key alone is not sufficient for this data (it identifies your team, not you).',
    }
  }
  const teamId = await resolveLicenseTeamId()
  if (!teamId) {
    return {
      ok: false,
      error:
        'Unable to resolve your team. Set SKILLSMITH_LICENSE_KEY or SKILLSMITH_API_KEY to an ' +
        'active Team/Enterprise credential — shell exports do not reach MCP subprocesses, so set ' +
        'it in your MCP server config.',
    }
  }
  return { ok: true, data: { teamId, accessToken } }
}

// ============================================================================
// Shared rendering helpers
// ============================================================================

const SKILL_PANEL_HONESTY_LINE =
  'Skill-invocation data: not yet captured for teams (Claude Code hook invocations are not ' +
  'team-attributed).'

function sign(n: number): string {
  return n >= 0 ? '+' : ''
}

/** AC-10 read-side: an actionable error IS the tool's entire output — heading + error text. */
function renderCloudError(title: string, error: string): string {
  return [title, '', '## Error', error].join('\n')
}

function csvEscape(s: string): string {
  return s.replace(/"/g, '""')
}

function topToolsTableWithPct(
  topTools: Array<{ tool: string; count: number }>,
  total: number
): string[] {
  return [
    '| Tool | Calls | % of Total |',
    '|------|-------|------------|',
    ...topTools.map((t) => {
      const pct = total > 0 ? Math.round((t.count / total) * 100) : 0
      return `| ${t.tool} | ${t.count} | ${pct}% |`
    }),
  ]
}

/** team_usage_report's top-tools table has never carried a % column — matches pre-Wave-4 shape. */
function topToolsTableSimple(topTools: Array<{ tool: string; count: number }>): string[] {
  return [
    '| Tool | Calls |',
    '|------|-------|',
    ...topTools.map((t) => `| ${t.tool} | ${t.count} |`),
  ]
}

function dailyTrendTable(dailyTrend: Array<{ date: string; count: number }>): string[] {
  return [
    '| Date | Calls |',
    '|------|-------|',
    ...dailyTrend.slice(-7).map((d) => `| ${d.date} | ${d.count} |`),
  ]
}

/** Renders `actorDisplayLabel()` (nickname + digest prefix) — never the raw actor digest. */
function byActorTable(byActor: Array<{ actor: string; count: number }>): string[] {
  return [
    '| User | Calls |',
    '|------|-------|',
    ...byActor.map((a) => `| ${actorDisplayLabel(a.actor)} | ${a.count} |`),
  ]
}

/** `## Data Coverage` block rendered by all four tools (AC-9) — team-wide, not session-scoped. */
function renderDataCoverageLines(coverageResult: ServiceResult<TeamReportingCoverage>): string[] {
  const coverage = coverageResult.ok ? coverageResult.data : null
  return ['', '## Data Coverage', buildCoverageNote(coverage), '', SKILL_PANEL_HONESTY_LINE]
}

type EmitStats = ReturnType<typeof getTelemetryEmitStats>

/**
 * THIS PROCESS's own telemetry emit-health (D-8) — a narrower, session-scoped signal distinct from
 * the team-wide `## Data Coverage` note above. `null` when nothing was rejected/failed this
 * session — callers must render nothing in that case (no reassuring "0 rejected" noise).
 */
function emitHealthMessage(stats: EmitStats): string | null {
  if (stats.rejected <= 0 && stats.failed <= 0) return null
  switch (stats.lastRejectionReason) {
    case 'ambiguous_team':
      return (
        "Your MCP client's own tool-call events are being rejected (reason: ambiguous_team) — " +
        'set SKILLSMITH_LICENSE_KEY to choose which team your usage should count toward.'
      )
    case 'consent_required':
      return (
        "Your MCP client's own tool-call events are being rejected (reason: consent_required) — " +
        'enable telemetry at the link in your `skillsmith login` welcome message or your ' +
        "account's telemetry settings page."
      )
    case 'consent_denied':
      return (
        "Your MCP client's own tool-call events are being rejected (reason: consent_denied) — " +
        'telemetry is currently disabled for your account.'
      )
    default: {
      const total = stats.rejected + stats.failed
      return (
        `${total} events could not be delivered this session ` +
        `(reason: ${stats.lastRejectionReason ?? 'unknown'}).`
      )
    }
  }
}

function renderEmitHealthLines(stats: EmitStats): string[] {
  const message = emitHealthMessage(stats)
  return message ? ['', '## This Session', message] : []
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Team analytics dashboard handler. Cloud-first (see file header) — renders per-tool-usage,
 * top tools, and daily trend from `SupabaseAnalyticsService.getToolUsage()` as markdown.
 */
async function executeTeamAnalyticsDashboardImpl(
  input: TeamAnalyticsDashboardInput,
  _context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const title = `# Team Analytics Dashboard (${input.period})`

  const resolved = await resolveCloudAnalytics()
  if (!resolved.ok) return renderCloudError(title, resolved.error)
  const { teamId, accessToken } = resolved.data

  const svc = new SupabaseAnalyticsService()
  const usage = await svc.getToolUsage({ teamId, accessToken, windowDays: days })
  if (!usage.ok) return renderCloudError(title, usage.error)
  const data = usage.data
  const total = data.totalToolCalls
  const avgPerDay = days > 0 ? (total / days).toFixed(1) : '0.0'

  const coverageResult = await svc.getReportingCoverage({ teamId, accessToken })

  const lines = [
    title,
    '',
    '## Summary',
    `- **Period**: Last ${days} days`,
    `- **Total tool calls**: ${total}`,
    `- **Unique tools**: ${data.uniqueTools}`,
    `- **Avg calls/day**: ${avgPerDay}`,
    '- **Data source**: live-cloud',
    '',
    '## Top Tools',
    ...topToolsTableWithPct(data.topTools, total),
    '',
    '## Period Comparison',
    `- **Current**: ${data.periodComparison.current}`,
    `- **Previous**: ${data.periodComparison.previous}`,
    `- **Change**: ${sign(data.periodComparison.changePercent)}${data.periodComparison.changePercent}%`,
    '',
    '## Daily Trend (last 7 days)',
    ...dailyTrendTable(data.dailyTrend),
    ...renderDataCoverageLines(coverageResult),
    ...renderEmitHealthLines(getTelemetryEmitStats()),
  ]

  return lines.join('\n')
}

/**
 * Team usage report handler. Cloud-first (see file header) — renders period comparison and,
 * in detailed format, a per-actor breakdown (nickname-labeled — see `byActorTable()`).
 */
async function executeTeamUsageReportImpl(
  input: TeamUsageReportInput,
  _context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const title = `# Team Usage Report (${input.period})`

  const resolved = await resolveCloudAnalytics()
  if (!resolved.ok) return renderCloudError(title, resolved.error)
  const { teamId, accessToken } = resolved.data

  const svc = new SupabaseAnalyticsService()
  const usage = await svc.getToolUsage({ teamId, accessToken, windowDays: days })
  if (!usage.ok) return renderCloudError(title, usage.error)
  const data = usage.data
  const { current, previous, changePercent } = data.periodComparison

  const coverageResult = await svc.getReportingCoverage({ teamId, accessToken })

  const lines = [
    title,
    '',
    '## Period Summary',
    `- **Current period**: ${current} total calls`,
    `- **Previous period**: ${previous} total calls`,
    `- **Change**: ${sign(changePercent)}${changePercent}%`,
    `- **Unique tools**: ${data.uniqueTools}`,
    '- **Data source**: live-cloud',
    '',
    '## Top Tools',
    ...topToolsTableSimple(data.topTools),
  ]

  if (input.format === 'detailed' && data.byActor) {
    lines.push('', '## Detailed Breakdown by User', ...byActorTable(data.byActor))
  }

  lines.push(
    ...renderDataCoverageLines(coverageResult),
    ...renderEmitHealthLines(getTelemetryEmitStats())
  )

  return lines.join('\n')
}

/**
 * Enterprise analytics dashboard handler. Cloud-first (see file header). `includeRecommendations`
 * renders an honest "not yet captured" note rather than pointing at a metric this wave doesn't
 * actually populate.
 */
async function executeAnalyticsDashboardImpl(
  input: AnalyticsDashboardInput,
  _context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const title = `# Enterprise Analytics Dashboard (${input.period})`

  const resolved = await resolveCloudAnalytics()
  if (!resolved.ok) return renderCloudError(title, resolved.error)
  const { teamId, accessToken } = resolved.data

  const svc = new SupabaseAnalyticsService()
  const usage = await svc.getToolUsage({ teamId, accessToken, windowDays: days })
  if (!usage.ok) return renderCloudError(title, usage.error)
  const data = usage.data
  const total = data.totalToolCalls

  const coverageResult = await svc.getReportingCoverage({ teamId, accessToken })

  const lines = [
    title,
    '',
    '## Organization Summary',
    `- **Period**: Last ${days} days`,
    `- **Total tool calls**: ${total}`,
    `- **Unique tools**: ${data.uniqueTools}`,
    '- **Data source**: live-cloud',
    '',
    '## Top Tools',
    ...topToolsTableWithPct(data.topTools, total),
    '',
    '## Period Comparison',
    `- **Current**: ${data.periodComparison.current}`,
    `- **Previous**: ${data.periodComparison.previous}`,
    `- **Change**: ${sign(data.periodComparison.changePercent)}${data.periodComparison.changePercent}%`,
    '',
    '## Daily Trend (last 7 days)',
    ...dailyTrendTable(data.dailyTrend),
  ]

  if (input.includeRecommendations) {
    lines.push(
      '',
      '## Recommendation Accuracy',
      '_Recommendation accuracy tracking is not yet implemented for cloud-backed analytics — ' +
        'filed as a follow-up, not available in this response._'
    )
  }

  lines.push(
    ...renderDataCoverageLines(coverageResult),
    ...renderEmitHealthLines(getTelemetryEmitStats())
  )

  return lines.join('\n')
}

/**
 * Enterprise usage report handler. Cloud-first (see file header). CSV format carries the same
 * AC-9/AC-10 disclosures as extra `metric,value` rows rather than embedded markdown prose, which
 * would corrupt CSV structure (SMI-6362 Wave 4 design call — see this file's module doc comment
 * and the implementing agent's report for the fuller rationale).
 */
async function executeUsageReportImpl(
  input: UsageReportInput,
  _context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const title = `# Enterprise Usage Report (${input.period})`

  const resolved = await resolveCloudAnalytics()
  if (!resolved.ok) return renderCloudError(title, resolved.error)
  const { teamId, accessToken } = resolved.data

  const svc = new SupabaseAnalyticsService()
  const usage = await svc.getToolUsage({ teamId, accessToken, windowDays: days })
  if (!usage.ok) return renderCloudError(title, usage.error)
  const data = usage.data
  const { current, previous, changePercent } = data.periodComparison

  const coverageResult = await svc.getReportingCoverage({ teamId, accessToken })
  const emitStats = getTelemetryEmitStats()

  if (input.format === 'csv') {
    const csvLines = [
      'metric,current_period,previous_period,change_percent',
      `total_calls,${current},${previous},${changePercent}`,
      `unique_tools,${data.uniqueTools},,,`,
    ]
    for (const t of data.topTools) {
      csvLines.push(`tool_${t.tool},${t.count},,,`)
    }
    const coverage = coverageResult.ok ? coverageResult.data : null
    csvLines.push(`data_coverage_note,"${csvEscape(buildCoverageNote(coverage))}",,,`)
    csvLines.push(`skill_invocation_note,"${csvEscape(SKILL_PANEL_HONESTY_LINE)}",,,`)
    const emitMessage = emitHealthMessage(emitStats)
    if (emitMessage) {
      csvLines.push(`session_note,"${csvEscape(emitMessage)}",,,`)
    }
    return csvLines.join('\n')
  }

  const lines = [
    title,
    '',
    '## Executive Summary',
    `- **Period**: Last ${days} days`,
    `- **Total tool calls**: ${current} (${sign(changePercent)}${changePercent}% vs previous)`,
    `- **Unique tools**: ${data.uniqueTools}`,
    '- **Data source**: live-cloud',
    '',
    '## Top Tools',
    ...topToolsTableWithPct(data.topTools, current),
    '',
    '## Daily Trend',
    ...dailyTrendTable(data.dailyTrend),
  ]

  if (input.format === 'detailed' && data.byActor) {
    lines.push('', '## Per-User Breakdown', ...byActorTable(data.byActor))
  }

  lines.push(...renderDataCoverageLines(coverageResult), ...renderEmitHealthLines(emitStats))

  return lines.join('\n')
}

// ============================================================================
// Wrapped exports (SMI-5017 W2.S2: wrap at export boundary)
// ============================================================================

export const executeTeamAnalyticsDashboard = withTelemetry(executeTeamAnalyticsDashboardImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'team_analytics_dashboard',
  extractFramework: () => 'unknown',
})
export const executeTeamUsageReport = withTelemetry(executeTeamUsageReportImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'team_usage_report',
  extractFramework: () => 'unknown',
})
export const executeAnalyticsDashboard = withTelemetry(executeAnalyticsDashboardImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'analytics_dashboard',
  extractFramework: () => 'unknown',
})
export const executeUsageReport = withTelemetry(executeUsageReportImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'usage_report',
  extractFramework: () => 'unknown',
})
