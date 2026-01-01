/**
 * Linear Issue Reporter for E2E Test Failures
 *
 * Automatically creates Linear issues when E2E tests detect problems.
 * Issues include detailed evidence for specialist agents to resolve.
 *
 * @see docs/testing/e2e-testing-plan.md
 */

import type { HardcodedIssue } from './hardcoded-detector.js'

export interface LinearIssuePayload {
  title: string
  description: string
  teamId?: string
  projectId?: string
  labelIds?: string[]
  priority?: number
  estimate?: number
}

export interface LinearIssueResult {
  success: boolean
  issueId?: string
  issueUrl?: string
  error?: string
}

export interface TestFailure {
  testName: string
  testFile: string
  command: string
  error: string
  stdout?: string
  stderr?: string
  hardcodedIssues?: HardcodedIssue[]
  duration?: number
  timestamp: string
}

/**
 * Format hardcoded issue for Linear description
 */
function formatHardcodedEvidence(issues: HardcodedIssue[]): string {
  if (issues.length === 0) return ''

  const lines = [
    '## Hardcoded Values Detected',
    '',
    '| Type | Pattern | Value | Source |',
    '|------|---------|-------|--------|',
  ]

  for (const issue of issues) {
    lines.push(
      `| ${issue.type} | ${issue.pattern} | \`${issue.value}\` | ${issue.location.source} |`
    )
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Create Linear issue description from test failure
 */
export function createIssueDescription(failure: TestFailure): string {
  const sections: string[] = []

  // Problem definition
  sections.push('## Problem Definition')
  sections.push('')
  sections.push(`E2E test **${failure.testName}** failed during automated testing.`)
  sections.push('')
  sections.push(`**Test File**: \`${failure.testFile}\``)
  sections.push(`**Command**: \`${failure.command}\``)
  sections.push(`**Timestamp**: ${failure.timestamp}`)
  if (failure.duration) {
    sections.push(`**Duration**: ${failure.duration}ms`)
  }
  sections.push('')

  // Error details
  sections.push('## Error Details')
  sections.push('')
  sections.push('```')
  sections.push(failure.error)
  sections.push('```')
  sections.push('')

  // Hardcoded issues if present
  if (failure.hardcodedIssues && failure.hardcodedIssues.length > 0) {
    sections.push(formatHardcodedEvidence(failure.hardcodedIssues))
  }

  // Output evidence (truncated)
  if (failure.stdout || failure.stderr) {
    sections.push('## Command Output')
    sections.push('')

    if (failure.stdout) {
      const truncatedStdout =
        failure.stdout.length > 1000
          ? failure.stdout.substring(0, 1000) + '\n... (truncated)'
          : failure.stdout
      sections.push('<details>')
      sections.push('<summary>stdout</summary>')
      sections.push('')
      sections.push('```')
      sections.push(truncatedStdout)
      sections.push('```')
      sections.push('</details>')
      sections.push('')
    }

    if (failure.stderr) {
      const truncatedStderr =
        failure.stderr.length > 1000
          ? failure.stderr.substring(0, 1000) + '\n... (truncated)'
          : failure.stderr
      sections.push('<details>')
      sections.push('<summary>stderr</summary>')
      sections.push('')
      sections.push('```')
      sections.push(truncatedStderr)
      sections.push('```')
      sections.push('</details>')
      sections.push('')
    }
  }

  // Recommended actions
  sections.push('## Recommended Actions')
  sections.push('')
  if (failure.hardcodedIssues && failure.hardcodedIssues.length > 0) {
    sections.push('1. Review hardcoded values detected above')
    sections.push('2. Replace with environment variables or user-configurable options')
    sections.push('3. Use platform-agnostic path resolution (os.homedir(), path.join())')
    sections.push('4. Re-run E2E tests in Codespace to verify fix')
  } else {
    sections.push('1. Review error message and stack trace')
    sections.push('2. Check test assumptions about environment')
    sections.push('3. Verify command works in clean Codespace environment')
    sections.push('4. Re-run E2E tests to verify fix')
  }
  sections.push('')

  // Environment info
  sections.push('## Test Environment')
  sections.push('')
  sections.push('- **Type**: GitHub Codespaces')
  sections.push('- **Node Version**: 20.x')
  sections.push('- **Test Repository**: 021-school-platform')
  sections.push('')

  return sections.join('\n')
}

/**
 * Create Linear issue title from test failure
 */
export function createIssueTitle(failure: TestFailure): string {
  if (failure.hardcodedIssues && failure.hardcodedIssues.length > 0) {
    const types = [...new Set(failure.hardcodedIssues.map((i) => i.type))]
    return `[E2E] Hardcoded ${types.join(', ')} in ${failure.command}`
  }
  return `[E2E] ${failure.testName} failed`
}

/**
 * Create Linear issue via API
 */
export async function createLinearIssue(failure: TestFailure): Promise<LinearIssueResult> {
  const apiKey = process.env['LINEAR_API_KEY']
  const teamId = process.env['LINEAR_TEAM_ID']

  if (!apiKey) {
    console.warn('LINEAR_API_KEY not set, skipping issue creation')
    return {
      success: false,
      error: 'LINEAR_API_KEY environment variable not set',
    }
  }

  if (!teamId) {
    console.warn('LINEAR_TEAM_ID not set, skipping issue creation')
    return {
      success: false,
      error: 'LINEAR_TEAM_ID environment variable not set (required for issue creation)',
    }
  }

  const title = createIssueTitle(failure)
  const description = createIssueDescription(failure)

  // GraphQL mutation for creating issue
  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          url
        }
      }
    }
  `

  const variables = {
    input: {
      title,
      description,
      teamId,
      // Labels: bug, e2e, hardcoded (if applicable)
      labelIds: failure.hardcodedIssues?.length ? ['bug', 'e2e', 'hardcoded'] : ['bug', 'e2e'],
      priority: failure.hardcodedIssues?.some((i) => i.severity === 'error') ? 1 : 2,
    },
  }

  try {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({ query: mutation, variables }),
    })

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`)
    }

    const result = (await response.json()) as {
      data?: {
        issueCreate?: { success: boolean; issue: { id: string; identifier: string; url: string } }
      }
      errors?: unknown[]
    }

    if (result.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`)
    }

    const issueData = result.data?.issueCreate
    if (issueData?.success) {
      return {
        success: true,
        issueId: issueData.issue.identifier,
        issueUrl: issueData.issue.url,
      }
    }

    return {
      success: false,
      error: 'Issue creation returned unsuccessful',
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Queue issue for batch creation (used when rate-limited)
 */
const issueQueue: TestFailure[] = []

export function queueIssue(failure: TestFailure): void {
  issueQueue.push(failure)
}

export function getQueuedIssues(): TestFailure[] {
  return [...issueQueue]
}

export async function flushIssueQueue(): Promise<LinearIssueResult[]> {
  const results: LinearIssueResult[] = []

  for (const failure of issueQueue) {
    const result = await createLinearIssue(failure)
    results.push(result)

    // Rate limit: wait 500ms between requests
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Clear queue
  issueQueue.length = 0

  return results
}

export default {
  createIssueDescription,
  createIssueTitle,
  createLinearIssue,
  queueIssue,
  getQueuedIssues,
  flushIssueQueue,
}
