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
 *   affected_packages=["@skillsmith/core","@skillsmith/mcp-server"]
 */

import { execSync } from 'child_process'
import { existsSync, appendFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { minimatch } from 'minimatch'

// Classification tiers in priority order (higher = more compute needed)
export type Tier = 'docs' | 'config' | 'deps' | 'code'

export interface ClassificationResult {
  tier: Tier
  skipDocker: boolean
  skipTests: boolean
  changedFiles: string[]
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
 * Get changed files between two commits or for a PR
 */
export function getChangedFiles(base?: string, head?: string): string[] {
  try {
    let cmd: string

    if (base && head) {
      // Compare two specific commits
      cmd = `git diff --name-only ${base}...${head}`
    } else if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      // PR: compare against base branch
      const baseSha = process.env.GITHUB_BASE_REF || 'main'
      cmd = `git diff --name-only origin/${baseSha}...HEAD`
    } else {
      // Push: compare against parent commit
      cmd = 'git diff --name-only HEAD~1'
    }

    const output = execSync(cmd, { encoding: 'utf-8' })
    return output.trim().split('\n').filter(Boolean)
  } catch {
    // Fallback: if git diff fails, assume all files changed
    console.error('Warning: Could not determine changed files, assuming full CI needed')
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
 * Classify a list of changed files into a tier
 */
export function classifyChanges(changedFiles: string[]): ClassificationResult {
  // Handle empty changes (shouldn't happen, but be safe)
  if (changedFiles.length === 0) {
    return {
      tier: 'docs',
      skipDocker: true,
      skipTests: true,
      changedFiles: [],
      reason: 'No files changed',
    }
  }

  // Check for files that always require full CI
  const requiresFullCI = changedFiles.some((file) =>
    ALWAYS_FULL_CI.some((pattern) => minimatch(file, pattern, { dot: true }))
  )

  if (requiresFullCI) {
    return {
      tier: 'code',
      skipDocker: false,
      skipTests: false,
      changedFiles,
      reason: `Critical file changed: ${changedFiles.find((f) =>
        ALWAYS_FULL_CI.some((p) => minimatch(f, p, { dot: true }))
      )}`,
    }
  }

  // Classify each file and find the highest tier
  let highestTier: Tier = 'docs'
  const tierPriority: Tier[] = ['docs', 'config', 'deps', 'code']

  for (const file of changedFiles) {
    // Check tiers in reverse priority order (code first)
    for (const tier of [...tierPriority].reverse()) {
      if (matchesPatterns(file, TIER_PATTERNS[tier])) {
        if (tierPriority.indexOf(tier) > tierPriority.indexOf(highestTier)) {
          highestTier = tier
        }
        break
      }
    }

    // If we hit code tier, no need to check more files
    if (highestTier === 'code') break
  }

  // Determine skip flags based on tier
  const skipDocker = highestTier === 'docs' || highestTier === 'config'
  const skipTests = highestTier === 'docs'

  // Build reason string
  const reasons: string[] = []
  for (const tier of tierPriority) {
    const matchingFiles = changedFiles.filter((f) => matchesPatterns(f, TIER_PATTERNS[tier]))
    if (matchingFiles.length > 0) {
      reasons.push(`${tier}: ${matchingFiles.length} file(s)`)
    }
  }

  return {
    tier: highestTier,
    skipDocker,
    skipTests,
    changedFiles,
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

  if (outputFile && existsSync(outputFile.replace(/[^/]+$/, ''))) {
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
${result.changedFiles.slice(0, 50).join('\n')}
${result.changedFiles.length > 50 ? `\n... and ${result.changedFiles.length - 50} more` : ''}
\`\`\`
</details>
`

  if (summaryFile) {
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

  // Exit with appropriate code
  process.exit(0)
}

// Run if executed directly (ES module compatible)
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url)
if (isMainModule) {
  main()
}
