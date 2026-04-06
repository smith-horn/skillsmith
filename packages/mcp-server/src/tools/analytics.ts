/**
 * @fileoverview Analytics MCP tools — team and enterprise usage dashboards
 * @module @skillsmith/mcp-server/tools/analytics
 * @see SMI-3899: Team Usage Analytics MCP Tools (Wave 2b)
 *
 * Split-tier analytics:
 * - Team tier: team_analytics_dashboard, team_usage_report (usage_analytics flag)
 * - Enterprise tier: analytics_dashboard, usage_report (advanced_analytics flag)
 *
 * MVP returns structured mock data with realistic shapes.
 * TODO: Replace mock data with real audit_logs queries.
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'

// ============================================================================
// Shared types
// ============================================================================

const periodSchema = z.enum(['7d', '30d', '90d']).optional().default('30d')
const formatSchema = z.enum(['summary', 'detailed']).optional().default('summary')
const enterpriseFormatSchema = z.enum(['summary', 'detailed', 'csv']).optional().default('summary')

// ============================================================================
// Input schemas
// ============================================================================

export const teamAnalyticsDashboardInputSchema = z.object({
  period: periodSchema.describe('Time period for analytics (default 30d)'),
})

export type TeamAnalyticsDashboardInput = z.infer<typeof teamAnalyticsDashboardInputSchema>

export const teamUsageReportInputSchema = z.object({
  period: periodSchema.describe('Time period for report (default 30d)'),
  format: formatSchema.describe('Report format: summary or detailed (default summary)'),
})

export type TeamUsageReportInput = z.infer<typeof teamUsageReportInputSchema>

export const analyticsDashboardInputSchema = z.object({
  period: periodSchema.describe('Time period for analytics (default 30d)'),
  includeRecommendations: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include recommendation accuracy metrics'),
})

export type AnalyticsDashboardInput = z.infer<typeof analyticsDashboardInputSchema>

export const usageReportInputSchema = z.object({
  period: periodSchema.describe('Time period for report (default 30d)'),
  format: enterpriseFormatSchema.describe(
    'Report format: summary, detailed, or csv (default summary)'
  ),
})

export type UsageReportInput = z.infer<typeof usageReportInputSchema>

// ============================================================================
// Tool schemas for MCP registration
// ============================================================================

export const teamAnalyticsDashboardToolSchema = {
  name: 'team_analytics_dashboard' as const,
  description:
    'View team usage analytics: per-user tool usage counts, top tools, and daily trend. ' +
    'Requires Team tier (usage_analytics feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      period: {
        type: 'string',
        enum: ['7d', '30d', '90d'],
        description: 'Time period (default 30d)',
      },
    },
  },
}

export const teamUsageReportToolSchema = {
  name: 'team_usage_report' as const,
  description:
    'Generate a weekly/monthly usage summary with period-over-period comparison. ' +
    'Requires Team tier (usage_analytics feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      period: {
        type: 'string',
        enum: ['7d', '30d', '90d'],
        description: 'Time period (default 30d)',
      },
      format: {
        type: 'string',
        enum: ['summary', 'detailed'],
        description: 'Report format (default summary)',
      },
    },
  },
}

export const analyticsDashboardToolSchema = {
  name: 'analytics_dashboard' as const,
  description:
    'Enterprise analytics dashboard: recommendation accuracy, skill adoption curves, ' +
    'team-wide aggregation. Requires Enterprise tier (advanced_analytics feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      period: {
        type: 'string',
        enum: ['7d', '30d', '90d'],
        description: 'Time period (default 30d)',
      },
      includeRecommendations: {
        type: 'boolean',
        description: 'Include recommendation accuracy metrics (default false)',
      },
    },
  },
}

export const usageReportToolSchema = {
  name: 'usage_report' as const,
  description:
    'Comprehensive enterprise usage report with all metrics. ' +
    'Requires Enterprise tier (advanced_analytics feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      period: {
        type: 'string',
        enum: ['7d', '30d', '90d'],
        description: 'Time period (default 30d)',
      },
      format: {
        type: 'string',
        enum: ['summary', 'detailed', 'csv'],
        description: 'Report format (default summary)',
      },
    },
  },
}

// ============================================================================
// Mock data helpers
// ============================================================================

/** Map period string to number of days */
function periodDays(period: string): number {
  switch (period) {
    case '7d':
      return 7
    case '90d':
      return 90
    default:
      return 30
  }
}

/** Generate mock daily trend data for the given number of days */
function generateDailyTrend(days: number): Array<{ date: string; calls: number }> {
  const trend: Array<{ date: string; calls: number }> = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now)
    date.setDate(date.getDate() - i)
    trend.push({
      date: date.toISOString().split('T')[0],
      // Deterministic "random" based on day offset to keep output stable
      calls: 20 + ((i * 7 + 3) % 30),
    })
  }
  return trend
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Team analytics dashboard handler.
 * Returns per-user tool usage, top tools, and daily trend as markdown.
 *
 * TODO: Replace mock data with real audit_logs query
 */
