#!/usr/bin/env npx tsx
/**
 * Linear A/B Test Cleanup Script
 *
 * Archives or deletes Linear issues created during A/B testing.
 * Looks for issues with "[AB-TEST]" prefix in the title.
 *
 * Usage:
 *   npx tsx scripts/linear-ab-test-cleanup.ts --archive
 *   npx tsx scripts/linear-ab-test-cleanup.ts --delete --dry-run
 *   npx tsx scripts/linear-ab-test-cleanup.ts --list
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// Types
// ============================================================================

interface LinearIssue {
  id: string
  identifier: string
  title: string
  status: string
  createdAt: string
  url: string
}

interface CleanupOptions {
  action: 'archive' | 'delete' | 'list'
  team: string
  dryRun: boolean
  verbose: boolean
  limit: number
}

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

const AB_TEST_PREFIX = '[AB-TEST]'

// ============================================================================
// Linear Operations via Claude
// ============================================================================

function listABTestIssues(teamName: string, limit: number): LinearIssue[] {
  const prompt = `Using mcp__linear__list_issues, find all issues containing "${AB_TEST_PREFIX}" in the title for team "${teamName}". Return up to ${limit} issues. Output ONLY a JSON array of objects with fields: id, identifier, title, status, createdAt, url. No markdown, no explanation.`

  const result = spawnSync(
    'claude',
    ['--print', '--output-format', 'json', '--dangerously-skip-permissions', prompt],
    {
      encoding: 'utf-8',
      timeout: 120000,
      cwd: PROJECT_ROOT,
      maxBuffer: 5 * 1024 * 1024,
    }
  )

  if (result.error || result.status !== 0) {
    console.error('Failed to list issues:', result.error || result.stderr)
    return []
  }

  // Extract JSON array from response
  try {
    const output = result.stdout || ''
    const jsonMatch = output.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
  } catch (err) {
    console.error('Failed to parse issues:', err)
  }

  return []
}

function archiveIssue(issueId: string): boolean {
  const prompt = `Using mcp__linear__update_issue, update issue ${issueId} to set state to "Canceled". Return only "success" or "failed".`

  const result = spawnSync(
    'claude',
    ['--print', '--output-format', 'json', '--dangerously-skip-permissions', prompt],
    {
      encoding: 'utf-8',
      timeout: 60000,
      cwd: PROJECT_ROOT,
    }
  )

  return result.status === 0
}

function deleteIssue(issueId: string): boolean {
  // Linear doesn't support true deletion via API, so we archive instead
  return archiveIssue(issueId)
}

// ============================================================================
// Cleanup Functions
// ============================================================================

function runCleanup(options: CleanupOptions): void {
  const { action, team, dryRun, verbose, limit } = options

  if (verbose) {
    console.log(`\nSearching for ${AB_TEST_PREFIX} issues in team "${team}"...`)
  }

  const issues = listABTestIssues(team, limit)

  if (issues.length === 0) {
    console.log('No AB-TEST issues found.')
    return
  }

  console.log(`\nFound ${issues.length} AB-TEST issue(s):`)
  for (const issue of issues) {
    console.log(`  ${issue.identifier}: ${issue.title} (${issue.status})`)
  }

  if (action === 'list') {
    return
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would ${action} ${issues.length} issue(s).`)
    return
  }

  console.log(`\n${action === 'archive' ? 'Archiving' : 'Deleting'} ${issues.length} issue(s)...`)

  let successCount = 0
  for (const issue of issues) {
    if (verbose) {
      process.stdout.write(`  ${issue.identifier}...`)
    }

    const success =
      action === 'archive' ? archiveIssue(issue.identifier) : deleteIssue(issue.identifier)

    if (success) {
      successCount++
      if (verbose) {
        console.log(' done')
      }
    } else {
      if (verbose) {
        console.log(' FAILED')
      }
    }
  }

  console.log(
    `\nCompleted: ${successCount}/${issues.length} issue(s) ${action === 'archive' ? 'archived' : 'deleted'}.`
  )
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): CleanupOptions {
  const args = process.argv.slice(2)

  const options: CleanupOptions = {
    action: 'list',
    team: 'Skillsmith',
    dryRun: false,
    verbose: true,
    limit: 100,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--archive':
        options.action = 'archive'
        break
      case '--delete':
        options.action = 'delete'
        break
      case '--list':
        options.action = 'list'
        break
      case '--team':
        options.team = args[++i]
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--quiet':
      case '-q':
        options.verbose = false
        break
      case '--limit':
      case '-n':
        options.limit = parseInt(args[++i], 10)
        break
      case '--help':
      case '-h':
        console.log(`
Linear A/B Test Cleanup

Archives or lists Linear issues with "[AB-TEST]" prefix.

Usage:
  npx tsx scripts/linear-ab-test-cleanup.ts [options]

Options:
  --list              List AB-TEST issues (default)
  --archive           Archive (cancel) AB-TEST issues
  --delete            Delete AB-TEST issues (same as archive)
  --team <name>       Linear team name (default: Skillsmith)
  --limit, -n <n>     Maximum issues to process (default: 100)
  --dry-run           Show what would be done without doing it
  --quiet, -q         Suppress verbose output
  --help, -h          Show this help

Examples:
  npx tsx scripts/linear-ab-test-cleanup.ts --list
  npx tsx scripts/linear-ab-test-cleanup.ts --archive --dry-run
  npx tsx scripts/linear-ab-test-cleanup.ts --archive --team "Smith Horn Group"
`)
        process.exit(0)
    }
  }

  return options
}

function main(): void {
  const options = parseArgs()

  console.log('╔═══════════════════════════════════════════════════════════════╗')
  console.log('║          Linear A/B Test Cleanup                              ║')
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log(`║  Action: ${options.action.padEnd(52)} ║`)
  console.log(`║  Team: ${options.team.padEnd(54)} ║`)
  console.log(`║  Dry Run: ${String(options.dryRun).padEnd(51)} ║`)
  console.log('╚═══════════════════════════════════════════════════════════════╝')

  runCleanup(options)
}

main()
