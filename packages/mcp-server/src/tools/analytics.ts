/**
 * @fileoverview Analytics MCP tools — team and enterprise usage dashboards
 * @module @skillsmith/mcp-server/tools/analytics
 * @see SMI-3899: Team Usage Analytics MCP Tools (Wave 2b)
 * @see SMI-6362 Wave 4: Wire Team/Enterprise analytics tools to cloud-aggregated MCP tool-call data
 *
 * Split-tier analytics:
 * - Team tier: team_analytics_dashboard, team_usage_report (usage_analytics flag)
 * - Enterprise tier: analytics_dashboard, usage_report (advanced_analytics flag)
 *
 * Tier gating happens one layer above this file (MCP tool registration / license.gate.ts, not
 * touched by this wave) — Community/Individual callers never reach the handlers below. A
 * Team/Enterprise caller that does reach them resolves against cloud-aggregated `search_metrics`
 * data via `SupabaseAnalyticsService` (analytics.supabase.service.ts), which requires both a
 * `skillsmith login` session (who is calling) and an active Team/Enterprise license/API key (which
 * team) — see analytics.actions.ts's `resolveCloudAnalytics()`. Neither a missing credential nor a
 * cloud RPC failure falls through to local/stub data; both render an actionable error instead
 * (SMI-6362 Wave 4 D-2c / AC-10) — there is no more silent "Uses real SQLite queries ... falls
 * back to stub mock data" behavior for these four tools.
 *
 * SMI-5127 / SMI-6362 Wave 4: the four action-handler implementations, their withTelemetry-wrapped
 * exports, and the cloud credential-resolution + rendering helpers live in the sibling
 * analytics.actions.ts (500-line audit:standards budget split) — re-exported below unchanged. See
 * that file's header for the full three-outcome resolution flow, and its
 * `resolveCloudAnalytics()`/`CloudAnalyticsResolution` for the credential-resolution logic an
 * adversarial review should scope to.
 */

import { z } from 'zod'

// Re-export stub helpers for external consumers
export { periodDays, generateDailyTrend } from './analytics.stub.js'

// SMI-5127 / SMI-6362 Wave 4: action-handler implementations + withTelemetry-wrapped exports now
// live in analytics.actions.ts — re-exported here unchanged.
export {
  executeTeamAnalyticsDashboard,
  executeTeamUsageReport,
  executeAnalyticsDashboard,
  executeUsageReport,
} from './analytics.actions.js'

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
    'Enterprise analytics dashboard: recommendation accuracy, skill usage trends, ' +
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
