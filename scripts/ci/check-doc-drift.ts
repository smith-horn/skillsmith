#!/usr/bin/env npx tsx
/**
 * CI Documentation Drift Check (SMI-3882)
 *
 * Analyzes PR changed files and diff content to detect code changes
 * that lack corresponding documentation updates.
 *
 * Usage:
 *   npx tsx scripts/ci/check-doc-drift.ts --pr-number 123
 *
 * Environment:
 *   GH_TOKEN - GitHub token for API access (provided by actions/checkout)
 *
 * Verdicts:
 *   pass - No documentation gaps detected
 *   warn - Advisory gaps detected (non-blocking)
 *   fail - Required documentation missing
 *   skip - [skip-doc-drift] in PR body
 */

import { execFileSync } from 'child_process'
import { appendFileSync, existsSync } from 'fs'

// --- Types ---

export type Verdict = 'pass' | 'warn' | 'fail' | 'skip'

export interface DocGap {
  trigger: string
  surface: string
  severity: 'fail' | 'warn'
}

export interface DocDriftResult {
  verdict: Verdict
  gaps: DocGap[]
  reason: string
}

export interface PrData {
  title: string
  body: string
  files: string[]
  diff: string
}

// --- Constants ---

const SKIP_MARKER = '[skip-doc-drift]'

// --- Detection Functions ---

/** Detect new MCP tool registrations without doc updates */
export function detectNewMcpTools(files: string[], diff: string): DocGap[] {
  const gaps: DocGap[] = []
  const indexChanged = files.some((f) => f === 'packages/mcp-server/src/index.ts')
  if (!indexChanged) return gaps

  // Check for new entries added to toolDefinitions array
  const addedLines = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  const hasNewTool = addedLines.some(
    (line) => /Schema\s*[,\]]/.test(line) || /Tool\s*[,\]]/.test(line)
  )
  if (!hasNewTool) return gaps

  const docSurfaces = [
    'README.md',
    'packages/mcp-server/README.md',
    'packages/website/src/pages/docs/mcp-server.astro',
    'CLAUDE.md',
  ]

  for (const surface of docSurfaces) {
    if (!files.includes(surface)) {
      gaps.push({
        trigger: 'New MCP tool registered in toolDefinitions',
        surface,
        severity: 'fail',
      })
    }
  }
  return gaps
}

