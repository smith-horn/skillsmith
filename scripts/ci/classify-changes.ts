#!/usr/bin/env npx tsx
/**
 * CI Change Classifier (SMI-2187)
 *
 * Analyzes changed files and determines the appropriate CI tier.
 * Outputs classification for GitHub Actions to use in conditional job execution.
 *
 * Usage:
 *   npx tsx scripts/ci/classify-changes.ts [--base <sha>] [--head <sha>]
 *   npx tsx scripts/ci/classify-changes.ts --files "file1.ts,file2.md"
 *
 * Output (to GITHUB_OUTPUT if available, otherwise stdout):
 *   tier=code|deps|config|docs
 *   skip_docker=true|false
 *   skip_tests=true|false
 *   changed_count=<number>
 */

import { execSync } from 'child_process'
import { existsSync, appendFileSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { minimatch } from 'minimatch'

// Constants
const MAX_FILES_IN_SUMMARY = 50

// Validation patterns for git refs (prevent command injection)
const SHA_PATTERN = /^[a-f0-9]{4,40}$/i
const REF_PATTERN = /^[a-zA-Z0-9._/-]+$/

/**
 * Classification tier representing the type of changes detected.
 * Tiers are ordered by CI compute requirements: docs < config < deps < code
 */
export type Tier = 'docs' | 'config' | 'deps' | 'code'

/**
 * Result of classifying changed files.
 * Used to determine which CI jobs should run.
 */
export interface ClassificationResult {
  /** Highest tier among all changed files */
  tier: Tier
  /** Whether Docker build can be skipped */
  skipDocker: boolean
  /** Whether tests can be skipped */
  skipTests: boolean
  /** List of files that were classified */
  changedFiles: string[]
  /** Human-readable explanation of the classification */
  reason: string
}

// Pattern definitions for each tier
const TIER_PATTERNS: Record<Tier, string[]> = {
  docs: [
    'docs/**',
    '**/*.md',
    'LICENSE',
    '.github/ISSUE_TEMPLATE/**',
    '.github/CODEOWNERS',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ],
  config: [
    '.github/workflows/**',
    '.eslintrc*',
    '.prettierrc*',
    'tsconfig*.json',
    'vitest.config.ts',
    '.gitignore',
    '.gitattributes',
    '.gitleaks.toml',
    '.husky/**',
  ],
  deps: [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'packages/*/package.json',
    'Dockerfile',
    'docker-compose*.yml',
    'docker-compose*.yaml',
    'compose.yml',
    'compose.yaml',
    '.nvmrc',
    '.node-version',
  ],
  code: [
    'packages/**/*.ts',
    'packages/**/*.tsx',
    'packages/**/*.js',
    'packages/**/*.jsx',
    'supabase/**',
    'scripts/**/*.ts',
    'scripts/**/*.js',
    'scripts/**/*.mjs',
  ],
}

// Files that always require full CI regardless of tier
const ALWAYS_FULL_CI: string[] = ['.github/workflows/ci.yml', 'Dockerfile', 'package-lock.json']

/**
 * Validate that a string is a safe git ref (SHA or branch/tag name).
 * Prevents command injection attacks.
 */
export function isValidGitRef(ref: string): boolean {
  return SHA_PATTERN.test(ref) || REF_PATTERN.test(ref)
}

/**
 * Get changed files between two commits or for a PR.
 * Uses git diff to determine which files have changed.
 */
export function getChangedFiles(base?: string, head?: string): string[] {
  try {
    let cmd: string

    if (base && head) {
      // Validate refs to prevent command injection
      if (!isValidGitRef(base) || !isValidGitRef(head)) {
        throw new Error(`Invalid git ref format: base="${base}", head="${head}"`)
      }
      // Compare two specific commits
      cmd = `git diff --name-only ${base}...${head}`
    } else if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      // PR: compare against base branch
      const baseSha = process.env.GITHUB_BASE_REF || 'main'
      if (!isValidGitRef(baseSha)) {
        throw new Error(`Invalid GITHUB_BASE_REF: "${baseSha}"`)
      }
      cmd = `git diff --name-only origin/${baseSha}...HEAD`
    } else {
      // Push: compare against parent commit
      cmd = 'git diff --name-only HEAD~1'
    }

    const output = execSync(cmd, { encoding: 'utf-8' })
    return output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0)
  } catch (error) {
    // Fallback: if git diff fails, assume all files changed
    const message = `Warning: Could not determine changed files (${error instanceof Error ? error.message : 'unknown error'}), assuming full CI needed`
    console.error(message)

    // Add warning to GitHub summary if available
    const summaryFile = process.env.GITHUB_STEP_SUMMARY
    if (summaryFile && existsSync(dirname(summaryFile))) {
      appendFileSync(summaryFile, `\n> **Warning:** ${message}\n`)
    }

    return ['**/*']
  }
}

/**
 * Check if a file matches any pattern in a list
 */
export function matchesPatterns(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true }))
}

/**
 * Classify a list of changed files into a tier.
 * Returns the highest tier among all changed files.
 */
