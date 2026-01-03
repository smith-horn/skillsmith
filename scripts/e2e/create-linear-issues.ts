#!/usr/bin/env npx tsx
/**
 * Create Linear Issues for E2E Test Failures
 *
 * Reads test results and creates Linear issues for failures
 * with detailed problem definitions and evidence.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ROOT_DIR = join(__dirname, '..', '..')
const RESULTS_DIR = join(ROOT_DIR, 'test-results')

interface HardcodedIssue {
  type: string
  pattern: string
  value: string
  command: string
  source: string
  severity: string
}

interface TestFailure {
  testName: string
  testFile: string
  command: string
  error: string
  hardcodedIssues?: HardcodedIssue[]
  timestamp: string
}

interface LinearIssueInput {
  title: string
  description: string
  priority: number
  labels: string[]
}

/**
 * Create a Linear issue via GraphQL API
 */
async function createLinearIssue(input: LinearIssueInput): Promise<string | null> {
  const apiKey = process.env.LINEAR_API_KEY

  if (!apiKey) {
    console.warn('LINEAR_API_KEY not set, skipping issue creation')
    return null
  }

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
      title: input.title,
      description: input.description,
      priority: input.priority,
      // Note: Label IDs would need to be fetched or configured
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
      console.error(`Linear API error: ${response.status}`)
      return null
    }

    const result = await response.json()

    if (result.data?.issueCreate?.success) {
      const issue = result.data.issueCreate.issue
      console.log(`Created issue: ${issue.identifier} - ${issue.url}`)
      return issue.identifier
    }

    console.error('Failed to create issue:', result.errors)
    return null
  } catch (error) {
    console.error('Error creating Linear issue:', error)
    return null
  }
}

/**
 * Format a test failure into a Linear issue
 */
function formatFailureAsIssue(failure: TestFailure): LinearIssueInput {
  const hasHardcoded = failure.hardcodedIssues && failure.hardcodedIssues.length > 0

  let title: string
  let priority: number

  if (hasHardcoded) {
    const types = [...new Set(failure.hardcodedIssues!.map((i) => i.type))]
    title = `[E2E] Hardcoded ${types.join(', ')} detected in ${failure.command}`
    priority = 1 // High priority for hardcoded issues
  } else {
    title = `[E2E] Test failure: ${failure.testName}`
    priority = 2
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

  description += `\n## Test Environment\n\n`
  description += `- **Type**: GitHub Codespaces / GitHub Actions\n`
  description += `- **Node Version**: 20.x\n`

  return {
    title,
    description,
    priority,
    labels: hasHardcoded ? ['bug', 'e2e', 'hardcoded'] : ['bug', 'e2e'],
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

  // Create issues with rate limiting
  const createdIssues: string[] = []

  for (const failure of allFailures) {
    const issueInput = formatFailureAsIssue(failure)
    console.log(`Creating issue: ${issueInput.title}`)

    const issueId = await createLinearIssue(issueInput)
    if (issueId) {
      createdIssues.push(issueId)
    }

    // Rate limit: wait 500ms between requests
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  console.log(`\n✅ Created ${createdIssues.length} Linear issue(s)`)

  if (createdIssues.length > 0) {
    console.log('Issues created:', createdIssues.join(', '))
  }
}

main().catch((error) => {
  console.error('Failed to create Linear issues:', error)
  process.exit(1)
})
