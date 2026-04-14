#!/usr/bin/env node
/**
 * SMI-4205: Upsert the "Version Drift Detected" Linear issue.
 *
 * Usage:
 *   node scripts/linear-upsert-drift-issue.mjs <path-to-drift.json>
 *
 * Environment:
 *   LINEAR_API_KEY - required
 *   GH_REPO        - optional; defaults to "smith-horn/skillsmith" for tier-2 fallback
 *
 * Behavior:
 *   1. Load drift JSON report produced by check-version-drift.mjs.
 *   2. Query Linear for open issue labeled "version-drift-auto" in state type "started".
 *   3. Build a markdown description table from drifted + errors arrays.
 *   4. If an issue exists: issueUpdate(id, description). If not: issueCreate with
 *      parent SMI-4182 and label version-drift-auto.
 *   5. Both the find-query and the upsert mutation are wrapped in a 3-attempt
 *      exponential backoff (1000ms, 2000ms, 4000ms). On total failure, fall back
 *      to `gh issue create` with label linear-fallback and exit 1.
 *
 * Idempotency key: label "version-drift-auto" + state type "started".
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const TEAM_KEY = 'SMI'
const PARENT_IDENTIFIER = 'SMI-4182'
const AUTO_LABEL_NAME = 'version-drift-auto'
const FALLBACK_GH_LABEL = 'linear-fallback'
const RETRY_DELAYS_MS = [1000, 2000, 4000]
const API_URL = 'https://api.linear.app/graphql'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run an async function with exponential backoff retries.
 * Retries on any thrown error; returns the resolved value on first success.
 * After all delays exhausted, re-throws the last error.
 */
export async function withRetry(fn, delays = RETRY_DELAYS_MS) {
  let lastErr
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (attempt < delays.length) {
        await sleep(delays[attempt])
      }
    }
  }
  throw lastErr
}

