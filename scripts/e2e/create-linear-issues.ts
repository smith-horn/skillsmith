#!/usr/bin/env npx tsx
/**
 * Create Linear Issues for E2E Test Failures (SMI-5855)
 *
 * Reads test results and creates Linear issues for failures
 * with detailed problem definitions and evidence.
 *
 * Historically this mutation always failed input coercion: `IssueCreateInput`
 * requires `teamId` (NON_NULL) and it was never included, so this script has
 * never created a single issue (the workflow step is `continue-on-error:
 * true`, so the failure was fully silent). SMI-5855 fixes the mutation and
 * adds the guards a newly-live, previously-dead-code write path needs before
 * it starts firing for real:
 *
 *   - `teamId` is now resolved and sent (the fix for the dead mutation).
 *   - Labels are resolved to real UUIDs and attached: `Bug` (workspace-level,
 *     resolve-only — never created, so a get-or-create never mints a
 *     team-scoped near-duplicate of the existing label) and
 *     `e2e-failure-auto` (the `BOT_LABELS` anchor in
 *     `scripts/lint-linear-issues.mjs` — provisioned deliberately, with
 *     get-or-create kept as a self-healing backstop).
 *   - `createLinearIssue()` returns a discriminated outcome instead of
 *     `string | null`, so a mutation failure is counted, not swallowed.
 *   - A per-run creation cap (`MAX_ISSUES_PER_RUN`), dedup against already-open
 *     Linear issues by stable title, and within-run dedup (the same failure
 *     can appear in both `cli-results.json` and `mcp-results.json`) bound how
 *     many issues one red suite can file.
 *   - `main()` prints an attempted/created/skipped/suppressed/failed summary
 *     and exits nonzero if anything intended to be created failed, so the
 *     original "dead mutation, exit 0" failure class cannot survive in a new
 *     form. The workflow step stays `continue-on-error: true` (unchanged).
 *
 * This script is deliberately self-contained (Q4, plan doc
 * docs/internal/implementation/smi-5854-5855-linear-issue-label-parent-resolution.md)
 * rather than delegating to `scripts/linear-api.mjs`'s `createIssue()` — its
 * own small Linear client (`create-linear-issues.linear-client.ts`) mirrors
 * `scripts/linear-upsert-drift-issue.mjs`'s resolution/retry pattern rather
 * than importing it. Types live in `create-linear-issues.types.ts` and the
 * Linear GraphQL client lives in `create-linear-issues.linear-client.ts` —
 * both split out to keep this file under the repo's 500-line gate.
 * (SMI-5858: that client's own transport/retry primitives now come from
 * the shared `scripts/lib/linear-client.mjs`; this file's imports are
 * unchanged.)
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import {
  createLinearIssue,
  fetchOpenE2eIssueTitles,
  getOrCreateAutoLabelId,
  getTeamId,
  resolveLabelId,
  BUG_LABEL_NAME,
  AUTO_LABEL_NAME,
} from './create-linear-issues.linear-client.js'
import type {
  IssueFilingSummary,
  LinearIssueInput,
  TestFailure,
} from './create-linear-issues.types.js'

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ROOT_DIR = join(__dirname, '..', '..')
const RESULTS_DIR = join(ROOT_DIR, 'test-results')

// A systemic breakage can fail many assertions at once; without a cap, one
// red run files one issue per failed assertion, and every re-run does it
// again. See Rollout/Risk "Gap B" in the plan doc referenced above.
const MAX_ISSUES_PER_RUN = 10

/**
 * Format a test failure into a Linear issue.
 *
 * Label set is the constant `['Bug', 'e2e-failure-auto']` regardless of
 * `hasHardcoded` (Q3(b′) — the plan's original `hardcoded` label is dropped;
 * the distinction it encoded is already carried by the title and the
 * "Hardcoded Values Detected" section below). Priority is `2` (High) for a
 * hardcoded-value detection and `3` (Medium) otherwise — `linear-api.mjs`'s
 * own scale is 1=urgent, 2=high, 3=medium, 4=low, so the previous `1`/`2`
 * mapping filed ordinary detections as Urgent.
 */
