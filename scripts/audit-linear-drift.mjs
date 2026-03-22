#!/usr/bin/env node
/**
 * Linear Drift Audit (SMI-3542)
 *
 * Detects Linear issues marked "Done" that lack corresponding source code
 * commits. Cross-references git log and GitHub PR API to verify each issue.
 *
 * Usage:
 *   node scripts/audit-linear-drift.mjs                     # Last 30 days
 *   node scripts/audit-linear-drift.mjs --since 2025-01-01  # Custom window
 *   node scripts/audit-linear-drift.mjs --json              # JSON output
 *
 * Environment:
 *   LINEAR_API_KEY  - Required for Linear GraphQL API
 *   GH_TOKEN        - Optional for GitHub PR search (uses gh CLI auth by default)
 *
 * npm script: npm run audit:drift
 */

import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'

// --- Configuration ---

const LINEAR_API_URL = 'https://api.linear.app/graphql'
const SOURCE_GLOBS = [
  'packages/**/*.ts',
  'packages/**/*.tsx',
  'scripts/**/*.ts',
  'scripts/**/*.mjs',
  'supabase/functions/**/*.ts',
]
const RETRY_DELAYS = [1000, 2000, 4000]
const ALLOWLIST_PATH = '.linear-drift-allowlist'

// --- Argument Parsing ---

function parseArgs() {
  const args = process.argv.slice(2)
  const sinceIdx = args.indexOf('--since')
  const jsonMode = args.includes('--json')

  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  let since = thirtyDaysAgo.toISOString().split('T')[0]
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    since = args[sinceIdx + 1]
  }

  return { since, jsonMode }
}

// --- Allowlist ---

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set()
  const content = readFileSync(ALLOWLIST_PATH, 'utf-8')
  const ids = content
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line.length > 0)
  return new Set(ids)
}

// --- Linear API ---

async function fetchWithRetry(url, options, retries = RETRY_DELAYS) {
  for (let i = 0; i <= retries.length; i++) {
    try {
      const res = await fetch(url, options)
      if (res.ok) return res
      if (res.status >= 500 && i < retries.length) {
        await new Promise((r) => setTimeout(r, retries[i]))
        continue
      }
      throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    } catch (err) {
      if (i < retries.length) {
        await new Promise((r) => setTimeout(r, retries[i]))
        continue
      }
      throw err
    }
  }
}

async function fetchDoneIssues(since) {
  const apiKey = process.env.LINEAR_API_KEY
  if (!apiKey) {
    console.error('LINEAR_API_KEY not set. Skipping drift audit.')
    process.exit(0)
  }

  const query = `
    query DoneIssues($after: String) {
      issues(
        filter: {
          team: { key: { eq: "SMI" } }
          state: { type: { eq: "completed" } }
          completedAt: { gte: "${since}T00:00:00Z" }
        }
        first: 100
        after: $after
      ) {
        nodes {
          identifier
          title
          completedAt
          state { name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `

  const allIssues = []
  let cursor = null

  do {
    const res = await fetchWithRetry(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables: { after: cursor } }),
    })

    const data = await res.json()
    if (data.errors) {
      console.error('Linear API error:', JSON.stringify(data.errors))
      process.exit(1)
    }

    const { nodes, pageInfo } = data.data.issues
    allIssues.push(...nodes)
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null
  } while (cursor)

  return allIssues
}

// --- Git & GitHub Verification ---

function hasGitCommitWithSource(issueId) {
  try {
    const diffFilter = SOURCE_GLOBS.map((g) => `-- '${g}'`).join(' ')
    const output = execFileSync(
      'git',
      [
        'log',
        '--all',
        `--grep=${issueId}`,
        '--diff-filter=AMR',
        '--format=%H',
        '--',
        ...SOURCE_GLOBS,
      ],
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim()

    return output.length > 0
  } catch {
    return false
  }
}

function hasMergedPrWithSource(issueId) {
  try {
    const output = execFileSync(
      'gh',
      [
        'api',
        'search/issues',
        '-f',
        `q=${issueId} repo:smith-horn/skillsmith is:pr is:merged`,
        '--jq',
        '.items | length',
      ],
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim()

    return parseInt(output, 10) > 0
  } catch {
    return false
  }
}

function isVerified(issueId) {
  return hasGitCommitWithSource(issueId) || hasMergedPrWithSource(issueId)
}

// --- Main ---

async function main() {
  const { since, jsonMode } = parseArgs()

  if (!jsonMode) {
    console.log(`Linear Drift Audit — checking issues completed since ${since}\n`)
  }

  const allowlist = loadAllowlist()
  const issues = await fetchDoneIssues(since)

  if (!jsonMode) {
    console.log(`Found ${issues.length} completed issues`)
  }

  const driftIssues = []
  const verifiedIssues = []
  const allowlistedIssues = []

  for (const issue of issues) {
    if (allowlist.has(issue.identifier)) {
      allowlistedIssues.push(issue)
      continue
    }

    if (isVerified(issue.identifier)) {
      verifiedIssues.push(issue)
    } else {
      driftIssues.push(issue)
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          since,
          total: issues.length,
          verified: verifiedIssues.length,
          drift: driftIssues.map((i) => ({
            id: i.identifier,
            title: i.title,
            completedAt: i.completedAt,
          })),
          allowlisted: allowlistedIssues.length,
        },
        null,
        2
      )
    )
  } else {
    console.log(`Verified: ${verifiedIssues.length}`)
    console.log(`Allowlisted: ${allowlistedIssues.length}`)
    console.log(`Drift detected: ${driftIssues.length}`)

    if (driftIssues.length > 0) {
      console.log('\n--- Issues marked Done without source commits ---\n')
      for (const issue of driftIssues) {
        console.log(
          `  ${issue.identifier}: ${issue.title} (completed: ${issue.completedAt?.split('T')[0]})`
        )
      }
    }
  }

  if (driftIssues.length > 0) {
    process.exit(1)
  }
}

// Only run when executed directly
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('audit-linear-drift.mjs') ||
    process.argv[1].endsWith('audit-linear-drift'))

if (isDirectExecution) {
  main().catch((err) => {
    console.error('Drift audit failed:', err.message)
    process.exit(1)
  })
}
