#!/usr/bin/env npx tsx
/**
 * Large Skill A/B Testing Experiments
 *
 * Compares original Claude Flow V3 skills (1000+ lines) against
 * Skillsmith-optimized versions to validate optimization claims at scale.
 *
 * Usage:
 *   npx tsx scripts/run-large-skill-experiments.ts [--skill <name>] [--iterations <n>]
 *
 * Options:
 *   --skill       Run experiment for a single skill (default: all Tier 1)
 *   --iterations  Number of A/B test iterations per skill (default: 10)
 *   --dry-run     Download and transform only, skip A/B testing
 *   --output      Output directory for results (default: docs/research/ab-test)
 *
 * Prerequisites:
 *   1. Docker container running: docker compose --profile dev up -d
 *   2. TransformationService built: docker exec skillsmith-dev-1 npm run build
 *   3. Dist copied locally: docker cp skillsmith-dev-1:/app/packages/core/dist/. packages/core/dist/
 *
 * @see docs/research/ab-test/large-skill-experiments.md
 */

import { execSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

// ============================================================================
// Configuration
// ============================================================================

interface SkillConfig {
  name: string
  lines: number
  tier: 1 | 2
  testPrompt: string
}

const TIER_1_SKILLS: SkillConfig[] = [
  {
    name: 'pair-programming',
    lines: 1202,
    tier: 1,
    testPrompt: 'Start a TDD session to implement a binary search function in TypeScript',
  },
  {
    name: 'github-code-review',
    lines: 1140,
    tier: 1,
    testPrompt: 'Review the changes in the current branch for security issues',
  },
  {
    name: 'sparc-methodology',
    lines: 1115,
    tier: 1,
    testPrompt: 'Plan the implementation of a REST API authentication system',
  },
  {
    name: 'github-release-management',
    lines: 1081,
    tier: 1,
    testPrompt: 'Create a release plan for version 2.0.0',
  },
  {
    name: 'github-workflow-automation',
    lines: 1065,
    tier: 1,
    testPrompt: 'Create a CI/CD workflow for a Node.js monorepo',
  },
]

const TIER_2_SKILLS: SkillConfig[] = [
  {
    name: 'swarm-advanced',
    lines: 973,
    tier: 2,
    testPrompt: 'Create a research swarm to analyze microservices patterns',
  },
  {
    name: 'v3-core-implementation',
    lines: 797,
    tier: 2,
    testPrompt: 'Implement the core agent spawning system',
  },
  {
    name: 'hive-mind-advanced',
    lines: 712,
    tier: 2,
    testPrompt: 'Design a hierarchical queen-worker coordination system',
  },
]

const CLAUDE_FLOW_REPO = 'ruvnet/claude-flow'
const SKILLS_PATH = '.claude/skills'
const MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_ITERATIONS = 10
const TIMEOUT_MS = 180000 // 3 minutes per invocation

// ============================================================================
// Utility Functions
// ============================================================================

function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
    error: '\x1b[31m[ERROR]\x1b[0m',
  }
  console.log(`${prefix[level]} ${message}`)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function parseArgs(): {
  skill?: string
  iterations: number
  dryRun: boolean
  output: string
  tier: number
} {
  const args = process.argv.slice(2)
  const result = {
    skill: undefined as string | undefined,
    iterations: DEFAULT_ITERATIONS,
    dryRun: false,
    output: join(PROJECT_ROOT, 'docs/research/ab-test'),
    tier: 1,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--skill':
        result.skill = args[++i]
        break
      case '--iterations':
        result.iterations = parseInt(args[++i], 10)
        break
      case '--dry-run':
        result.dryRun = true
        break
      case '--output':
        result.output = args[++i]
        break
      case '--tier':
        result.tier = parseInt(args[++i], 10)
        break
    }
  }

  return result
}

// ============================================================================
// Skill Acquisition
// ============================================================================

