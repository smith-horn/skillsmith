/**
 * @fileoverview Stub data generators for analytics MCP tools
 * @module @skillsmith/mcp-server/tools/analytics.stub
 * @see SMI-3899: Team Usage Analytics MCP Tools (Wave 2b)
 * @see SMI-3914: Wave 0 stub extraction
 *
 * Extracted from analytics.ts for file-size compliance.
 * Provides deterministic mock data generators for analytics dashboards.
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