export async function executeTeamAnalyticsDashboard(
  input: TeamAnalyticsDashboardInput,
  _context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const trend = generateDailyTrend(days)
  const totalCalls = trend.reduce((sum, d) => sum + d.calls, 0)

  const lines = [
    `# Team Analytics Dashboard (${input.period})`,
    '',
    '## Summary',
    `- **Period**: Last ${days} days`,
    `- **Total tool calls**: ${totalCalls}`,
    `- **Active users**: 4`,
    `- **Avg calls/user/day**: ${(totalCalls / (days * 4)).toFixed(1)}`,
    '',
    '## Top Tools',
    '| Tool | Calls | % of Total |',
    '|------|-------|------------|',
    `| search | ${Math.round(totalCalls * 0.35)} | 35% |`,
    `| install_skill | ${Math.round(totalCalls * 0.22)} | 22% |`,
    `| skill_recommend | ${Math.round(totalCalls * 0.18)} | 18% |`,
    `| skill_validate | ${Math.round(totalCalls * 0.12)} | 12% |`,
    `| skill_compare | ${Math.round(totalCalls * 0.08)} | 8% |`,
    `| other | ${Math.round(totalCalls * 0.05)} | 5% |`,
    '',
    '## Per-User Usage',
    '| User | Calls | Top Tool |',
    '|------|-------|----------|',
    `| alice@example.com | ${Math.round(totalCalls * 0.32)} | search |`,
    `| bob@example.com | ${Math.round(totalCalls * 0.28)} | install_skill |`,
    `| carol@example.com | ${Math.round(totalCalls * 0.24)} | skill_recommend |`,
    `| dave@example.com | ${Math.round(totalCalls * 0.16)} | skill_validate |`,
    '',
    '## Daily Trend (last 7 days)',
    '| Date | Calls |',
    '|------|-------|',
    ...trend.slice(-7).map((d) => `| ${d.date} | ${d.calls} |`),
  ]

  return lines.join('\n')
}

/**
 * Team usage report handler.
 * Returns weekly/monthly summary with period comparison as markdown.
 *
 * TODO: Replace mock data with real audit_logs query
 */
export async function executeTeamUsageReport(
  input: TeamUsageReportInput,
  _context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const totalCalls = days * 25 // ~25 calls/day mock baseline
  const previousCalls = Math.round(totalCalls * 0.85) // 15% growth mock
  const changePercent = (((totalCalls - previousCalls) / previousCalls) * 100).toFixed(1)

  const lines = [
    `# Team Usage Report (${input.period})`,
    '',
    '## Period Summary',
    `- **Current period**: ${totalCalls} total calls`,
    `- **Previous period**: ${previousCalls} total calls`,
    `- **Change**: +${changePercent}%`,
    `- **Active users**: 4`,
    `- **New skills installed**: 12`,
    '',
    '## Usage by Category',
    '| Category | Current | Previous | Change |',
    '|----------|---------|----------|--------|',
    `| Discovery (search, recommend) | ${Math.round(totalCalls * 0.45)} | ${Math.round(previousCalls * 0.42)} | +22% |`,
    `| Management (install, uninstall) | ${Math.round(totalCalls * 0.3)} | ${Math.round(previousCalls * 0.32)} | +8% |`,
    `| Quality (validate, audit) | ${Math.round(totalCalls * 0.15)} | ${Math.round(previousCalls * 0.16)} | +8% |`,
    `| Collaboration (workspace, share) | ${Math.round(totalCalls * 0.1)} | ${Math.round(previousCalls * 0.1)} | +15% |`,
  ]

  if (input.format === 'detailed') {
    lines.push(
      '',
      '## Detailed Breakdown by User',
      '| User | Discovery | Management | Quality | Collaboration | Total |',
      '|------|-----------|------------|---------|---------------|-------|',
      `| alice@example.com | 95 | 60 | 30 | 15 | ${Math.round(totalCalls * 0.32)} |`,
      `| bob@example.com | 80 | 70 | 20 | 5 | ${Math.round(totalCalls * 0.28)} |`,
      `| carol@example.com | 65 | 45 | 35 | 40 | ${Math.round(totalCalls * 0.24)} |`,
      `| dave@example.com | 40 | 30 | 25 | 5 | ${Math.round(totalCalls * 0.16)} |`
    )
  }

  return lines.join('\n')
}

/**
 * Enterprise analytics dashboard handler.
 * Returns recommendation accuracy, adoption curves, and team aggregation as markdown.
 *
 * TODO: Replace mock data with real audit_logs query
 */
