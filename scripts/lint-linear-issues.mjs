#!/usr/bin/env node
/**
 * Lint Linear Issues (SMI-5841)
 *
 * Scans recently-created Linear issues for the team's required-fields
 * template contract and reports violations. Exists because issue creation
 * via the MCP tool path (`mcp__linear__save_issue`) has no server-side
 * gate for this contract — only the CLI/SDK path
 * (`create-issue`/`create-sub-issue` in the user-level `linear` skill,
 * `~/.claude/skills/linear/`, not tracked by this repo) enforces it
 * programmatically. This script is the CI-side backstop for the MCP path.
 *
 * The validation contract itself (`validateIssueDescription` + its
 * constants) lives in `scripts/lib/linear-issue-validation.mjs` (extracted
 * SMI-5846) — that shared module is also consumed by
 * `scripts/linear-issue-creation-guard.mjs`'s client-side PreToolUse hook,
 * so both enforcement layers stay in sync by construction. See that
 * module's header for the full ported-rules provenance and sync caveat
 * against the untracked external source.
 *
 * Usage:
 *   node scripts/lint-linear-issues.mjs                       # last 48h
 *   node scripts/lint-linear-issues.mjs --since 2026-01-01
 *   node scripts/lint-linear-issues.mjs --json
 *
 * Environment:
 *   LINEAR_API_KEY  - Required for Linear GraphQL API
 *
 * Exit codes (mirrors scripts/audit-linear-drift.mjs's convention):
 *   0   No violations found
 *   1   One or more issues failed validation
 *   2   Could not run (missing LINEAR_API_KEY or a GraphQL error)
 *
 * npm script: npm run lint:linear-issues
 */
import { validateIssueDescription } from './lib/linear-issue-validation.mjs'

const LINEAR_API_URL = 'https://api.linear.app/graphql'
const TEAM_KEY = 'SMI'
const RETRY_DELAYS = [1000, 2000, 4000]

// Labels identifying issues created by this repo's own automation, not
// human work items — these never carry an Acceptance Criteria section
// by design and must not register as lint violations. Extend this list
// as new bot-generation labels are added (SMI-5853). Note:
// scripts/e2e/create-linear-issues.ts-created issues aren't yet
// excludable this way — that script computes a labels array but never
// attaches it to the mutation, a separate bug tracked as SMI-5855.
export const BOT_LABELS = ['version-drift-auto']

// --- CLI / date parsing ---

export function parseArgs(argv) {
  const sinceIdx = argv.indexOf('--since')
  const json = argv.includes('--json')
  let since
  if (sinceIdx !== -1 && argv[sinceIdx + 1]) {
    since = new Date(argv[sinceIdx + 1])
    if (Number.isNaN(since.getTime())) {
      console.error(`Invalid --since date: ${argv[sinceIdx + 1]}`)
      process.exit(2)
    }
  } else {
    since = new Date(Date.now() - 48 * 60 * 60 * 1000) // default: last 48h
  }
  return { since, json }
}

// --- Linear API (pattern matches scripts/linear-api.mjs / scripts/audit-linear-drift.mjs) ---

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

async function fetchRecentIssues(since) {
  const apiKey = process.env.LINEAR_API_KEY
  if (!apiKey) {
    console.error('LINEAR_API_KEY not set.')
    process.exit(2)
  }

  const query = `
    query RecentIssues($after: String, $since: DateTimeOrDuration!) {
      issues(
        filter: {
          team: { key: { eq: "${TEAM_KEY}" } }
          createdAt: { gte: $since }
        }
        first: 100
        after: $after
      ) {
        nodes {
          identifier
          title
          url
          description
          createdAt
          labels(first: 10) { nodes { name } }
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
      body: JSON.stringify({
        query,
        variables: { after: cursor, since: since.toISOString() },
      }),
    })

    const data = await res.json()
    if (data.errors) {
      console.error('lint-linear-issues: Linear query failed:', JSON.stringify(data.errors))
      process.exit(2)
    }

    const { nodes, pageInfo } = data.data.issues
    allIssues.push(...nodes)
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null
  } while (cursor)

  return allIssues
}

// --- Bot-issue exclusion (SMI-5853) ---

export function isBotGeneratedIssue(issue, botLabels = BOT_LABELS) {
  const names = issue?.labels?.nodes?.map((l) => l.name) ?? []
  return names.some((name) => botLabels.includes(name))
}

// --- Main ---

async function main() {
  const { since, json } = parseArgs(process.argv.slice(2))
  const issues = await fetchRecentIssues(since)

  const violations = []
  let botExcluded = 0
  for (const issue of issues) {
    if (isBotGeneratedIssue(issue)) {
      botExcluded += 1
      continue
    }
    const errors = validateIssueDescription(issue.description)
    if (errors.length > 0) {
      violations.push({
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        errors,
      })
    }
  }

  const result = { since: since.toISOString(), total: issues.length, botExcluded, violations }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(
      `Scanned ${result.total} issue(s) created since ${result.since} (${result.botExcluded} bot-generated, excluded)`
    )
    if (violations.length === 0) {
      console.log('No template-contract violations found.')
    } else {
      console.log(`${violations.length} violation(s):\n`)
      for (const v of violations) {
        console.log(`  ${v.identifier}: ${v.title} (${v.url})`)
        for (const err of v.errors) console.log(`    - ${err}`)
      }
    }
  }

  process.exit(violations.length > 0 ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('lint-linear-issues: unexpected error:', err)
    process.exit(2)
  })
}
