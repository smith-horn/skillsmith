/**
 * @fileoverview Real analytics service — queries audit_logs SQLite table
 * @module @skillsmith/mcp-server/tools/analytics.service
 * @see SMI-3916: Wave 2 — Analytics real queries
 *
 * Replaces stub mock data with actual SQL queries against the local
 * audit_logs table. Falls back to the stub when no database is available.
 */

import type { Database } from '@skillsmith/core'

// ============================================================================
// Types
// ============================================================================

export interface AnalyticsData {
  totalToolCalls: number
  uniqueTools: number
  topTools: Array<{ tool: string; count: number }>
  dailyTrend: Array<{ date: string; count: number }>
  periodComparison: { current: number; previous: number; changePercent: number }
}

export interface UsageReportData extends AnalyticsData {
  byActor?: Array<{ actor: string; count: number }>
}

// ============================================================================
// Service factory
// ============================================================================

export interface AnalyticsService {
  getDashboardData(periodDays: number): AnalyticsData
  getUsageReport(periodDays: number, detailed: boolean): UsageReportData
}

/**
 * Create an analytics service backed by real SQLite queries.
 *
 * audit_logs schema columns used:
 * - timestamp (TEXT, ISO-8601) — event time
 * - resource (TEXT) — tool/resource name
 * - actor (TEXT, nullable) — user identifier
 */
export function createRealAnalyticsService(db: Database): AnalyticsService {
  return {
    getDashboardData(periodDays: number): AnalyticsData {
      const since = new Date(Date.now() - periodDays * 86_400_000).toISOString()

      const totalRow = db
        .prepare<{ count: number }>('SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= ?')
        .get(since)
      const totalToolCalls = totalRow?.count ?? 0

      const uniqueRow = db
        .prepare<{
          count: number
        }>('SELECT COUNT(DISTINCT resource) as count FROM audit_logs WHERE timestamp >= ?')
        .get(since)
      const uniqueTools = uniqueRow?.count ?? 0

      const topTools = db
        .prepare<{
          tool: string
          count: number
        }>('SELECT resource as tool, COUNT(*) as count FROM audit_logs ' + 'WHERE timestamp >= ? AND resource IS NOT NULL ' + 'GROUP BY resource ORDER BY count DESC LIMIT 10')
        .all(since)

      const dailyTrend = db
        .prepare<{
          date: string
          count: number
        }>('SELECT DATE(timestamp) as date, COUNT(*) as count FROM audit_logs ' + 'WHERE timestamp >= ? GROUP BY DATE(timestamp) ORDER BY date')
        .all(since)

      // Period comparison: current vs previous period of same length
      const previousSince = new Date(Date.now() - periodDays * 2 * 86_400_000).toISOString()
      const previousRow = db
        .prepare<{
          count: number
        }>('SELECT COUNT(*) as count FROM audit_logs WHERE timestamp >= ? AND timestamp < ?')
        .get(previousSince, since)
      const previous = previousRow?.count ?? 0
      const changePercent =
        previous > 0 ? Math.round(((totalToolCalls - previous) / previous) * 100) : 0

      return {
        totalToolCalls,
        uniqueTools,
        topTools,
        dailyTrend,
        periodComparison: { current: totalToolCalls, previous, changePercent },
      }
    },

    getUsageReport(periodDays: number, detailed: boolean): UsageReportData {
      const data = this.getDashboardData(periodDays)

      if (!detailed) {
        return data
      }

      // Add per-actor breakdown for detailed mode
      const since = new Date(Date.now() - periodDays * 86_400_000).toISOString()
      const byActor = db
        .prepare<{
          actor: string
          count: number
        }>('SELECT actor, COUNT(*) as count FROM audit_logs ' + 'WHERE timestamp >= ? AND actor IS NOT NULL ' + 'GROUP BY actor ORDER BY count DESC LIMIT 20')
        .all(since)

      return { ...data, byActor }
    },
  }
}
