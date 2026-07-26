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
 * Validation contract is PORTED from
 * `~/.claude/skills/linear/scripts/lib/issue-description.ts`'s
 * `validateIssueDescription()` — that file is not trackable from this
 * repo's CI (a personal, untracked package), so the rules below must be
 * kept in sync BY HAND if that source ever changes its contract. Ported
 * rules (all required to pass):
 *   1. Non-empty after trim.
 *   2. Body >= MIN_BODY_CHARS after stripping heading lines.
 *   3. Contains an "Acceptance Criteria" heading (H1-H6).
 *   4. >= MIN_AC_ITEMS non-placeholder bulleted items under that heading.
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

const LINEAR_API_URL = 'https://api.linear.app/graphql'
const TEAM_KEY = 'SMI'
const RETRY_DELAYS = [1000, 2000, 4000]

// --- Ported validation contract (see file header for provenance) ---

const MIN_BODY_CHARS = 120
const MIN_AC_ITEMS = 2
const AC_HEADING_RE = /^#{1,6}\s+Acceptance Criteria\b.*$/im
const PLACEHOLDER_RE = /^\s*(TODO|FIXME|TBD|TBA|N\/A|XXX|\?+|<[^>]*>|\.\.\.|-{2,}|_{2,})\s*$/i

/**
 * Validate an issue description against the ported Acceptance Criteria
 * contract. Returns a list of error strings (empty = valid).
 *
 * @param {string | null | undefined} description
 * @returns {string[]}
 */
export function validateIssueDescription(description) {
  const errors = []
  const trimmed = (description ?? '').trim()

  if (trimmed.length === 0) {
    errors.push('Description is empty')
    return errors
  }

  const bodyChars = trimmed
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join('\n').length
  if (bodyChars < MIN_BODY_CHARS) {
    errors.push(`Description body is ${bodyChars} chars; minimum is ${MIN_BODY_CHARS}`)
  }

  const acHeadingMatch = trimmed.match(AC_HEADING_RE)
  if (!acHeadingMatch) {
    errors.push('Acceptance Criteria heading missing')
  } else {
    const lines = trimmed.split(/\r?\n/)
    const headingIdx = lines.findIndex((l) => AC_HEADING_RE.test(l))
    const acItems = []
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^#{1,6}\s/.test(line)) break // next heading ends the section
      const bullet = line.match(/^\s*(?:-|\*)\s+(?:\[[ xX]\]\s+)?(.*)$/)
      if (!bullet) continue
      const body = bullet[1].trim()
      if (body.length === 0) continue
      if (PLACEHOLDER_RE.test(body)) continue
      acItems.push(body)
    }
    if (acItems.length < MIN_AC_ITEMS) {
      errors.push(
        `Fewer than ${MIN_AC_ITEMS} acceptance-criteria items found (got ${acItems.length})`
      )
    }
  }

  return errors
}

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

// --- Main ---

async function main() {
  const { since, json } = parseArgs(process.argv.slice(2))
  const issues = await fetchRecentIssues(since)

  const violations = []
  for (const issue of issues) {
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

  const result = { since: since.toISOString(), total: issues.length, violations }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`Scanned ${result.total} issue(s) created since ${result.since}`)
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
