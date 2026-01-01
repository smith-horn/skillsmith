/**
 * Code Review Module
 *
 * Reviews code changes after each epic:
 * - Architecture alignment with Skillsmith patterns
 * - Security vulnerabilities
 * - Test coverage requirements
 * - Code style compliance
 */

import { spawn } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { Epic, CodeReviewFinding, CONFIG, CODE_REVIEW_FOCUS } from './config.js'
import { EpicResult } from './epic-runner.js'

export interface CodeReviewResult {
  epicId: string
  findings: CodeReviewFinding[]
  blockers: CodeReviewFinding[]
  passed: boolean
  summary: string
}

/**
 * Run security scanner on changed files
 */
async function runSecurityScan(artifacts: string[], dryRun: boolean): Promise<CodeReviewFinding[]> {
  const findings: CodeReviewFinding[] = []

  if (dryRun) {
    console.log('[CodeReview] [DryRun] Would run security scan on:', artifacts)
    return findings
  }

  // Check for common security issues
  const securityPatterns = [
    {
      pattern: /process\.env\.\w+/g,
      issue: 'Direct environment variable access',
      severity: 'medium' as const,
    },
    { pattern: /eval\(/g, issue: 'Use of eval()', severity: 'critical' as const },
    { pattern: /innerHTML\s*=/g, issue: 'Direct innerHTML assignment', severity: 'high' as const },
    {
      pattern: /dangerouslySetInnerHTML/g,
      issue: 'React dangerouslySetInnerHTML',
      severity: 'high' as const,
    },
    { pattern: /exec\(/g, issue: 'Shell command execution', severity: 'high' as const },
    {
      pattern: /password\s*[:=]\s*['"][^'"]+['"]/gi,
      issue: 'Hardcoded password',
      severity: 'critical' as const,
    },
    {
      pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/gi,
      issue: 'Hardcoded API key',
      severity: 'critical' as const,
    },
  ]

  for (const artifact of artifacts) {
    const fullPath = join(CONFIG.skillsmithPath, artifact)
    if (!existsSync(fullPath)) continue

    try {
      const content = readFileSync(fullPath, 'utf-8')

      for (const { pattern, issue, severity } of securityPatterns) {
        const matches = content.match(pattern)
        if (matches) {
          findings.push({
            severity,
            category: 'security',
            title: issue,
            description: `Found ${matches.length} instance(s) in ${artifact}`,
            file: artifact,
            suggestedFix: `Review and refactor to use secure patterns. See packages/core/src/security/scanner.ts for examples.`,
          })
        }
      }
    } catch {
      // File read error, skip
    }
  }

  return findings
}

/**
 * Check architecture alignment
 */
async function checkArchitecture(
  artifacts: string[],
  dryRun: boolean
): Promise<CodeReviewFinding[]> {
  const findings: CodeReviewFinding[] = []

  if (dryRun) {
    console.log('[CodeReview] [DryRun] Would check architecture for:', artifacts)
    return findings
  }

  // Check for proper module structure
  const requiredPatterns = {
    'packages/core/src/': ['export interface', 'export class', 'export function'],
    'packages/mcp-server/src/tools/': ['CallToolResult', 'MCP_TOOLS'],
  }

  for (const artifact of artifacts) {
    for (const [pathPattern] of Object.entries(requiredPatterns)) {
      if (artifact.includes(pathPattern)) {
        const fullPath = join(CONFIG.skillsmithPath, artifact)
        if (!existsSync(fullPath)) continue

        try {
          const content = readFileSync(fullPath, 'utf-8')

          // Check for missing exports
          if (!content.includes('export')) {
            findings.push({
              severity: 'medium',
              category: 'architecture',
              title: 'Missing exports',
              description: `File ${artifact} has no exports. Core modules should export their public API.`,
              file: artifact,
              suggestedFix: 'Add proper exports following packages/core/src/index.ts pattern.',
            })
          }

          // Check for circular import potential
          if (content.includes("from '../") && content.includes("from './")) {
            const imports = content.match(/from\s+['"][^'"]+['"]/g) || []
            if (imports.length > 10) {
              findings.push({
                severity: 'medium',
                category: 'architecture',
                title: 'High import count',
                description: `File ${artifact} has ${imports.length} imports. Consider splitting into smaller modules.`,
                file: artifact,
              })
            }
          }
        } catch {
          // Skip on error
        }
      }
    }
  }

  return findings
}

/**
 * Check test coverage
 */
async function checkTestCoverage(
  artifacts: string[],
  dryRun: boolean
): Promise<CodeReviewFinding[]> {
  const findings: CodeReviewFinding[] = []

  if (dryRun) {
    console.log('[CodeReview] [DryRun] Would check test coverage for:', artifacts)
    return findings
  }

  // Check that source files have corresponding tests
  for (const artifact of artifacts) {
    if (
      !artifact.endsWith('.ts') ||
      artifact.includes('.test.') ||
      artifact.includes('__tests__')
    ) {
      continue
    }

    // Expected test file locations
    const testPatterns = [
      artifact.replace('/src/', '/tests/').replace('.ts', '.test.ts'),
      artifact.replace('.ts', '.test.ts'),
      artifact.replace('/src/', '/src/__tests__/').replace('.ts', '.test.ts'),
    ]

    const hasTest = testPatterns.some((pattern) => {
      const testPath = join(CONFIG.skillsmithPath, pattern)
      return existsSync(testPath)
    })

    if (!hasTest) {
      findings.push({
        severity: 'high',
        category: 'testing',
        title: 'Missing test file',
        description: `No test file found for ${artifact}. Expected at ${testPatterns[0]}`,
        file: artifact,
        suggestedFix: `Create test file following packages/core/tests/ patterns. Target ${CODE_REVIEW_FOCUS.testing.minCoverage}% coverage.`,
      })
    }
  }

  return findings
}

/**
 * Run full code review suite
 */
export async function runCodeReview(
  epic: Epic,
  epicResult: EpicResult,
  dryRun = false
): Promise<CodeReviewResult> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`[CodeReview] Reviewing: ${epic.title}`)
  console.log(`${'='.repeat(60)}\n`)

  const artifacts = epicResult.artifacts

  if (artifacts.length === 0) {
    console.log('[CodeReview] No artifacts to review')
    return {
      epicId: epic.id,
      findings: [],
      blockers: [],
      passed: true,
      summary: 'No code changes to review.',
    }
  }

  console.log(`[CodeReview] Reviewing ${artifacts.length} artifacts:`)
  artifacts.forEach((a) => console.log(`  - ${a}`))

  // Run all review checks
  const allFindings: CodeReviewFinding[] = []

  console.log('\n[CodeReview] Running security scan...')
  const securityFindings = await runSecurityScan(artifacts, dryRun)
  allFindings.push(...securityFindings)
  console.log(`[CodeReview] Security: ${securityFindings.length} findings`)

  console.log('[CodeReview] Checking architecture...')
  const archFindings = await checkArchitecture(artifacts, dryRun)
  allFindings.push(...archFindings)
  console.log(`[CodeReview] Architecture: ${archFindings.length} findings`)

  console.log('[CodeReview] Checking test coverage...')
  const testFindings = await checkTestCoverage(artifacts, dryRun)
  allFindings.push(...testFindings)
  console.log(`[CodeReview] Testing: ${testFindings.length} findings`)

  // Separate blockers (critical and high)
  const blockers = allFindings.filter((f) =>
    CONFIG.blockingPriorities.includes(f.severity as 'critical' | 'high')
  )

  // Generate summary
  const summary = generateReviewSummary(allFindings, blockers)

  console.log('\n[CodeReview] Summary:')
  console.log(summary)

  return {
    epicId: epic.id,
    findings: allFindings,
    blockers,
    passed: blockers.length === 0,
    summary,
  }
}

