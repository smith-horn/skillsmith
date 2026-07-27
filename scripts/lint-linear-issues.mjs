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
import { graphql, withRetry, RETRY_DELAYS_MS } from './lib/linear-client.mjs'

const TEAM_KEY = 'SMI'

// Labels identifying issues created by this repo's own automation, not
// human work items — these never carry an Acceptance Criteria section
// by design and must not register as lint violations. Extend this list
// as new bot-generation labels are added (SMI-5853). Note:
// scripts/e2e/create-linear-issues.ts-created issues DO carry a real
// "## Acceptance Criteria" section as of SMI-5855 (belt-and-braces with
// this exclusion), and now attach 'e2e-failure-auto' for real — the
// mutation previously omitted labelIds entirely (and the required
// teamId), so no e2e issue had ever been created. 'Bug' is deliberately
// NOT added here — it is resolve-only in that script (never
// get-or-created) and is a broad, human-reusable label; excluding it
// would exempt real work items from this lint.
export const BOT_LABELS = ['version-drift-auto', 'e2e-failure-auto']

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

// --- Linear API (SMI-5858: shared transport/retry, scripts/lib/linear-client.mjs) ---

// Exported (not just called from main()) so scripts/tests/lint-linear-issues.test.ts
// can drive the pagination/retry/exit-on-GraphQL-error behavior directly.
export async function fetchRecentIssues(since) {
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
    let data
    try {
      // Retries transport failures and any HTTP status (429/5xx/4xx —
      // matching this script's real pre-extraction behavior) but NEVER a
      // deterministic GraphQL body error: shared graphql() converts that
      // into a throw with `graphqlError = true`, and retrying it 4 times
      // (~7s of pointless backoff) before reaching the same exit code
      // would be a real regression, not just wasted time.
      data = await withRetry(
        () => graphql(query, { after: cursor, since: since.toISOString() }),
        RETRY_DELAYS_MS,
        (err) => !err?.graphqlError
      )
    } catch (err) {
      if (err?.graphqlError) {
        console.error('lint-linear-issues: Linear query failed:', JSON.stringify(err.graphqlErrors))
        process.exit(2)
      }
      // Non-GraphQL errors that exhaust retries rethrow normally (as
      // today) — main()'s own top-level catch converts them to exit 2.
      throw err
    }

    const { nodes, pageInfo } = data.issues
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
