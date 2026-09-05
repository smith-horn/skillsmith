/**
 * @fileoverview Shared date/period helpers for analytics MCP tools
 * @module @skillsmith/mcp-server/tools/analytics.stub
 * @see SMI-3899: Team Usage Analytics MCP Tools (Wave 2b)
 * @see SMI-3914: Wave 0 stub extraction
 * @see SMI-3916: Wave 2 — stub fallbacks extracted from analytics.ts
 * @see SMI-6362 Wave 4 — the four fabricated stub-response generators this file used to hold
 *   (fake emails, fake team names, fake percentages) were removed. All four Team/Enterprise
 *   analytics tools are cloud-first now (analytics.actions.ts) and render an actionable error
 *   instead of silently falling back to fabricated data when the cloud path is unavailable — see
 *   analytics.actions.ts's module doc comment. Keeping fabricated-data generators around unused
 *   was itself a regression risk: a future change re-wiring them back in would silently
 *   reintroduce the exact invisible-success failure mode this feature exists to fix.
 */

// ============================================================================
// Mock data helpers
// ============================================================================

/** Map period string to number of days */
export function periodDays(period: string): number {
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
export function generateDailyTrend(days: number): Array<{ date: string; calls: number }> {
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
