#!/usr/bin/env node
/**
 * SMI-714: Retrospective Generation Script
 *
 * Generates phase retrospectives by querying Linear for completed issues
 * and producing standardized markdown documentation.
 *
 * Usage:
 *   node scripts/generate-retro.mjs --phase "2c" --start "2025-12-28" --end "2025-12-29"
 *   node scripts/generate-retro.mjs --phase "2c" --start "2025-12-28" --end "2025-12-29" --dry-run
 *
 * Environment:
 *   LINEAR_API_KEY - Required API key for authentication
 */

import { graphql, getTeamId } from './linear-api.mjs'

const TEAM_KEY = 'SMI'

// Issue categories based on labels or title patterns
const CATEGORIES = {
  Critical: ['critical', 'security', 'vulnerability', 'cve'],
  Security: ['security', 'auth', 'injection', 'xss', 'csrf', 'prototype pollution'],
  'CI/CD': ['ci', 'cd', 'pipeline', 'github actions', 'workflow', 'deploy'],
  Performance: ['perf', 'performance', 'benchmark', 'latency', 'cache', 'optimization'],
  DX: ['dx', 'developer experience', 'hook', 'lint', 'format', 'tooling'],
  Testing: ['test', 'coverage', 'tdd', 'integration', 'unit'],
  Documentation: ['doc', 'readme', 'retro', 'adr'],
  Feature: ['feat', 'feature', 'implement'],
  Bugfix: ['fix', 'bug', 'issue', 'error'],
  Other: [],
}

/**
 * Parse command line arguments
 */
function parseArgs(args) {
  const result = { _: [] }
  let currentKey = null

  for (const arg of args) {
    if (arg.startsWith('--')) {
      currentKey = arg.slice(2).replace(/-/g, '_')
      result[currentKey] = true
    } else if (currentKey) {
      result[currentKey] = arg
      currentKey = null
    } else {
      result._.push(arg)
    }
  }

  return result
}

/**
 * Query completed issues within a date range
 */
async function queryCompletedIssues(startDate, endDate) {
  const teamId = await getTeamId(TEAM_KEY)

  const data = await graphql(
    `
      query CompletedIssues($teamId: ID!) {
        issues(
          filter: { team: { id: { eq: $teamId } }, state: { type: { eq: "completed" } } }
          first: 100
          orderBy: updatedAt
        ) {
          nodes {
            id
            identifier
            title
            description
            priority
            createdAt
            completedAt
            startedAt
            labels {
              nodes {
                name
              }
            }
            state {
              name
              type
            }
            parent {
              identifier
              title
            }
            children {
              nodes {
                identifier
                title
                state {
                  name
                }
              }
            }
          }
        }
      }
    `,
    { teamId }
  )

  // Filter by date range client-side (Linear API date filtering is limited)
  const startMs = new Date(startDate).getTime()
  const endMs = new Date(endDate + 'T23:59:59').getTime()

  return data.issues.nodes.filter((issue) => {
    if (!issue.completedAt) return false
    const completedMs = new Date(issue.completedAt).getTime()
    return completedMs >= startMs && completedMs <= endMs
  })
}

/**
 * Categorize an issue based on labels and title
 */
function categorizeIssue(issue) {
  const labelNames = issue.labels?.nodes?.map((l) => l.name.toLowerCase()) || []
  const titleLower = issue.title.toLowerCase()
  const descLower = (issue.description || '').toLowerCase()
  const searchText = `${titleLower} ${labelNames.join(' ')} ${descLower}`

  for (const [category, keywords] of Object.entries(CATEGORIES)) {
    if (category === 'Other') continue
    for (const keyword of keywords) {
      if (searchText.includes(keyword)) {
        return category
      }
    }
  }

  return 'Other'
}

/**
 * Calculate time to resolution in hours
 */
function calculateResolutionTime(issue) {
  if (!issue.completedAt) return null
  const start = issue.startedAt ? new Date(issue.startedAt) : new Date(issue.createdAt)
  const end = new Date(issue.completedAt)
  const hours = (end - start) / (1000 * 60 * 60)
  return Math.round(hours * 10) / 10
}