async function graphql(query, variables = {}) {
  const apiKey = process.env.LINEAR_API_KEY
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY environment variable is not set')
  }
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Linear API error: ${response.status} ${text}`)
  }
  const json = await response.json()
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
  }
  return json.data
}

async function getTeamId(teamKey = TEAM_KEY) {
  const data = await graphql(
    `
      query ($key: String!) {
        teams(filter: { key: { eq: $key } }) {
          nodes {
            id
          }
        }
      }
    `,
    { key: teamKey }
  )
  const team = data.teams.nodes[0]
  if (!team) throw new Error(`Team ${teamKey} not found`)
  return team.id
}

async function getOrCreateAutoLabelId(teamId) {
  const found = await graphql(
    `
      query ($teamId: ID!, $name: String!) {
        issueLabels(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
          nodes {
            id
            name
          }
        }
      }
    `,
    { teamId, name: AUTO_LABEL_NAME }
  )
  if (found.issueLabels.nodes.length > 0) {
    return found.issueLabels.nodes[0].id
  }
  const created = await graphql(
    `
      mutation ($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel {
            id
          }
        }
      }
    `,
    { input: { teamId, name: AUTO_LABEL_NAME, color: '#d7b11f' } }
  )
  if (!created.issueLabelCreate.success) {
    throw new Error(`Failed to create label ${AUTO_LABEL_NAME}`)
  }
  return created.issueLabelCreate.issueLabel.id
}

async function getIssueIdByIdentifier(identifier) {
  const data = await graphql(
    `
      query ($id: String!) {
        issue(id: $id) {
          id
          identifier
        }
      }
    `,
    { id: identifier }
  )
  if (!data.issue) throw new Error(`Issue ${identifier} not found`)
  return data.issue.id
}

async function findExistingOpenAutoIssue(teamId, labelId) {
  const data = await graphql(
    `
      query ($teamId: ID!, $labelId: ID!) {
        issues(
          filter: {
            team: { id: { eq: $teamId } }
            labels: { id: { eq: $labelId } }
            state: { type: { in: ["backlog", "unstarted", "started"] } }
          }
          first: 10
        ) {
          nodes {
            id
            identifier
            title
          }
        }
      }
    `,
    { teamId, labelId }
  )
  return data.issues.nodes[0] || null
}

async function createIssue(input) {
  const data = await graphql(
    `
      mutation ($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
    `,
    { input }
  )
  if (!data.issueCreate.success) throw new Error('issueCreate returned success=false')
  return data.issueCreate.issue
}

async function updateIssue(id, description) {
  const data = await graphql(
    `
      mutation ($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
    `,
    { id, input: { description } }
  )
  if (!data.issueUpdate.success) throw new Error('issueUpdate returned success=false')
  return data.issueUpdate.issue
}

/**
 * Build the markdown description body from the drift report.
 */
export function buildDescription(report, dateIso = new Date().toISOString().slice(0, 10)) {
  const lines = []
  lines.push(`## Version Drift Detected - ${dateIso}`)
  lines.push('')
  if (report.drifted.length > 0) {
    lines.push('### Drifted packages')
    lines.push('')
    lines.push('| Package | Local | npm latest |')
    lines.push('|---------|-------|------------|')
    for (const d of report.drifted) {
      lines.push(`| ${d.pkg} | ${d.local} | ${d.npmLatest} |`)
    }
    lines.push('')
  }
  if (report.errors.length > 0) {
    lines.push('### npm lookup errors')
    lines.push('')
    lines.push('| Package | Error |')
    lines.push('|---------|-------|')
    for (const e of report.errors) {
      const oneLine = String(e.error || '')
        .replace(/\s+/g, ' ')
        .slice(0, 200)
      lines.push(`| ${e.pkg} | ${oneLine} |`)
    }
    lines.push('')
  }
  lines.push('---')
  lines.push(
    'Generated by [version-drift-check.yml](https://github.com/smith-horn/skillsmith/actions/workflows/version-drift-check.yml).'
  )
  return lines.join('\n')
}

function ghFallback(report, lastError) {
  const repo = process.env.GH_REPO || 'smith-horn/skillsmith'
  const date = new Date().toISOString().slice(0, 10)
  const title = `Linear drift upsert failed ${date}`
  const body = [
    `Linear upsert failed after ${RETRY_DELAYS_MS.length} retries.`,
    '',
    `Last error: ${String(lastError && lastError.message ? lastError.message : lastError)}`,
    '',
    'Drift report:',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    'Created automatically by scripts/linear-upsert-drift-issue.mjs (SMI-4205).',
  ].join('\n')
  console.error(
    `::error::Linear upsert failed after ${RETRY_DELAYS_MS.length} retries: ${String(lastError)}`
  )
  try {
    execFileSync(
      'gh',
      [
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        title,
        '--label',
        FALLBACK_GH_LABEL,
        '--body',
        body,
      ],
      { stdio: 'inherit' }
    )
  } catch (e) {
    console.error(
      `::error::gh issue fallback also failed: ${String(e && e.message ? e.message : e)}`
    )
  }
}

export async function upsertDriftIssue(report) {
  const teamId = await withRetry(() => getTeamId())
  const [labelId, parentId] = await Promise.all([
    withRetry(() => getOrCreateAutoLabelId(teamId)),
    withRetry(() => getIssueIdByIdentifier(PARENT_IDENTIFIER)),
  ])
  const existing = await withRetry(() => findExistingOpenAutoIssue(teamId, labelId))
  const description = buildDescription(report)
  if (existing) {
    return await withRetry(() => updateIssue(existing.id, description))
  }
  const title = `Version drift detected ${new Date().toISOString().slice(0, 10)}`
  return await withRetry(() =>
    createIssue({ teamId, title, description, labelIds: [labelId], parentId })
  )
}

async function main() {
  const reportPath = process.argv[2]
  if (!reportPath) {
    console.error('Usage: node scripts/linear-upsert-drift-issue.mjs <path-to-drift.json>')
    process.exit(2)
  }
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (e) {
    console.error(
      `Failed to read drift report at ${reportPath}: ${String(e && e.message ? e.message : e)}`
    )
    process.exit(2)
  }
  const hasDrift = (report.drifted || []).length > 0 || (report.errors || []).length > 0
  if (!hasDrift) {
    console.log('No drift or errors — nothing to upsert.')
    return
  }
  try {
    const issue = await upsertDriftIssue(report)
    console.log(`Upserted Linear issue ${issue.identifier}: ${issue.url}`)
  } catch (e) {
    ghFallback(report, e)
    process.exit(1)
  }
}

import { fileURLToPath } from 'node:url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