/**
 * Generate human-readable review summary
 */
function generateReviewSummary(
  findings: CodeReviewFinding[],
  blockers: CodeReviewFinding[]
): string {
  const bySeverity = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
  }

  const byCategory = {
    security: findings.filter((f) => f.category === 'security').length,
    architecture: findings.filter((f) => f.category === 'architecture').length,
    testing: findings.filter((f) => f.category === 'testing').length,
    style: findings.filter((f) => f.category === 'style').length,
  }

  return `
Code Review Results
-------------------
Total Findings: ${findings.length}
Blockers: ${blockers.length}

By Severity:
  🔴 Critical: ${bySeverity.critical}
  🟠 High: ${bySeverity.high}
  🟡 Medium: ${bySeverity.medium}
  🟢 Low: ${bySeverity.low}

By Category:
  🔒 Security: ${byCategory.security}
  🏗️ Architecture: ${byCategory.architecture}
  🧪 Testing: ${byCategory.testing}
  📝 Style: ${byCategory.style}

${blockers.length > 0 ? '⚠️  BLOCKING ISSUES REQUIRE RESOLUTION' : '✅ No blocking issues - ready to proceed'}
`.trim()
}

/**
 * Execute blocking issues before next epic
 */
export async function resolveBlockers(
  blockers: CodeReviewFinding[],
  dryRun = false
): Promise<{ resolved: string[]; unresolved: string[] }> {
  console.log(`\n[CodeReview] Resolving ${blockers.length} blocking issues...`)

  const resolved: string[] = []
  const unresolved: string[] = []

  for (const blocker of blockers) {
    console.log(`\n[CodeReview] Resolving: ${blocker.title}`)

    if (dryRun) {
      console.log(`[DryRun] Would spawn agent to resolve: ${blocker.title}`)
      resolved.push(blocker.title)
      continue
    }

    // Spawn a coder agent to fix the issue
    const fixPrompt = `
# Fix Required: ${blocker.title}

## Issue Details
- Severity: ${blocker.severity}
- Category: ${blocker.category}
- File: ${blocker.file || 'Multiple files'}

## Description
${blocker.description}

## Suggested Fix
${blocker.suggestedFix || 'Apply standard best practices for this issue type.'}

## Requirements
1. Fix the issue completely
2. Ensure no regressions
3. Add/update tests if needed
4. Follow Skillsmith coding standards

Implement the fix now.
`

    const success = await new Promise<boolean>((resolve) => {
      const proc = spawn('npx', ['claude-flow', 'sparc', 'run', 'coder', fixPrompt], {
        cwd: CONFIG.skillsmithPath,
        stdio: 'inherit',
        timeout: 300000, // 5 min per fix
      })

      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })

    if (success) {
      resolved.push(blocker.title)
      console.log(`[CodeReview] ✅ Resolved: ${blocker.title}`)
    } else {
      unresolved.push(blocker.title)
      console.log(`[CodeReview] ❌ Failed to resolve: ${blocker.title}`)
    }
  }

  return { resolved, unresolved }
}