/**
 * Group issues by category and calculate metrics
 */
function processIssues(issues) {
  const byCategory = {}
  const metrics = {
    totalIssues: issues.length,
    totalResolutionHours: 0,
    issuesByPriority: { 1: 0, 2: 0, 3: 0, 4: 0 },
    parentIssues: 0,
    subIssues: 0,
  }

  for (const issue of issues) {
    const category = categorizeIssue(issue)

    if (!byCategory[category]) {
      byCategory[category] = {
        issues: [],
        count: 0,
        totalHours: 0,
      }
    }

    const resolutionHours = calculateResolutionTime(issue)
    byCategory[category].issues.push({
      ...issue,
      category,
      resolutionHours,
    })
    byCategory[category].count++
    if (resolutionHours) {
      byCategory[category].totalHours += resolutionHours
      metrics.totalResolutionHours += resolutionHours
    }

    // Track priority distribution
    if (issue.priority >= 1 && issue.priority <= 4) {
      metrics.issuesByPriority[issue.priority]++
    }

    // Track parent/sub-issue counts
    if (issue.children?.nodes?.length > 0) {
      metrics.parentIssues++
    }
    if (issue.parent) {
      metrics.subIssues++
    }
  }

  return { byCategory, metrics }
}

/**
 * Generate markdown retrospective content
 */
function generateMarkdown(phase, startDate, endDate, issues, byCategory, metrics) {
  const today = new Date().toISOString().split('T')[0]
  const avgResolution =
    metrics.totalIssues > 0
      ? Math.round((metrics.totalResolutionHours / metrics.totalIssues) * 10) / 10
      : 0

  let md = `# Phase ${phase} Retrospective

**Date:** ${today}
**Sprint Duration:** ${startDate} to ${endDate}
**Team:** Claude Code Automated Development
**Issues Completed:** ${metrics.totalIssues}

---

## Summary

Phase ${phase} completed **${metrics.totalIssues} issues** with an average resolution time of **${avgResolution} hours**.

### Key Metrics

| Metric | Value |
|--------|-------|
| Issues Completed | ${metrics.totalIssues} |
| Parent Issues | ${metrics.parentIssues} |
| Sub-Issues | ${metrics.subIssues} |
| Avg Resolution Time | ${avgResolution} hours |
| Urgent (P1) | ${metrics.issuesByPriority[1]} |
| High (P2) | ${metrics.issuesByPriority[2]} |
| Medium (P3) | ${metrics.issuesByPriority[3]} |
| Low (P4) | ${metrics.issuesByPriority[4]} |

---

## What Went Well

<!-- Add observations about what worked well during this phase -->

1. **[Add observation]**: Description
2. **[Add observation]**: Description
3. **[Add observation]**: Description

---

## Challenges

<!-- Add challenges encountered and how they were resolved -->

1. **[Challenge]**: Description and resolution
2. **[Challenge]**: Description and resolution

---

## Issues by Category

`

  // Add category breakdown
  const sortedCategories = Object.entries(byCategory).sort((a, b) => b[1].count - a[1].count)

  for (const [category, data] of sortedCategories) {
    const avgTime = data.count > 0 ? Math.round((data.totalHours / data.count) * 10) / 10 : 0

    md += `### ${category} (${data.count} issues, avg ${avgTime}h)

| Issue | Title | Priority | Resolution |
|-------|-------|----------|------------|
`

    for (const issue of data.issues) {
      const priority = ['', 'Urgent', 'High', 'Medium', 'Low'][issue.priority] || '-'
      const resolution = issue.resolutionHours ? `${issue.resolutionHours}h` : '-'
      const title = issue.title.length > 50 ? issue.title.slice(0, 47) + '...' : issue.title
      md += `| ${issue.identifier} | ${title} | ${priority} | ${resolution} |\n`
    }

    md += '\n'
  }

  md += `---

## Detailed Issue List

| Issue | Title | Category | State | Completed |
|-------|-------|----------|-------|-----------|
`

  for (const issue of issues) {
    const category = categorizeIssue(issue)
    const completed = issue.completedAt ? new Date(issue.completedAt).toLocaleDateString() : '-'
    const title = issue.title.length > 40 ? issue.title.slice(0, 37) + '...' : issue.title
    md += `| ${issue.identifier} | ${title} | ${category} | ${issue.state.name} | ${completed} |\n`
  }

  md += `
---

## Key Learnings

<!-- Document important lessons learned during this phase -->

1. **[Learning 1]**: Description
2. **[Learning 2]**: Description
3. **[Learning 3]**: Description

---

## Recommendations for Next Phase

### Process Improvements

1. [Improvement 1]
2. [Improvement 2]

### Technical Debt

1. [Item 1]
2. [Item 2]

---

*Generated by Claude Code retrospective automation (SMI-714)*
`

  return md
}