async function downloadSkill(skillName: string, outputDir: string): Promise<string> {
  const skillPath = join(outputDir, `${skillName}.md`)

  if (existsSync(skillPath)) {
    log(`Skill ${skillName} already downloaded, using cached version`)
    return skillPath
  }

  log(`Downloading ${skillName} from ${CLAUDE_FLOW_REPO}...`)

  try {
    const result = execSync(
      `gh api repos/${CLAUDE_FLOW_REPO}/contents/${SKILLS_PATH}/${skillName}/SKILL.md --jq '.content' | base64 -d`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    )

    writeFileSync(skillPath, result)
    const lines = result.split('\n').length
    log(`Downloaded ${skillName}: ${lines} lines`)

    return skillPath
  } catch (error) {
    throw new Error(`Failed to download skill ${skillName}: ${error}`)
  }
}

// ============================================================================
// TransformationService Integration
// ============================================================================

interface TransformResult {
  success: boolean
  originalLines: number
  optimizedLines: number
  predictedReduction: number
  optimizedContent: string
  subagentGenerated: boolean
  error?: string
}

async function transformSkill(skillPath: string): Promise<TransformResult> {
  const originalContent = readFileSync(skillPath, 'utf-8')
  const originalLines = originalContent.split('\n').length

  // Find TransformationService
  const possiblePaths = [
    join(PROJECT_ROOT, 'packages/core/dist/src/services/TransformationService.js'),
    join(PROJECT_ROOT, 'packages/core/dist/services/TransformationService.js'),
  ]

  let TransformationService: (new (...args: unknown[]) => unknown) | null = null
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      try {
        const module = await import(p)
        TransformationService = module.TransformationService
        break
      } catch {
        continue
      }
    }
  }

  if (!TransformationService) {
    return {
      success: false,
      originalLines,
      optimizedLines: originalLines,
      predictedReduction: 0,
      optimizedContent: originalContent,
      subagentGenerated: false,
      error:
        'TransformationService not found. Run: docker cp skillsmith-dev-1:/app/packages/core/dist/. packages/core/dist/',
    }
  }

  try {
    const service = new TransformationService()
    const result = await service.transform(originalContent)

    const optimizedLines = result.optimized?.content?.split('\n').length || originalLines

    return {
      success: true,
      originalLines,
      optimizedLines,
      predictedReduction: result.stats?.tokenReductionPercent || 0,
      optimizedContent: result.optimized?.content || originalContent,
      subagentGenerated: !!result.subagent?.content,
    }
  } catch (error) {
    return {
      success: false,
      originalLines,
      optimizedLines: originalLines,
      predictedReduction: 0,
      optimizedContent: originalContent,
      subagentGenerated: false,
      error: `Transformation failed: ${error}`,
    }
  }
}

// ============================================================================
// A/B Testing
// ============================================================================

interface InvocationResult {
  success: boolean
  sessionId: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  error?: string
}

function invokeClaudeWithSkill(
  skillName: string,
  prompt: string,
  model: string,
  timeoutMs: number
): InvocationResult {
  const sessionId = randomUUID()
  const startTime = Date.now()

  const args = [
    '--print',
    '--output-format',
    'json',
    '--session-id',
    sessionId,
    '--model',
    model,
    '--dangerously-skip-permissions',
    `/${skillName} ${prompt}`,
  ]

  const result = spawnSync('claude', args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  })

  const durationMs = Date.now() - startTime

  if (result.error || result.status !== 0) {
    return {
      success: false,
      sessionId,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      error: result.error?.message || result.stderr || 'Unknown error',
    }
  }

  // Parse JSON output for token usage
  try {
    const lines = result.stdout.split('\n').filter(Boolean)
    let totalInput = 0
    let totalOutput = 0

    for (const line of lines) {
      try {
        const json = JSON.parse(line)
        if (json.usage) {
          totalInput += json.usage.input_tokens || 0
          totalOutput += json.usage.output_tokens || 0
        }
      } catch {
        continue
      }
    }

    return {
      success: true,
      sessionId,
      durationMs,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
    }
  } catch (error) {
    return {
      success: false,
      sessionId,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      error: `Failed to parse output: ${error}`,
    }
  }
}