export function classifyChanges(changedFiles: string[]): ClassificationResult {
  // Filter out empty strings that might come from git output
  const files = changedFiles.filter((f) => f.length > 0)

  // Handle empty changes (shouldn't happen, but be safe)
  if (files.length === 0) {
    return {
      tier: 'docs',
      skipDocker: true,
      skipTests: true,
      changedFiles: [],
      reason: 'No files changed',
    }
  }

  // Check for files that always require full CI
  const requiresFullCI = files.some((file) =>
    ALWAYS_FULL_CI.some((pattern) => minimatch(file, pattern, { dot: true }))
  )

  if (requiresFullCI) {
    return {
      tier: 'code',
      skipDocker: false,
      skipTests: false,
      changedFiles: files,
      reason: `Critical file changed: ${files.find((f) =>
        ALWAYS_FULL_CI.some((p) => minimatch(f, p, { dot: true }))
      )}`,
    }
  }

  // Classify each file and find the highest tier
  let highestTier: Tier = 'docs'
  const tierPriority: Tier[] = ['docs', 'config', 'deps', 'code']
  const unmatchedFiles: string[] = []

  for (const file of files) {
    let matched = false

    // Check tiers in reverse priority order (code first)
    for (const tier of [...tierPriority].reverse()) {
      if (matchesPatterns(file, TIER_PATTERNS[tier])) {
        matched = true
        if (tierPriority.indexOf(tier) > tierPriority.indexOf(highestTier)) {
          highestTier = tier
        }
        break
      }
    }

    // Track unmatched files - they will trigger code tier for safety
    if (!matched) {
      unmatchedFiles.push(file)
    }

    // If we hit code tier, no need to check more files
    if (highestTier === 'code') break
  }

  // Unknown files should trigger full CI for safety
  if (unmatchedFiles.length > 0 && highestTier !== 'code') {
    console.warn(
      `Warning: Unmatched files detected, defaulting to code tier: ${unmatchedFiles.slice(0, 5).join(', ')}${unmatchedFiles.length > 5 ? '...' : ''}`
    )
    highestTier = 'code'
  }

  // Determine skip flags based on tier
  const skipDocker = highestTier === 'docs' || highestTier === 'config'
  const skipTests = highestTier === 'docs'

  // Build reason string
  const reasons: string[] = []
  for (const tier of tierPriority) {
    const matchingFiles = files.filter((f) => matchesPatterns(f, TIER_PATTERNS[tier]))
    if (matchingFiles.length > 0) {
      reasons.push(`${tier}: ${matchingFiles.length} file(s)`)
    }
  }
  if (unmatchedFiles.length > 0) {
    reasons.push(`unmatched: ${unmatchedFiles.length} file(s)`)
  }

  return {
    tier: highestTier,
    skipDocker,
    skipTests,
    changedFiles: files,
    reason: reasons.join(', ') || 'Unclassified files',
  }
}

/**
 * Output results for GitHub Actions
 */
function outputForGitHub(result: ClassificationResult): void {
  const outputFile = process.env.GITHUB_OUTPUT
  const summaryFile = process.env.GITHUB_STEP_SUMMARY

  const outputs = [
    `tier=${result.tier}`,
    `skip_docker=${result.skipDocker}`,
    `skip_tests=${result.skipTests}`,
    `changed_count=${result.changedFiles.length}`,
  ]

  // Use dirname for safe path handling (fixes path traversal concern)
  if (outputFile && existsSync(dirname(outputFile))) {
    // Write to GITHUB_OUTPUT file
    for (const output of outputs) {
      appendFileSync(outputFile, `${output}\n`)
    }
  } else {
    // Fallback: print to stdout for local testing
    console.log('\n=== GitHub Actions Output ===')
    for (const output of outputs) {
      console.log(output)
    }
  }

  // Generate job summary
  const summary = `
## CI Change Classification

| Metric | Value |
|--------|-------|
| **Tier** | \`${result.tier}\` |
| **Skip Docker** | ${result.skipDocker ? '✅ Yes' : '❌ No'} |
| **Skip Tests** | ${result.skipTests ? '✅ Yes' : '❌ No'} |
| **Files Changed** | ${result.changedFiles.length} |

### Classification Reason
${result.reason}

### Changed Files
<details>
<summary>Show ${result.changedFiles.length} files</summary>

\`\`\`
${result.changedFiles.slice(0, MAX_FILES_IN_SUMMARY).join('\n')}
${result.changedFiles.length > MAX_FILES_IN_SUMMARY ? `\n... and ${result.changedFiles.length - MAX_FILES_IN_SUMMARY} more` : ''}
\`\`\`
</details>
`

  if (summaryFile && existsSync(dirname(summaryFile))) {
    appendFileSync(summaryFile, summary)
  } else {
    console.log(summary)
  }
}

/**
 * Main entry point
 */
function main(): void {
  const args = process.argv.slice(2)

  let changedFiles: string[]

  // Parse arguments
  const filesIndex = args.indexOf('--files')
  const baseIndex = args.indexOf('--base')
  const headIndex = args.indexOf('--head')

  if (filesIndex !== -1 && args[filesIndex + 1]) {
    // Direct file list provided (for testing)
    changedFiles = args[filesIndex + 1].split(',').filter(Boolean)
  } else {
    // Get from git
    const base = baseIndex !== -1 ? args[baseIndex + 1] : undefined
    const head = headIndex !== -1 ? args[headIndex + 1] : undefined
    changedFiles = getChangedFiles(base, head)
  }

  console.log(`Classifying ${changedFiles.length} changed files...`)

  const result = classifyChanges(changedFiles)

  console.log(`\nClassification: ${result.tier.toUpperCase()}`)
  console.log(`Reason: ${result.reason}`)

  outputForGitHub(result)
}

// Run if executed directly (ES module compatible)
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url)
if (isMainModule) {
  main()
}