function formatFailureAsIssue(failure: TestFailure): LinearIssueInput {
  const hasHardcoded = failure.hardcodedIssues && failure.hardcodedIssues.length > 0

  let title: string
  let priority: number

  if (hasHardcoded) {
    const types = [...new Set(failure.hardcodedIssues!.map((i) => i.type))]
    title = `[E2E] Hardcoded ${types.join(', ')} detected in ${failure.command}`
    priority = 2 // High
  } else {
    title = `[E2E] Test failure: ${failure.testName}`
    priority = 3 // Medium
  }

  let description = `## Problem Definition\n\n`
  description += `E2E test **${failure.testName}** failed during automated testing.\n\n`
  description += `- **Test File**: \`${failure.testFile}\`\n`
  description += `- **Command**: \`${failure.command}\`\n`
  description += `- **Timestamp**: ${failure.timestamp}\n\n`

  description += `## Error Details\n\n\`\`\`\n${failure.error}\n\`\`\`\n\n`

  if (hasHardcoded) {
    description += `## Hardcoded Values Detected\n\n`
    description += `| Type | Pattern | Value | Source |\n`
    description += `|------|---------|-------|--------|\n`

    for (const issue of failure.hardcodedIssues!) {
      description += `| ${issue.type} | ${issue.pattern} | \`${issue.value}\` | ${issue.source} |\n`
    }

    description += `\n`
  }

  description += `## Recommended Actions\n\n`
  if (hasHardcoded) {
    description += `1. Review hardcoded values detected above\n`
    description += `2. Replace with environment variables or user-configurable options\n`
    description += `3. Use platform-agnostic path resolution\n`
    description += `4. Re-run E2E tests in Codespace to verify fix\n`
  } else {
    description += `1. Review error message and stack trace\n`
    description += `2. Check test assumptions about environment\n`
    description += `3. Verify command works in clean Codespace\n`
    description += `4. Re-run E2E tests to verify fix\n`
  }

  description += `\n## Acceptance Criteria\n\n`
  description += `- [ ] The test passes on re-run\n`
  description += `- [ ] Or the root cause is documented in a comment on this issue\n`

  description += `\n## Test Environment\n\n`
  description += `- **Type**: GitHub Codespaces / GitHub Actions\n`
  description += `- **Node Version**: 20.x\n`

  return {
    title,
    description,
    priority,
    labels: [BUG_LABEL_NAME, AUTO_LABEL_NAME],
  }
}

/**
 * Extract failures from test results
 */
function extractFailures(resultsPath: string): TestFailure[] {
  if (!existsSync(resultsPath)) {
    return []
  }

  try {
    const content = readFileSync(resultsPath, 'utf-8')
    const results = JSON.parse(content)

    // This depends on the test result format from vitest
    // Adjust based on actual structure
    const failures: TestFailure[] = []

    if (results.testResults) {
      for (const suite of results.testResults) {
        for (const test of suite.assertionResults || []) {
          if (test.status === 'failed') {
            failures.push({
              testName: test.fullName || test.title,
              testFile: suite.name,
              command: 'skillsmith e2e test',
              error: test.failureMessages?.join('\n') || 'Unknown error',
              timestamp: new Date().toISOString(),
            })
          }
        }
      }
    }

    return failures
  } catch (error) {
    console.error(`Error parsing results from ${resultsPath}:`, error)
    return []
  }
}

/**
 * Resolve team/labels once, then create an issue per failure, applying
 * within-run dedup, already-open-issue dedup, and the per-run cap. A
 * one-time resolution failure (after retries) aborts the whole run — every
 * failure is counted as `failed` rather than silently attempting a mutation
 * that would fail input coercion anyway.
 */
