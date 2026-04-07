/**
 * @fileoverview Analytics MCP tools — team and enterprise usage dashboards
 * @module @skillsmith/mcp-server/tools/analytics
 * @see SMI-3899: Team Usage Analytics MCP Tools (Wave 2b)
 *
 * Split-tier analytics:
 * - Team tier: team_analytics_dashboard, team_usage_report (usage_analytics flag)
 * - Enterprise tier: analytics_dashboard, usage_report (advanced_analytics flag)
 *
 * Uses real SQLite queries against audit_logs when db is available,
 * falls back to stub mock data when no database is present.
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'
import {
  periodDays,
  stubTeamAnalyticsDashboard,
  stubTeamUsageReport,
  stubAnalyticsDashboard,
  stubUsageReport,
} from './analytics.stub.js'
import { createRealAnalyticsService, type AnalyticsService } from './analytics.service.js'

// Re-export stub helpers for external consumers
export { periodDays, generateDailyTrend } from './analytics.stub.js'

/**
 * Resolve analytics service: real (SQLite-backed) when db is available,
 * otherwise null (handlers fall back to inline stub data).
 */
function resolveAnalyticsService(context: ToolContext): AnalyticsService | null {
  try {
    if (context.db && context.db.open) {
      return createRealAnalyticsService(context.db)
    }
  } catch {
    // Fall through to stub
  }
  return null
}

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
// Handlers
// ============================================================================

/**
 * Team analytics dashboard handler.
 * Returns per-user tool usage, top tools, and daily trend as markdown.
 *
 * Uses real service when db is available, falls back to stub
 */
export async function executeTeamAnalyticsDashboard(
  input: TeamAnalyticsDashboardInput,
  context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const svc = resolveAnalyticsService(context)

  if (svc) {
    const data = svc.getDashboardData(days)
    const total = data.totalToolCalls
    const avgPerDay = days > 0 ? (total / days).toFixed(1) : '0.0'
    const lines = [
      `# Team Analytics Dashboard (${input.period})`,
      '',
      '## Summary',
      `- **Period**: Last ${days} days`,
      `- **Total tool calls**: ${total}`,
      `- **Unique tools**: ${data.uniqueTools}`,
      `- **Avg calls/day**: ${avgPerDay}`,
      `- **Data source**: live`,
      '',
      '## Top Tools',
      '| Tool | Calls | % of Total |',
      '|------|-------|------------|',
      ...data.topTools.map((t) => {
        const pct = total > 0 ? Math.round((t.count / total) * 100) : 0
        return `| ${t.tool} | ${t.count} | ${pct}% |`
      }),
      '',
      '## Period Comparison',
      `- **Current**: ${data.periodComparison.current}`,
      `- **Previous**: ${data.periodComparison.previous}`,
      `- **Change**: ${data.periodComparison.changePercent >= 0 ? '+' : ''}${data.periodComparison.changePercent}%`,
      '',
      '## Daily Trend (last 7 days)',
      '| Date | Calls |',
      '|------|-------|',
      ...data.dailyTrend.slice(-7).map((d) => `| ${d.date} | ${d.count} |`),
    ]
    return lines.join('\n')
  }

  return stubTeamAnalyticsDashboard(input.period)
}

/**
 * Team usage report handler.
 * Returns weekly/monthly summary with period comparison as markdown.
 *
 * Uses real service when db is available, falls back to stub
 */
export async function executeTeamUsageReport(
  input: TeamUsageReportInput,
  context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const svc = resolveAnalyticsService(context)

  if (svc) {
    const data = svc.getUsageReport(days, input.format === 'detailed')
    const { current, previous, changePercent } = data.periodComparison
    const sign = changePercent >= 0 ? '+' : ''

    const lines = [
      `# Team Usage Report (${input.period})`,
      '',
      '## Period Summary',
      `- **Current period**: ${current} total calls`,
      `- **Previous period**: ${previous} total calls`,
      `- **Change**: ${sign}${changePercent}%`,
      `- **Unique tools**: ${data.uniqueTools}`,
      `- **Data source**: live`,
      '',
      '## Top Tools',
      '| Tool | Calls |',
      '|------|-------|',
      ...data.topTools.map((t) => `| ${t.tool} | ${t.count} |`),
    ]

    if (input.format === 'detailed' && data.byActor) {
      lines.push(
        '',
        '## Detailed Breakdown by User',
        '| User | Calls |',
        '|------|-------|',
        ...data.byActor.map((a) => `| ${a.actor} | ${a.count} |`)
      )
    }

    return lines.join('\n')
  }

  return stubTeamUsageReport(input.period, input.format)
}

