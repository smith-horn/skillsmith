/**
 * @fileoverview Stub data generators and fallback handlers for analytics MCP tools
 * @module @skillsmith/mcp-server/tools/analytics.stub
 * @see SMI-3899: Team Usage Analytics MCP Tools (Wave 2b)
 * @see SMI-3914: Wave 0 stub extraction
 * @see SMI-3916: Wave 2 — stub fallbacks extracted from analytics.ts
 *
 * Extracted from analytics.ts for file-size compliance.
 * Provides deterministic mock data generators and fallback handler
 * implementations used when no real database is available.
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

// ============================================================================
// Stub fallback handlers — used when no real database is available
// ============================================================================

/** Stub fallback for team analytics dashboard */
export function stubTeamAnalyticsDashboard(period: string): string {
  const days = periodDays(period)
  const trend = generateDailyTrend(days)
  const totalCalls = trend.reduce((sum, d) => sum + d.calls, 0)

  const lines = [
    `# Team Analytics Dashboard (${period})`,
    '',
    '## Summary',
    `- **Period**: Last ${days} days`,
    `- **Total tool calls**: ${totalCalls}`,
    `- **Active users**: 4`,
    `- **Avg calls/user/day**: ${(totalCalls / (days * 4)).toFixed(1)}`,
    `- **Data source**: stub`,
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

/** Stub fallback for team usage report */
export function stubTeamUsageReport(period: string, format: string): string {
  const days = periodDays(period)
  const totalCalls = days * 25
  const previousCalls = Math.round(totalCalls * 0.85)
  const changePercent = (((totalCalls - previousCalls) / previousCalls) * 100).toFixed(1)

  const lines = [
    `# Team Usage Report (${period})`,
    '',
    '## Period Summary',
    `- **Current period**: ${totalCalls} total calls`,
    `- **Previous period**: ${previousCalls} total calls`,
    `- **Change**: +${changePercent}%`,
    `- **Active users**: 4`,
    `- **New skills installed**: 12`,
    `- **Data source**: stub`,
    '',
    '## Usage by Category',
    '| Category | Current | Previous | Change |',
    '|----------|---------|----------|--------|',
    `| Discovery (search, recommend) | ${Math.round(totalCalls * 0.45)} | ${Math.round(previousCalls * 0.42)} | +22% |`,
    `| Management (install, uninstall) | ${Math.round(totalCalls * 0.3)} | ${Math.round(previousCalls * 0.32)} | +8% |`,
    `| Quality (validate, audit) | ${Math.round(totalCalls * 0.15)} | ${Math.round(previousCalls * 0.16)} | +8% |`,
    `| Collaboration (workspace, share) | ${Math.round(totalCalls * 0.1)} | ${Math.round(previousCalls * 0.1)} | +15% |`,
  ]

  if (format === 'detailed') {
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

/** Stub fallback for enterprise analytics dashboard */
export function stubAnalyticsDashboard(period: string, includeRecommendations: boolean): string {
  const days = periodDays(period)
  const totalCalls = days * 85

  const lines = [
    `# Enterprise Analytics Dashboard (${period})`,
    '',
    '## Organization Summary',
    `- **Period**: Last ${days} days`,
    `- **Total tool calls**: ${totalCalls}`,
    `- **Active teams**: 3`,
    `- **Active users**: 18`,
    `- **Skills installed org-wide**: 47`,
    `- **Data source**: stub`,
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

  if (includeRecommendations) {
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

/** Stub fallback for enterprise usage report */
export function stubUsageReport(period: string, format: string): string {
  const days = periodDays(period)
  const totalCalls = days * 85
  const previousCalls = Math.round(totalCalls * 0.78)
  const changePercent = (((totalCalls - previousCalls) / previousCalls) * 100).toFixed(1)

  if (format === 'csv') {
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
    `# Enterprise Usage Report (${period})`,
    '',
    '## Executive Summary',
    `- **Period**: Last ${days} days`,
    `- **Total tool calls**: ${totalCalls} (+${changePercent}% vs previous)`,
    `- **Active users**: 18 (up from 15)`,
    `- **Active teams**: 3`,
    `- **Skills installed**: 47 (up from 38)`,
    `- **Data source**: stub`,
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

  if (format === 'detailed') {
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