async function fileIssuesForFailures(failures: TestFailure[]): Promise<IssueFilingSummary> {
  const summary: IssueFilingSummary = {
    attempted: 0,
    created: 0,
    skippedDuplicate: 0,
    suppressedByCap: 0,
    failed: 0,
    createdIdentifiers: [],
  }

  let teamId: string
  let labelIds: string[]
  let openTitles: Set<string>

  try {
    teamId = await getTeamId()
    const [bugLabelId, autoLabelId, titles] = await Promise.all([
      resolveLabelId(teamId, BUG_LABEL_NAME),
      getOrCreateAutoLabelId(teamId),
      fetchOpenE2eIssueTitles(teamId),
    ])
    labelIds = [bugLabelId, autoLabelId].filter((id): id is string => id !== null)
    openTitles = titles
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`Failed to resolve team/labels for e2e issue filing: ${reason}`)
    summary.failed = failures.length
    return summary
  }

  const seenTitles = new Set<string>()

  for (const failure of failures) {
    const issueInput = formatFailureAsIssue(failure)

    if (seenTitles.has(issueInput.title)) {
      summary.skippedDuplicate += 1
      continue
    }
    seenTitles.add(issueInput.title)

    if (openTitles.has(issueInput.title)) {
      summary.skippedDuplicate += 1
      continue
    }

    if (summary.attempted >= MAX_ISSUES_PER_RUN) {
      summary.suppressedByCap += 1
      continue
    }

    summary.attempted += 1
    console.log(`Creating issue: ${issueInput.title}`)
    const outcome = await createLinearIssue(issueInput, teamId, labelIds)

    if (outcome.status === 'created') {
      summary.created += 1
      summary.createdIdentifiers.push(outcome.identifier)
    } else {
      summary.failed += 1
      console.error(`Failed to create issue "${issueInput.title}": ${outcome.reason}`)
    }

    // Rate limit: wait 500ms between requests
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return summary
}

async function main(): Promise<void> {
  console.log('📋 Creating Linear issues for E2E failures...\n')

  // Check for LINEAR_API_KEY
  if (!process.env.LINEAR_API_KEY) {
    console.log('LINEAR_API_KEY not set. Skipping issue creation.')
    console.log('Set LINEAR_API_KEY environment variable to enable automatic issue creation.')
    process.exit(0)
  }

  // Extract failures from both CLI and MCP results
  const cliFailures = extractFailures(join(RESULTS_DIR, 'cli-results.json'))
  const mcpFailures = extractFailures(join(RESULTS_DIR, 'mcp-results.json'))

  const allFailures = [...cliFailures, ...mcpFailures]

  if (allFailures.length === 0) {
    console.log('No test failures found. No issues to create.')
    process.exit(0)
  }

  console.log(`Found ${allFailures.length} test failure(s)\n`)

  const summary = await fileIssuesForFailures(allFailures)

  console.log(
    `\nE2E issue filing: ${allFailures.length} failure(s) → ${summary.created} created, ` +
      `${summary.skippedDuplicate} skipped (duplicate), ${summary.suppressedByCap} suppressed ` +
      `(cap ${MAX_ISSUES_PER_RUN}), ${summary.failed} failed`
  )

  if (summary.createdIdentifiers.length > 0) {
    console.log('Issues created:', summary.createdIdentifiers.join(', '))
  }

  if (summary.failed > 0) {
    process.exit(1)
  }
}

// Only run main() when executed directly, not when imported (mirrors
// scripts/linear-api.mjs's process.argv[1] === fileURLToPath(import.meta.url)
// guard) — importing this module from a test must not execute main().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Failed to create Linear issues:', error)
    process.exit(1)
  })
}

export { formatFailureAsIssue, extractFailures, fileIssuesForFailures, main, MAX_ISSUES_PER_RUN }
export {
  createLinearIssue,
  getTeamId,
  resolveLabelId,
  getOrCreateAutoLabelId,
  fetchOpenE2eIssueTitles,
}
export type {
  TestFailure,
  LinearIssueInput,
  CreateIssueOutcome,
  IssueFilingSummary,
} from './create-linear-issues.types.js'