/**
 * Enterprise analytics dashboard handler.
 * Returns recommendation accuracy, adoption curves, and team aggregation as markdown.
 *
 * Uses real service when db is available, falls back to stub
 */
export async function executeAnalyticsDashboard(
  input: AnalyticsDashboardInput,
  context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const svc = resolveAnalyticsService(context)

  if (svc) {
    const data = svc.getDashboardData(days)
    const total = data.totalToolCalls

    const lines = [
      `# Enterprise Analytics Dashboard (${input.period})`,
      '',
      '## Organization Summary',
      `- **Period**: Last ${days} days`,
      `- **Total tool calls**: ${total}`,
      `- **Unique tools**: ${data.uniqueTools}`,
      `- **Data source**: live`,
      '',
      '## Top Tools',
      '| Tool | Calls | % of Total |',
      '|------|-------|------------|',
      ...data.topTools.map((t) => {
        const pct = total > 0 ? Math.round((t.count / total) * 100) : 0
        return `| ${t.tool} | ${t.count} | ${pct}% |`
      }),
      '',
      '## Period Comparison',
      `- **Current**: ${data.periodComparison.current}`,
      `- **Previous**: ${data.periodComparison.previous}`,
      `- **Change**: ${data.periodComparison.changePercent >= 0 ? '+' : ''}${data.periodComparison.changePercent}%`,
      '',
      '## Daily Trend (last 7 days)',
      '| Date | Calls |',
      '|------|-------|',
      ...data.dailyTrend.slice(-7).map((d) => `| ${d.date} | ${d.count} |`),
    ]

    if (input.includeRecommendations) {
      lines.push(
        '',
        '## Recommendation Accuracy',
        '_Recommendation tracking requires server-side data. ' +
          'Use audit_export for full recommendation metrics._'
      )
    }

    return lines.join('\n')
  }

  return stubAnalyticsDashboard(input.period, input.includeRecommendations)
}

/**
 * Enterprise usage report handler.
 * Returns comprehensive report with all metrics as markdown (or CSV).
 *
 * Uses real service when db is available, falls back to stub
 */
export async function executeUsageReport(
  input: UsageReportInput,
  context: ToolContext
): Promise<string> {
  const days = periodDays(input.period)
  const svc = resolveAnalyticsService(context)

  if (svc) {
    const data = svc.getUsageReport(days, input.format === 'detailed')
    const { current, previous, changePercent } = data.periodComparison
    const sign = changePercent >= 0 ? '+' : ''

    if (input.format === 'csv') {
      const csvLines = [
        'metric,current_period,previous_period,change_percent',
        `total_calls,${current},${previous},${changePercent}`,
        `unique_tools,${data.uniqueTools},,,`,
      ]
      for (const t of data.topTools) {
        csvLines.push(`tool_${t.tool},${t.count},,,`)
      }
      return csvLines.join('\n')
    }

    const lines = [
      `# Enterprise Usage Report (${input.period})`,
      '',
      '## Executive Summary',
      `- **Period**: Last ${days} days`,
      `- **Total tool calls**: ${current} (${sign}${changePercent}% vs previous)`,
      `- **Unique tools**: ${data.uniqueTools}`,
      `- **Data source**: live`,
      '',
      '## Top Tools',
      '| Tool | Calls | % of Total |',
      '|------|-------|------------|',
      ...data.topTools.map((t) => {
        const pct = current > 0 ? Math.round((t.count / current) * 100) : 0
        return `| ${t.tool} | ${t.count} | ${pct}% |`
      }),
      '',
      '## Daily Trend',
      '| Date | Calls |',
      '|------|-------|',
      ...data.dailyTrend.slice(-7).map((d) => `| ${d.date} | ${d.count} |`),
    ]

    if (input.format === 'detailed' && data.byActor) {
      lines.push(
        '',
        '## Per-User Breakdown',
        '| User | Calls |',
        '|------|-------|',
        ...data.byActor.map((a) => `| ${a.actor} | ${a.count} |`)
      )
    }

    return lines.join('\n')
  }

  return stubUsageReport(input.period, input.format)
}