/**
 * Main execution
 */
async function main() {
  const args = parseArgs(process.argv.slice(2))

  // Validate required arguments
  if (!args.phase) {
    console.error('Error: --phase is required (e.g., --phase "2c")')
    process.exit(1)
  }

  if (!args.start) {
    console.error('Error: --start is required (e.g., --start "2025-12-28")')
    process.exit(1)
  }

  if (!args.end) {
    console.error('Error: --end is required (e.g., --end "2025-12-29")')
    process.exit(1)
  }

  const { phase, start, end, dry_run: dryRun, output } = args

  console.log(`Generating retrospective for Phase ${phase}`)
  console.log(`Date range: ${start} to ${end}`)
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)
  console.log('')

  try {
    // Query Linear for completed issues
    console.log('Querying Linear for completed issues...')
    const issues = await queryCompletedIssues(start, end)
    console.log(`Found ${issues.length} completed issues`)

    if (issues.length === 0) {
      console.log('\nNo completed issues found in the specified date range.')
      console.log('Generating template retrospective anyway...')
    }

    // Process and categorize issues
    const { byCategory, metrics } = processIssues(issues)

    // Generate markdown
    const markdown = generateMarkdown(phase, start, end, issues, byCategory, metrics)

    // Determine output path
    const outputPath =
      output || `docs/retros/phase-${phase.toLowerCase().replace(/\s+/g, '-')}-generated.md`

    if (dryRun) {
      console.log('\n--- DRY RUN OUTPUT ---\n')
      console.log(markdown)
      console.log('\n--- END DRY RUN ---\n')
      console.log(`Would write to: ${outputPath}`)
    } else {
      // Write to file
      const fs = await import('node:fs/promises')
      const path = await import('node:path')

      // Ensure directory exists
      const dir = path.dirname(outputPath)
      await fs.mkdir(dir, { recursive: true })

      await fs.writeFile(outputPath, markdown, 'utf-8')
      console.log(`\nRetrospective written to: ${outputPath}`)
    }

    // Print summary
    console.log('\n--- Summary ---')
    console.log(`Total issues: ${metrics.totalIssues}`)
    console.log(`Categories: ${Object.keys(byCategory).join(', ')}`)
    console.log(
      `Avg resolution: ${metrics.totalIssues > 0 ? Math.round((metrics.totalResolutionHours / metrics.totalIssues) * 10) / 10 : 0}h`
    )

    // Category breakdown
    console.log('\nBy Category:')
    for (const [cat, data] of Object.entries(byCategory).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${cat}: ${data.count} issues`)
    }
  } catch (error) {
    console.error(`Error: ${error.message}`)
    if (error.message.includes('LINEAR_API_KEY')) {
      console.error('\nMake sure LINEAR_API_KEY is set in your environment.')
      console.error('You can use varlock: varlock run -- node scripts/generate-retro.mjs ...')
    }
    process.exit(1)
  }
}

main()

// Export for testing
export {
  parseArgs,
  categorizeIssue,
  calculateResolutionTime,
  processIssues,
  generateMarkdown,
  queryCompletedIssues,
  CATEGORIES,
}
