#!/usr/bin/env node
/**
 * Linear Sync - Automatically update Linear issues based on git activity
 *
 * Usage:
 *   node scripts/linear-sync.mjs done SMI-619        # Mark issue as done
 *   node scripts/linear-sync.mjs in-progress SMI-619 # Mark as in progress
 *   node scripts/linear-sync.mjs from-commit         # Parse last commit for issue IDs
 *   node scripts/linear-sync.mjs check               # Show issues mentioned in recent commits
 *
 * Environment:
 *   LINEAR_API_KEY - Required for API calls
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Configuration
const LINEAR_SKILL_PATH = join(
  homedir(),
  '.claude/skills/linear/skills/linear/scripts/linear-api.mjs'
)
const ISSUE_PATTERN = /\b(SMI-\d+)\b/gi

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
}

function log(color, symbol, message) {
  console.log(`${color}${symbol}${colors.reset} ${message}`)
}

function success(msg) {
  log(colors.green, '✓', msg)
}
function warn(msg) {
  log(colors.yellow, '⚠', msg)
}
function error(msg) {
  log(colors.red, '✗', msg)
}
function info(msg) {
  log(colors.cyan, '→', msg)
}

/**
 * Extract issue IDs from text
 */
function extractIssues(text) {
  const matches = text.match(ISSUE_PATTERN) || []
  return [...new Set(matches.map((m) => m.toUpperCase()))]
}

/**
 * Get the last N commit messages
 */
function getRecentCommits(count = 5) {
  try {
    const output = execSync(`git log --oneline -${count}`, { encoding: 'utf-8' })
    return output.trim().split('\n')
  } catch (err) {
    error('Failed to get git log')
    return []
  }
}

/**
 * Get the last commit message
 */
function getLastCommit() {
  try {
    return execSync('git log -1 --format=%B', { encoding: 'utf-8' }).trim()
  } catch (err) {
    error('Failed to get last commit')
    return ''
  }
}

/**
 * Update Linear issue status using the Linear skill
 */
async function updateLinearStatus(issueId, status) {
  if (!existsSync(LINEAR_SKILL_PATH)) {
    error(`Linear skill not found at: ${LINEAR_SKILL_PATH}`)
    console.log('Install the Linear skill: ~/.claude/skills/linear/')
    return false
  }

  if (!process.env.LINEAR_API_KEY) {
    error('LINEAR_API_KEY environment variable not set')
    return false
  }

  try {
    info(`Updating ${issueId} to ${status}...`)
    const result = execSync(
      `node "${LINEAR_SKILL_PATH}" update-status --issue "${issueId}" --status "${status}"`,
      { encoding: 'utf-8', env: process.env }
    )
    success(`Updated: ${issueId} → ${status}`)
    return true
  } catch (err) {
    error(`Failed to update ${issueId}: ${err.message}`)
    return false
  }
}

/**
 * Parse status string to Linear status
 * SMI-905: Fixed - Linear API expects 'in progress' (with space), not 'in_progress'
 */
function normalizeStatus(status) {
  const statusMap = {
    done: 'done',
    complete: 'done',
    completed: 'done',
    finished: 'done',
    'in-progress': 'in progress',
    in_progress: 'in progress',
    inprogress: 'in progress',
    started: 'in progress',
    wip: 'in progress',
    todo: 'todo',
    backlog: 'backlog',
  }
  return statusMap[status.toLowerCase()] || status
}

/**
 * Main command handler
 */
async function main() {
  const [, , command, ...args] = process.argv

  if (!command) {
    console.log(`
Linear Sync - Keep Linear issues in sync with git activity

Usage:
  linear-sync done <issue-id>        Mark issue as done
  linear-sync in-progress <issue-id> Mark issue as in progress
  linear-sync from-commit            Update issues from last commit message
  linear-sync check                  Show issues in recent commits

Examples:
  npm run linear:done SMI-619
  npm run linear:wip SMI-640
  npm run linear:check
`)
    process.exit(0)
  }

  switch (command) {
    case 'done':
    case 'in-progress':
    case 'in_progress':
    case 'todo':
    case 'backlog': {
      const issueId = args[0]
      if (!issueId) {
        error('Issue ID required. Example: linear-sync done SMI-619')
        process.exit(1)
      }
      const status = normalizeStatus(command)
      const ok = await updateLinearStatus(issueId.toUpperCase(), status)
      process.exit(ok ? 0 : 1)
      break
    }

    case 'from-commit': {
      const commit = getLastCommit()
      const issues = extractIssues(commit)

      if (issues.length === 0) {
        warn('No issue IDs found in last commit')
        console.log(`${colors.dim}Commit: ${commit.split('\n')[0]}${colors.reset}`)
        process.exit(0)
      }

      info(`Found issues in commit: ${issues.join(', ')}`)

      // Determine status from commit message
      let status = 'done' // default
      const commitLower = commit.toLowerCase()
      if (commitLower.includes('wip') || commitLower.includes('in progress')) {
        status = 'in_progress'
      }

      let allOk = true
      for (const issue of issues) {
        const ok = await updateLinearStatus(issue, status)
        if (!ok) allOk = false
      }
      process.exit(allOk ? 0 : 1)
      break
    }

    case 'check': {
      const commits = getRecentCommits(10)
      const issueMap = new Map()

      for (const commit of commits) {
        const issues = extractIssues(commit)
        for (const issue of issues) {
          if (!issueMap.has(issue)) {
            issueMap.set(issue, commit)
          }
        }
      }

      if (issueMap.size === 0) {
        info('No issue IDs found in recent commits')
        process.exit(0)
      }

      console.log('\nIssues mentioned in recent commits:\n')
      for (const [issue, commit] of issueMap) {
        console.log(`  ${colors.cyan}${issue}${colors.reset}`)
        console.log(`    ${colors.dim}${commit}${colors.reset}\n`)
      }
      break
    }

    default:
      error(`Unknown command: ${command}`)
      console.log('Run without arguments for usage information.')
      process.exit(1)
  }
}

main().catch((err) => {
  error(err.message)
  process.exit(1)
})