/** Detect new CLI command registrations without doc updates */
export function detectNewCliCommands(files: string[], diff: string): DocGap[] {
  const gaps: DocGap[] = []
  const cliSrcChanged = files.some(
    (f) => f.startsWith('packages/cli/src/') && !f.includes('.test.')
  )
  if (!cliSrcChanged) return gaps

  // Check for new command registration in diff
  const addedLines = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  const hasNewCommand = addedLines.some(
    (line) => /\.command\(/.test(line) || /registerCommand/.test(line)
  )
  if (!hasNewCommand) return gaps

  const docSurfaces = ['packages/website/src/pages/docs/cli.astro', 'packages/cli/README.md']

  for (const surface of docSurfaces) {
    if (!files.includes(surface)) {
      gaps.push({
        trigger: 'New CLI command registered',
        surface,
        severity: 'fail',
      })
    }
  }
  return gaps
}

/** Detect package version bumps without CHANGELOG updates */
export function detectVersionBumps(files: string[]): DocGap[] {
  const gaps: DocGap[] = []

  // Check each package's package.json
  const pkgJsonFiles = files.filter(
    (f) => f.match(/^packages\/[^/]+\/package\.json$/) || f === 'package.json'
  )

  for (const pkgJson of pkgJsonFiles) {
    const dir = pkgJson === 'package.json' ? '' : pkgJson.replace('/package.json', '')
    const changelog = dir ? `${dir}/CHANGELOG.md` : 'CHANGELOG.md'

    if (!files.includes(changelog)) {
      gaps.push({
        trigger: `Version bump in ${pkgJson}`,
        surface: changelog,
        severity: 'fail',
      })
    }
  }
  return gaps
}

/** Detect security feature changes without doc updates */
export function detectSecurityFeatures(files: string[]): DocGap[] {
  const gaps: DocGap[] = []
  const securityFiles = files.filter(
    (f) =>
      (f.includes('/security/') || f.includes('/pii/') || f.includes('/risk/')) &&
      !f.includes('.test.')
  )
  if (securityFiles.length === 0) return gaps

  if (!files.includes('packages/website/src/pages/docs/security.astro')) {
    gaps.push({
      trigger: `Security feature changes (${securityFiles.length} file(s))`,
      surface: 'packages/website/src/pages/docs/security.astro',
      severity: 'warn',
    })
  }
  return gaps
}

/** Detect VS Code extension changes without CHANGELOG updates */
export function detectVscodeChanges(files: string[]): DocGap[] {
  const gaps: DocGap[] = []
  const vscodeSrcChanged = files.some(
    (f) => f.startsWith('packages/vscode-extension/src/') && !f.includes('.test.')
  )
  if (!vscodeSrcChanged) return gaps

  if (!files.includes('packages/vscode-extension/CHANGELOG.md')) {
    gaps.push({
      trigger: 'VS Code extension source changes',
      surface: 'packages/vscode-extension/CHANGELOG.md',
      severity: 'warn',
    })
  }
  return gaps
}

/** Detect migration additions without CHANGELOG updates */
export function detectMigrations(files: string[]): DocGap[] {
  const gaps: DocGap[] = []
  const hasMigration = files.some((f) => f.startsWith('packages/core/src/database/migrations/'))
  if (!hasMigration) return gaps

  if (!files.includes('packages/core/CHANGELOG.md')) {
    gaps.push({
      trigger: 'Database migration added',
      surface: 'packages/core/CHANGELOG.md',
      severity: 'warn',
    })
  }
  return gaps
}

// --- Main Logic ---

export function run(prData: PrData): DocDriftResult {
  // Check escape hatch
  if (prData.body.includes(SKIP_MARKER)) {
    return {
      verdict: 'skip',
      gaps: [],
      reason: '[skip-doc-drift] found in PR body — skipping documentation drift check.',
    }
  }

  // Only analyze non-test source files — if PR is only tests, no doc requirement
  const hasNonTestSource = prData.files.some(
    (f) =>
      (f.startsWith('packages/') || f.startsWith('scripts/') || f.startsWith('supabase/')) &&
      /\.(ts|tsx|js|jsx|mjs)$/.test(f) &&
      !f.includes('.test.') &&
      !f.includes('.spec.')
  )
  if (!hasNonTestSource) {
    return {
      verdict: 'pass',
      gaps: [],
      reason: 'No non-test source files changed — no documentation requirement.',
    }
  }

  // Run all detectors
  const gaps: DocGap[] = [
    ...detectNewMcpTools(prData.files, prData.diff),
    ...detectNewCliCommands(prData.files, prData.diff),
    ...detectVersionBumps(prData.files),
    ...detectSecurityFeatures(prData.files),
    ...detectVscodeChanges(prData.files),
    ...detectMigrations(prData.files),
  ]

  if (gaps.length === 0) {
    return {
      verdict: 'pass',
      gaps: [],
      reason: 'No documentation gaps detected.',
    }
  }

  // Highest severity wins
  const hasFail = gaps.some((g) => g.severity === 'fail')
  const verdict: Verdict = hasFail ? 'fail' : 'warn'

  const failCount = gaps.filter((g) => g.severity === 'fail').length
  const warnCount = gaps.filter((g) => g.severity === 'warn').length
  const parts: string[] = []
  if (failCount > 0) parts.push(`${failCount} required`)
  if (warnCount > 0) parts.push(`${warnCount} advisory`)

  return {
    verdict,
    gaps,
    reason: `Documentation drift detected: ${parts.join(', ')} gap(s). Add [skip-doc-drift] to PR body to bypass.`,
  }
}

// --- GitHub API ---

function fetchPrData(prNumber: number): PrData {
  const prJson = execFileSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'title,body,files'],
    { encoding: 'utf-8', timeout: 15000 }
  )

  const pr = JSON.parse(prJson)
  const files = (pr.files || []).map((f: { path: string }) => f.path)

  const diff = execFileSync('gh', ['pr', 'diff', String(prNumber)], {
    encoding: 'utf-8',
    timeout: 15000,
  })

  return {
    title: pr.title || '',
    body: pr.body || '',
    files,
    diff,
  }
}

// --- Output ---

function writeSummary(result: DocDriftResult, prNumber: number): void {
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
    `## :${icon}: Documentation Drift Check — ${result.verdict.toUpperCase()}`,
    '',
    `**PR #${prNumber}**`,
    '',
    result.reason,
    '',
  ]

  if (result.gaps.length > 0) {
    lines.push('### Detected Gaps', '')
    lines.push('| Trigger | Missing Surface | Severity |')
    lines.push('|---------|----------------|----------|')
    for (const gap of result.gaps) {
      lines.push(`| ${gap.trigger} | \`${gap.surface}\` | ${gap.severity} |`)
    }
    lines.push('')
  }

  appendFileSync(summaryPath, lines.join('\n') + '\n')
}

// --- CLI Entry Point ---

function parseArgs(): { prNumber: number } {
  const args = process.argv.slice(2)
  const prIdx = args.indexOf('--pr-number')
  if (prIdx === -1 || !args[prIdx + 1]) {
    console.error('Usage: check-doc-drift.ts --pr-number <number>')
    process.exit(1)
  }
  const prNumber = parseInt(args[prIdx + 1], 10)
  if (isNaN(prNumber) || prNumber <= 0) {
    console.error('Invalid PR number:', args[prIdx + 1])
    process.exit(1)
  }
  return { prNumber }
}

// Only run when executed directly
const isDirectExecution = !process.argv[1]?.includes('vitest')

if (isDirectExecution && existsSync('.git')) {
  try {
    const { prNumber } = parseArgs()
    console.log(`Checking documentation drift for PR #${prNumber}...`)

    const prData = fetchPrData(prNumber)
    const result = run(prData)

    writeSummary(result, prNumber)

    console.log(`Verdict: ${result.verdict}`)
    console.log(result.reason)

    if (result.verdict === 'fail') {
      process.exit(1)
    }
  } catch (err) {
    console.error('check-doc-drift failed:', (err as Error).message)
    // Fail open during rollout — don't block PRs on script errors
    process.exit(0)
  }
}