function installTempSkill(name: string, content: string): string {
  const skillDir = join(process.env.HOME || '~', '.claude/skills', `__test_${name}`)
  ensureDir(skillDir)
  writeFileSync(join(skillDir, 'SKILL.md'), content)
  return `__test_${name}`
}

function cleanupTempSkills(): void {
  const skillsDir = join(process.env.HOME || '~', '.claude/skills')
  try {
    const entries = execSync(`ls ${skillsDir}`, { encoding: 'utf-8' })
      .split('\n')
      .filter((e) => e.startsWith('__test_'))

    for (const entry of entries) {
      rmSync(join(skillsDir, entry), { recursive: true, force: true })
    }
  } catch {
    // Ignore cleanup errors
  }
}

interface ABTestResult {
  skillName: string
  originalLines: number
  optimizedLines: number
  predictedReduction: number
  iterations: number
  original: {
    tokens: number[]
    mean: number
    median: number
    stdDev: number
  }
  optimized: {
    tokens: number[]
    mean: number
    median: number
    stdDev: number
  }
  actualReduction: number
  predictionVariance: number
  cohensD: number
  pValue: number
  ci95: [number, number]
  withinTolerance: boolean
}

function calculateStats(values: number[]): { mean: number; median: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, median: 0, stdDev: 0 }

  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)]
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
  const stdDev = Math.sqrt(variance)

  return { mean, median, stdDev }
}

function calculateCohensD(group1: number[], group2: number[]): number {
  const stats1 = calculateStats(group1)
  const stats2 = calculateStats(group2)

  const pooledStdDev = Math.sqrt((stats1.stdDev ** 2 + stats2.stdDev ** 2) / 2)

  if (pooledStdDev === 0) return 0
  return (stats1.mean - stats2.mean) / pooledStdDev
}

function mannWhitneyU(group1: number[], group2: number[]): number {
  // Simplified Mann-Whitney U test approximation
  const n1 = group1.length
  const n2 = group2.length

  const combined = [
    ...group1.map((v) => ({ v, group: 1 })),
    ...group2.map((v) => ({ v, group: 2 })),
  ].sort((a, b) => a.v - b.v)

  let rank = 1
  let r1 = 0
  for (const item of combined) {
    if (item.group === 1) r1 += rank
    rank++
  }

  const u1 = n1 * n2 + (n1 * (n1 + 1)) / 2 - r1
  const mu = (n1 * n2) / 2
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)

  const z = (u1 - mu) / sigma

  // Two-tailed p-value approximation
  const p = 2 * (1 - normalCDF(Math.abs(z)))
  return p
}

function normalCDF(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = x < 0 ? -1 : 1
  x = Math.abs(x) / Math.sqrt(2)

  const t = 1.0 / (1.0 + p * x)
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)

  return 0.5 * (1.0 + sign * y)
}