export async function executeAnalyticsDashboard(
  input: AnalyticsDashboardInput,
  _context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const totalCalls = days * 85 // higher baseline for enterprise

  const lines = [
    `# Enterprise Analytics Dashboard (${input.period})`,
    '',
    '## Organization Summary',
    `- **Period**: Last ${days} days`,
    `- **Total tool calls**: ${totalCalls}`,
    `- **Active teams**: 3`,
    `- **Active users**: 18`,
    `- **Skills installed org-wide**: 47`,
    '',
    '## Team Breakdown',
    '| Team | Users | Calls | Top Tool |',
    '|------|-------|-------|----------|',
    `| Engineering | 10 | ${Math.round(totalCalls * 0.55)} | search |`,
    `| Data Science | 5 | ${Math.round(totalCalls * 0.3)} | skill_recommend |`,
    `| DevOps | 3 | ${Math.round(totalCalls * 0.15)} | skill_audit |`,
    '',
    '## Skill Adoption',
    '| Skill | Installed By | First Used | Adoption Rate |',
    '|-------|-------------|------------|---------------|',
    '| governance | 15 users | 2026-01-15 | 83% |',
    '| security-auditor | 12 users | 2026-02-01 | 67% |',
    '| docker-optimizer | 8 users | 2026-02-20 | 44% |',
    '| ci-doctor | 6 users | 2026-03-05 | 33% |',
  ]

  if (input.includeRecommendations) {
    lines.push(
      '',
      '## Recommendation Accuracy',
      `- **Recommendations made**: ${Math.round(totalCalls * 0.18)}`,
      `- **Accepted**: ${Math.round(totalCalls * 0.18 * 0.72)} (72%)`,
      `- **Installed after recommendation**: ${Math.round(totalCalls * 0.18 * 0.45)} (45%)`,
      `- **Still active after 7 days**: ${Math.round(totalCalls * 0.18 * 0.38)} (38%)`,
      '',
      '## Top Recommended Skills',
      '| Skill | Times Recommended | Accept Rate |',
      '|-------|-------------------|-------------|',
      '| governance | 42 | 85% |',
      '| security-auditor | 35 | 74% |',
      '| flaky-test-detector | 28 | 68% |'
    )
  }

  return lines.join('\n')
}

/**
 * Enterprise usage report handler.
 * Returns comprehensive report with all metrics as markdown (or CSV).
 *
 * TODO: Replace mock data with real audit_logs query
 */
export async function executeUsageReport(
  input: UsageReportInput,
  _context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const totalCalls = days * 85
  const previousCalls = Math.round(totalCalls * 0.78)
  const changePercent = (((totalCalls - previousCalls) / previousCalls) * 100).toFixed(1)

  if (input.format === 'csv') {
    const csvLines = [
      'metric,current_period,previous_period,change_percent',
      `total_calls,${totalCalls},${previousCalls},${changePercent}`,
      `active_users,18,15,20.0`,
      `active_teams,3,3,0.0`,
      `skills_installed,47,38,23.7`,
      `recommendations_made,${Math.round(totalCalls * 0.18)},${Math.round(previousCalls * 0.18)},${changePercent}`,
      `recommendation_accept_rate,72,68,5.9`,
      `security_audits,${Math.round(totalCalls * 0.05)},${Math.round(previousCalls * 0.04)},42.3`,
    ]
    return csvLines.join('\n')
  }

  const lines = [
    `# Enterprise Usage Report (${input.period})`,
    '',
    '## Executive Summary',
    `- **Period**: Last ${days} days`,
    `- **Total tool calls**: ${totalCalls} (+${changePercent}% vs previous)`,
    `- **Active users**: 18 (up from 15)`,
    `- **Active teams**: 3`,
    `- **Skills installed**: 47 (up from 38)`,
    '',
    '## Usage by Tier Feature',
    '| Feature | Calls | % of Total | Trend |',
    '|---------|-------|------------|-------|',
    `| Core tools | ${Math.round(totalCalls * 0.5)} | 50% | stable |`,
    `| Version tracking | ${Math.round(totalCalls * 0.15)} | 15% | +12% |`,
    `| Team workspaces | ${Math.round(totalCalls * 0.12)} | 12% | +25% |`,
    `| Security audit | ${Math.round(totalCalls * 0.08)} | 8% | +18% |`,
    `| Audit logging | ${Math.round(totalCalls * 0.1)} | 10% | +30% |`,
    `| SIEM export | ${Math.round(totalCalls * 0.05)} | 5% | +15% |`,
    '',
    '## License Utilization',
    '- **Seats provisioned**: 25',
    '- **Seats active**: 18 (72%)',
    '- **API quota used**: 42%',
    '- **License expires**: 2027-01-15',
  ]

  if (input.format === 'detailed') {
    lines.push(
      '',
      '## Per-Team Detailed Breakdown',
      '',
      '### Engineering (10 users)',
      '| User | Total | search | install | validate | audit |',
      '|------|-------|--------|---------|----------|-------|',
      '| eng-lead | 320 | 120 | 80 | 60 | 60 |',
      '| dev-1 | 280 | 100 | 90 | 50 | 40 |',
      '| dev-2 | 240 | 90 | 70 | 40 | 40 |',
      '',
      '### Data Science (5 users)',
      '| User | Total | search | recommend | compare | suggest |',
      '|------|-------|--------|-----------|---------|---------|',
      '| ds-lead | 210 | 70 | 80 | 30 | 30 |',
      '| analyst-1 | 180 | 60 | 60 | 30 | 30 |'
    )
  }

  return lines.join('\n')
}
