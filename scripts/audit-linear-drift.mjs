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
  'packages/**/*.astro',
  'packages/**/*.json',
  'packages/**/*.md',
  'packages/**/*.mjs',
  'packages/**/*.css',
  'scripts/**/*.ts',
  'scripts/**/*.mjs',
  'supabase/functions/**/*.ts',
  '.github/workflows/**',
]
const RETRY_DELAYS = [1000, 2000, 4000]
const ALLOWLIST_PATH = '.linear-drift-allowlist'

// --- Argument Parsing ---

function parseArgs() {
  const args = process.argv.slice(2)
  const sinceIdx = args.indexOf('--since')
  const jsonMode = args.includes('--json')
  const verbose = args.includes('--verbose')

  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  let since = thirtyDaysAgo.toISOString().split('T')[0]
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    since = args[sinceIdx + 1]
  }

  return { since, jsonMode, verbose }
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
    query DoneIssues($after: String, $since: DateTime!) {
      issues(
        filter: {
          team: { key: { eq: "SMI" } }
          state: { type: { eq: "completed" } }
          completedAt: { gte: $since }
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

  const sinceDateTime = `${since}T00:00:00Z`
  const allIssues = []
  let cursor = null

  do {
    const res = await fetchWithRetry(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query,
        variables: { after: cursor, since: sinceDateTime },
      }),
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

function hasMergedPr(issueId) {
  try {
    const output = execFileSync(
      'gh',
      [
        'search',
        'prs',
        issueId,
        '--repo',
        'smith-horn/skillsmith',
        '--state',
        'merged',
        '--json',
        'number',
        '--jq',
        'length',
      ],
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim()

    return parseInt(output, 10) > 0
  } catch {
    return false
  }
}

function hasAnyGitCommit(issueId) {
  try {
    const output = execFileSync('git', ['log', '--all', `--grep=${issueId}`, '--format=%H'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()

    return output.length > 0
  } catch {
    return false
  }
}

function verifyIssue(issueId, verbose) {
  if (hasGitCommitWithSource(issueId)) {
    if (verbose) console.error(`  ${issueId}: source-glob check HIT → verified`)
    return { status: 'verified', reason: 'source-commit' }
  }

  if (hasMergedPr(issueId)) {
    if (verbose) console.error(`  ${issueId}: source-glob MISS → pr-search HIT → verified`)
    return { status: 'verified', reason: 'merged-pr' }
  }

  if (hasAnyGitCommit(issueId)) {
    if (verbose)
      console.error(
        `  ${issueId}: source-glob MISS → pr-search MISS → any-commit HIT → mention-only`
      )
    return { status: 'mention-only', reason: 'commit-exists-no-source-glob' }
  }

  if (verbose)
    console.error(`  ${issueId}: source-glob MISS → pr-search MISS → any-commit MISS → unverified`)
  return { status: 'unverified', reason: 'no-commit-found' }
}

// --- Main ---

async function main() {
  const { since, jsonMode, verbose } = parseArgs()

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
  const mentionOnlyIssues = []
  const allowlistedIssues = []

  for (const issue of issues) {
    if (allowlist.has(issue.identifier)) {
      allowlistedIssues.push(issue)
      continue
    }

    const result = verifyIssue(issue.identifier, verbose)

    if (result.status === 'verified') {
      verifiedIssues.push(issue)
    } else if (result.status === 'mention-only') {
      mentionOnlyIssues.push({ ...issue, reason: result.reason })
    } else {
      driftIssues.push({ ...issue, reason: result.reason })
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          since,
          total: issues.length,
          verified: verifiedIssues.length,
          mentionOnly: mentionOnlyIssues.map((i) => ({
            id: i.identifier,
            title: i.title,
            completedAt: i.completedAt,
            reason: i.reason,
          })),
          drift: driftIssues.map((i) => ({
            id: i.identifier,
            title: i.title,
            completedAt: i.completedAt,
            reason: i.reason,
          })),
          allowlisted: allowlistedIssues.length,
        },
        null,
        2
      )
    )
  } else {
    console.log(`Verified: ${verifiedIssues.length}`)
    console.log(`Mention-only (commit exists, no source glob match): ${mentionOnlyIssues.length}`)
    console.log(`Allowlisted: ${allowlistedIssues.length}`)
    console.log(`Drift detected: ${driftIssues.length}`)

    if (mentionOnlyIssues.length > 0) {
      console.log('\n--- Issues with commits but no source glob match (informational) ---\n')
      for (const issue of mentionOnlyIssues) {
        console.log(`  ${issue.identifier}: ${issue.title} (reason: ${issue.reason})`)
      }
    }

    if (driftIssues.length > 0) {
      console.log('\n--- Issues marked Done without any commits ---\n')
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

export {
  loadAllowlist,
  parseArgs,
  hasGitCommitWithSource,
  hasMergedPr,
  hasAnyGitCommit,
  verifyIssue,
}