async function runABTest(
  skill: SkillConfig,
  originalContent: string,
  optimizedContent: string,
  predictedReduction: number,
  iterations: number
): Promise<ABTestResult> {
  log(`Running A/B test for ${skill.name} with ${iterations} iterations...`)

  // Install temp skills
  const originalSkillName = installTempSkill(`original_${skill.name}`, originalContent)
  const optimizedSkillName = installTempSkill(`optimized_${skill.name}`, optimizedContent)

  const originalTokens: number[] = []
  const optimizedTokens: number[] = []

  try {
    for (let i = 0; i < iterations; i++) {
      log(`  Iteration ${i + 1}/${iterations}...`)

      // Test original
      const origResult = invokeClaudeWithSkill(
        originalSkillName,
        skill.testPrompt,
        MODEL,
        TIMEOUT_MS
      )
      if (origResult.success && origResult.totalTokens > 0) {
        originalTokens.push(origResult.totalTokens)
      }

      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 2000))

      // Test optimized
      const optResult = invokeClaudeWithSkill(
        optimizedSkillName,
        skill.testPrompt,
        MODEL,
        TIMEOUT_MS
      )
      if (optResult.success && optResult.totalTokens > 0) {
        optimizedTokens.push(optResult.totalTokens)
      }

      await new Promise((r) => setTimeout(r, 2000))
    }
  } finally {
    cleanupTempSkills()
  }

  const origStats = calculateStats(originalTokens)
  const optStats = calculateStats(optimizedTokens)

  const actualReduction =
    origStats.mean > 0 ? ((origStats.mean - optStats.mean) / origStats.mean) * 100 : 0

  const cohensD = calculateCohensD(originalTokens, optimizedTokens)
  const pValue = mannWhitneyU(originalTokens, optimizedTokens)

  // 95% CI for reduction
  const seDiff = Math.sqrt(
    origStats.stdDev ** 2 / originalTokens.length + optStats.stdDev ** 2 / optimizedTokens.length
  )
  const meanDiff = origStats.mean - optStats.mean
  const ci95Lower = origStats.mean > 0 ? ((meanDiff - 1.96 * seDiff) / origStats.mean) * 100 : 0
  const ci95Upper = origStats.mean > 0 ? ((meanDiff + 1.96 * seDiff) / origStats.mean) * 100 : 0

  return {
    skillName: skill.name,
    originalLines: skill.lines,
    optimizedLines: optimizedContent.split('\n').length,
    predictedReduction,
    iterations,
    original: {
      tokens: originalTokens,
      ...origStats,
    },
    optimized: {
      tokens: optimizedTokens,
      ...optStats,
    },
    actualReduction,
    predictionVariance: Math.abs(actualReduction - predictedReduction),
    cohensD,
    pValue,
    ci95: [ci95Lower, ci95Upper],
    withinTolerance: Math.abs(actualReduction - predictedReduction) <= 10,
  }
}

// ============================================================================
// Report Generation
// ============================================================================

