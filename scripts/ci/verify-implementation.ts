#!/usr/bin/env npx tsx
/**
 * CI Implementation Completeness Check (SMI-3541)
 *
 * Verifies that PRs referencing Linear issues (SMI-xxx) actually contain
 * source code changes, preventing plan-to-code drift.
 *
 * Usage:
 *   npx tsx scripts/ci/verify-implementation.ts --pr-number 123
 *
 * Environment:
 *   GH_TOKEN - GitHub token for API access (provided by actions/checkout)
 *
 * Verdicts:
 *   pass - No SMI refs, or SMI refs with source changes
 *   warn - SMI refs with only test file changes
 *   fail - SMI refs with only docs/config changes
 *   skip - [skip-impl-check] in PR body
 */

import { execFileSync } from 'child_process'
import { appendFileSync, existsSync } from 'fs'

import { SOURCE_PATTERNS, TEST_PATTERNS, DOCS_PATTERNS } from './source-patterns.mjs'

// --- Types ---

export type Verdict = 'pass' | 'warn' | 'fail' | 'skip'

export interface FileCategory {
  source: string[]
  test: string[]
  docs: string[]
  config: string[]
}

export interface VerificationResult {
  issues: string[]
  verdict: Verdict
  files: FileCategory
  reason: string
}

// --- Constants ---

const ISSUE_PATTERN = /\b(SMI-\d+)\b/gi
const SKIP_MARKER = '[skip-impl-check]'

const EXCLUDED_FROM_SOURCE = [...TEST_PATTERNS, ...DOCS_PATTERNS]

// --- Helpers ---

function extractIssues(text: string): string[] {
  const matches = text.match(ISSUE_PATTERN) || []
  return [...new Set(matches.map((m) => m.toUpperCase()))]
}

export function categorizeFile(file: string): keyof FileCategory {
  if (TEST_PATTERNS.some((p) => p.test(file))) return 'test'
  if (DOCS_PATTERNS.some((p) => p.test(file))) return 'docs'
  const isSource = SOURCE_PATTERNS.some((p) => p.test(file))
  const isExcluded = EXCLUDED_FROM_SOURCE.some((p) => p.test(file))
  if (isSource && !isExcluded) return 'source'
  return 'config'
}

export function categorizeFiles(files: string[]): FileCategory {
  const result: FileCategory = { source: [], test: [], docs: [], config: [] }
  for (const file of files) {
    result[categorizeFile(file)].push(file)
  }
  return result
}

export function determineVerdict(issues: string[], files: FileCategory): VerificationResult {
  if (issues.length === 0) {
    return {
      issues,
      verdict: 'pass',
      files,
      reason: 'No SMI issue references found — nothing to verify.',
    }
  }

  if (files.source.length > 0) {
    return {
      issues,
      verdict: 'pass',
      files,
      reason: `PR references ${issues.join(', ')} and includes ${files.source.length} source file(s).`,
    }
  }

  if (files.test.length > 0 && files.docs.length === 0 && files.config.length === 0) {
    return {
      issues,
      verdict: 'warn',
      files,
      reason: `PR references ${issues.join(', ')} but only contains test files. Tests without implementation may not complete the issue.`,
    }
  }

  return {
    issues,
    verdict: 'fail',
    files,
    reason: [
      `PR references ${issues.join(', ')} but contains no source code changes.`,
      'Either: (1) add implementation code, (2) remove the SMI reference if this is',
      'intentionally docs-only, or (3) add `[skip-impl-check]` to the PR body.',
    ].join(' '),
  }
}

// --- GitHub API ---

interface PrData {
  title: string
  body: string
  commits: string[]
  files: string[]
}

function fetchPrData(prNumber: number): PrData {
  // Fetch PR title and body
  const prJson = execFileSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'title,body,commits,files'],
    { encoding: 'utf-8', timeout: 15000 }
  )

  const pr = JSON.parse(prJson)

  const commits = (pr.commits || []).map(
    (c: { messageHeadline?: string; messageBody?: string }) =>
      `${c.messageHeadline || ''} ${c.messageBody || ''}`
  )

  const files = (pr.files || []).map((f: { path: string }) => f.path)

  return {
    title: pr.title || '',
    body: pr.body || '',
    commits,
    files,
  }
}

// --- Output ---

function writeSummary(result: VerificationResult, prNumber: number): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return

  const icon =
    result.verdict === 'pass'
      ? 'check'
      : result.verdict === 'warn'
        ? 'warning'
        : result.verdict === 'skip'
          ? 'information_source'
          : 'x'

  const lines = [
    `## :${icon}: Implementation Verification — ${result.verdict.toUpperCase()}`,
    '',
    `**PR #${prNumber}**`,
    '',
    result.reason,
    '',
  ]

  if (result.issues.length > 0) {
    lines.push('### Referenced Issues', '')
    lines.push('| Issue | Status |')
    lines.push('|-------|--------|')
    for (const issue of result.issues) {
      const status = result.verdict === 'pass' ? 'Verified' : 'Needs implementation'
      lines.push(`| ${issue} | ${status} |`)
    }
    lines.push('')
  }

  if (result.files.source.length + result.files.test.length > 0) {
    lines.push('### File Categories', '')
    lines.push('| Category | Count | Files |')
    lines.push('|----------|-------|-------|')
    for (const [cat, files] of Object.entries(result.files)) {
      if (files.length > 0) {
        const truncated =
          files.length > 5 ? `${files.slice(0, 5).join(', ')} ...` : files.join(', ')
        lines.push(`| ${cat} | ${files.length} | ${truncated} |`)
      }
    }
  }

  appendFileSync(summaryPath, lines.join('\n') + '\n')
}

// --- Main ---

function parseArgs(): { prNumber: number } {
  const args = process.argv.slice(2)
  const prIdx = args.indexOf('--pr-number')
  if (prIdx === -1 || !args[prIdx + 1]) {
    console.error('Usage: verify-implementation.ts --pr-number <number>')
    process.exit(1)
  }
  const prNumber = parseInt(args[prIdx + 1], 10)
  if (isNaN(prNumber) || prNumber <= 0) {
    console.error('Invalid PR number:', args[prIdx + 1])
    process.exit(1)
  }
  return { prNumber }
}

export function run(prData: PrData): VerificationResult {
  // Check escape hatch
  if (prData.body.includes(SKIP_MARKER)) {
    return {
      issues: extractIssues(`${prData.title} ${prData.body} ${prData.commits.join(' ')}`),
      verdict: 'skip',
      files: categorizeFiles(prData.files),
      reason: `[skip-impl-check] found in PR body — skipping implementation verification.`,
    }
  }

  // Extract all SMI references from PR title, body, and commit messages
  const allText = `${prData.title} ${prData.body} ${prData.commits.join(' ')}`
  const issues = extractIssues(allText)

  // Categorize changed files
  const files = categorizeFiles(prData.files)

  return determineVerdict(issues, files)
}

// Only run when executed directly
const isDirectExecution = !process.argv[1]?.includes('vitest')

if (isDirectExecution && existsSync('.git')) {
  try {
    const { prNumber } = parseArgs()
    console.log(`Verifying implementation completeness for PR #${prNumber}...`)

    const prData = fetchPrData(prNumber)
    const result = run(prData)

    writeSummary(result, prNumber)

    console.log(`Verdict: ${result.verdict}`)
    console.log(result.reason)

    if (result.verdict === 'fail') {
      process.exit(1)
    }
  } catch (err) {
    console.error('verify-implementation failed:', (err as Error).message)
    // Fail open during rollout — don't block PRs on script errors
    process.exit(0)
  }
}