function generateReport(results: ABTestResult[], outputDir: string): void {
  const timestamp = new Date().toISOString().split('T')[0]
  const reportPath = join(outputDir, `large-skill-ab-results-${timestamp}.md`)
  const jsonPath = join(outputDir, `large-skill-ab-results-${timestamp}.json`)

  // JSON report
  writeFileSync(jsonPath, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2))

  // Markdown report
  const successfulResults = results.filter((r) => r.original.tokens.length > 0)

  const avgReduction =
    successfulResults.length > 0
      ? successfulResults.reduce((sum, r) => sum + r.actualReduction, 0) / successfulResults.length
      : 0

  const avgPredicted =
    successfulResults.length > 0
      ? successfulResults.reduce((sum, r) => sum + r.predictedReduction, 0) /
        successfulResults.length
      : 0

  let md = `# Large Skill A/B Test Results

> Generated: ${new Date().toISOString()}

## Executive Summary

| Metric | Value |
|--------|-------|
| Skills Tested | ${results.length} |
| Successful Tests | ${successfulResults.length} |
| Average Predicted Reduction | ${avgPredicted.toFixed(1)}% |
| Average Actual Reduction | ${avgReduction.toFixed(1)}% |
| Prediction Accuracy | ${(100 - Math.abs(avgReduction - avgPredicted)).toFixed(1)}% |

## Results by Skill

`

  for (const result of results) {
    const status =
      result.pValue < 0.05
        ? result.actualReduction > 0
          ? '✅ SIGNIFICANT'
          : '⚠️ REGRESSION'
        : '❌ NOT SIGNIFICANT'

    md += `### ${result.skillName}

| Metric | Original | Optimized | Delta |
|--------|----------|-----------|-------|
| Lines | ${result.originalLines} | ${result.optimizedLines} | -${((1 - result.optimizedLines / result.originalLines) * 100).toFixed(1)}% |
| Tokens (mean) | ${result.original.mean.toFixed(0)} | ${result.optimized.mean.toFixed(0)} | ${result.actualReduction.toFixed(1)}% |
| Tokens (median) | ${result.original.median.toFixed(0)} | ${result.optimized.median.toFixed(0)} | - |
| Std Dev | ${result.original.stdDev.toFixed(0)} | ${result.optimized.stdDev.toFixed(0)} | - |

**Statistical Analysis:**
- Predicted Reduction: ${result.predictedReduction.toFixed(1)}%
- Actual Reduction: ${result.actualReduction.toFixed(1)}%
- Prediction Variance: ${result.predictionVariance.toFixed(1)}%
- Cohen's d: ${result.cohensD.toFixed(3)}
- p-value: ${result.pValue.toFixed(4)}
- 95% CI: [${result.ci95[0].toFixed(1)}%, ${result.ci95[1].toFixed(1)}%]
- Status: ${status}

---

`
  }

  md += `## Reproducibility

\`\`\`bash
npx tsx scripts/run-large-skill-experiments.ts --iterations ${results[0]?.iterations || 10}
\`\`\`

Model: ${MODEL}
`

  writeFileSync(reportPath, md)

  log(`Reports generated:`)
  log(`  - ${reportPath}`)
  log(`  - ${jsonPath}`)
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs()

  log('Large Skill A/B Testing Experiments')
  log('====================================')
  log(`Iterations: ${args.iterations}`)
  log(`Output: ${args.output}`)
  log(`Dry run: ${args.dryRun}`)
  log('')

  ensureDir(args.output)

  const skillsDir = join(PROJECT_ROOT, 'experiments/original-skills')
  const transformedDir = join(PROJECT_ROOT, 'experiments/transformed-skills')
  ensureDir(skillsDir)
  ensureDir(transformedDir)

  // Select skills based on tier or specific skill
  let skills: SkillConfig[]
  if (args.skill) {
    const found = [...TIER_1_SKILLS, ...TIER_2_SKILLS].find((s) => s.name === args.skill)
    if (!found) {
      log(`Skill ${args.skill} not found. Available skills:`, 'error')
      log(
        [...TIER_1_SKILLS, ...TIER_2_SKILLS]
          .map((s) => `  - ${s.name} (${s.lines} lines)`)
          .join('\n')
      )
      process.exit(1)
    }
    skills = [found]
  } else {
    skills = args.tier === 2 ? TIER_2_SKILLS : TIER_1_SKILLS
  }

  log(`Testing ${skills.length} skills: ${skills.map((s) => s.name).join(', ')}`)
  log('')

  const results: ABTestResult[] = []

  for (const skill of skills) {
    log(`\n========== ${skill.name} (${skill.lines} lines) ==========\n`)

    // Download
    const skillPath = await downloadSkill(skill.name, skillsDir)
    const originalContent = readFileSync(skillPath, 'utf-8')

    // Transform
    log('Transforming with Skillsmith...')
    const transform = await transformSkill(skillPath)

    if (!transform.success) {
      log(`Transformation failed: ${transform.error}`, 'error')
      continue
    }

    log(`Transformation complete:`)
    log(`  - Original: ${transform.originalLines} lines`)
    log(`  - Optimized: ${transform.optimizedLines} lines`)
    log(`  - Predicted reduction: ${transform.predictedReduction}%`)
    log(`  - Subagent generated: ${transform.subagentGenerated}`)

    // Save transformed skill
    const transformedPath = join(transformedDir, `${skill.name}-optimized.md`)
    writeFileSync(transformedPath, transform.optimizedContent)

    if (args.dryRun) {
      log('Dry run - skipping A/B test')
      continue
    }

    // A/B Test
    const result = await runABTest(
      skill,
      originalContent,
      transform.optimizedContent,
      transform.predictedReduction,
      args.iterations
    )

    results.push(result)

    log(`\nResult for ${skill.name}:`)
    log(`  Predicted: ${result.predictedReduction.toFixed(1)}%`)
    log(`  Actual: ${result.actualReduction.toFixed(1)}%`)
    log(`  p-value: ${result.pValue.toFixed(4)}`)
    log(`  Cohen's d: ${result.cohensD.toFixed(3)}`)
  }

  if (results.length > 0) {
    generateReport(results, args.output)
  }

  log('\nExperiments complete!')
}

main().catch((error) => {
  log(`Fatal error: ${error}`, 'error')
  process.exit(1)
})
