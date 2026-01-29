#!/usr/bin/env npx tsx
/**
 * Transformation A/B Test - Scientifically Rigorous Version
 *
 * Validates Skillsmith optimization predictions against actual Claude Code
 * token consumption using per-invocation JSON output measurement.
 *
 * Design Principles:
 * 1. Per-invocation measurement via --output-format json (not session-level)
 * 2. Fresh session per test (--session-id with UUID)
 * 3. Temporary skill installation (not fake --skill-path flag)
 * 4. Full metadata capture for reproducibility
 * 5. Statistical rigor (configurable iterations, CI calculation)
 *
 * Usage:
 *   npx tsx scripts/transformation-ab-test.ts --skill governance
 *   npx tsx scripts/transformation-ab-test.ts --skill governance --iterations 30
 *   npx tsx scripts/transformation-ab-test.ts --dry-run
 *
 * Requirements:
 *   - Claude CLI installed and authenticated
 *   - Node.js 18+
 *   - npm run build (TransformationService must be compiled)
 */

import { execSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// Types
// ============================================================================

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  costUsd: number
}

interface InvocationResult {
  success: boolean
  sessionId: string
  durationMs: number
  usage: TokenUsage
  error?: string
  rawOutput?: string
}

interface StatisticalSummary {
  n: number
  mean: number
  median: number
  stdDev: number
  min: number
  max: number
  ci95Lower: number
  ci95Upper: number
  iqrLower: number
  iqrUpper: number
  outliers: number[]
}

interface ExperimentMetadata {
  experimentId: string
  timestamp: string
  claudeVersion: string
  claudeModel: string
  nodeVersion: string
  platform: string
  osRelease: string
  skillName: string
  skillContentHash: string
  testPrompt: string
  testPromptHash: string
  iterations: number
  warmupIterations: number
  gitCommit: string
  transformationServiceVersion: string
}

interface TransformationPrediction {
  tokenReductionPercent: number
  originalLines: number
  optimizedLines: number
  subSkillCount: number
  subagentGenerated: boolean
  tasksParallelized: boolean
  transformDurationMs: number
}

interface ABTestResult {
  metadata: ExperimentMetadata
  prediction: TransformationPrediction
  original: {
    raw: InvocationResult[]
    stats: StatisticalSummary
  }
  optimized: {
    raw: InvocationResult[]
    stats: StatisticalSummary
  }
  comparison: {
    tokenReductionPercent: number
    latencyReductionPercent: number
    costReductionPercent: number
    predictionVariance: number
    withinTolerance: boolean
    effectSize: number // Cohen's d
    pValue: number | null // Mann-Whitney U test
  }
  verdict: 'VALIDATED' | 'PARTIALLY_VALIDATED' | 'NOT_VALIDATED' | 'INSUFFICIENT_DATA'
}

interface ABTestOptions {
  skillName: string
  skillPath?: string
  testPrompt: string
  iterations: number
  warmupIterations: number
  model: string
  dryRun: boolean
  verbose: boolean
  keepTempSkills: boolean
}

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

const DEFAULT_TEST_PROMPTS: Record<string, string> = {
  governance: 'Briefly list the main sections of this skill',
  linear: 'What commands does this skill provide?',
  'sparc-methodology': 'Summarize the SPARC phases in one sentence each',
  default: 'List the main capabilities of this skill in bullet points',
}

const TOLERANCE_PERCENT = 15 // Prediction within ±15% is considered validated
const MIN_ITERATIONS_FOR_STATS = 5
const RECOMMENDED_ITERATIONS = 30

// ============================================================================
// Statistical Functions
// ============================================================================

function calculateMean(data: number[]): number {
  if (data.length === 0) return 0
  return data.reduce((a, b) => a + b, 0) / data.length
}

function calculateMedian(data: number[]): number {
  if (data.length === 0) return 0
  const sorted = [...data].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function calculateStdDev(data: number[]): number {
  if (data.length < 2) return 0
  const mean = calculateMean(data)
  const squareDiffs = data.map((value) => Math.pow(value - mean, 2))
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / (data.length - 1))
}

function calculateIQR(data: number[]): { q1: number; q3: number; iqr: number } {
  const sorted = [...data].sort((a, b) => a - b)
  const q1Idx = Math.floor(sorted.length * 0.25)
  const q3Idx = Math.floor(sorted.length * 0.75)
  const q1 = sorted[q1Idx]
  const q3 = sorted[q3Idx]
  return { q1, q3, iqr: q3 - q1 }
}

function findOutliers(data: number[]): number[] {
  const { q1, q3, iqr } = calculateIQR(data)
  const lowerBound = q1 - 1.5 * iqr
  const upperBound = q3 + 1.5 * iqr
  return data.filter((x) => x < lowerBound || x > upperBound)
}

function calculate95CI(data: number[]): { lower: number; upper: number } {
  if (data.length < 2) return { lower: 0, upper: 0 }
  const mean = calculateMean(data)
  const stdErr = calculateStdDev(data) / Math.sqrt(data.length)
  // t-value for 95% CI (approximation for df > 30)
  const tValue = data.length >= 30 ? 1.96 : 2.045
  return {
    lower: mean - tValue * stdErr,
    upper: mean + tValue * stdErr,
  }
}

function calculateCohenD(group1: number[], group2: number[]): number {
  const mean1 = calculateMean(group1)
  const mean2 = calculateMean(group2)
  const var1 = Math.pow(calculateStdDev(group1), 2)
  const var2 = Math.pow(calculateStdDev(group2), 2)
  const pooledStd = Math.sqrt(
    ((group1.length - 1) * var1 + (group2.length - 1) * var2) / (group1.length + group2.length - 2)
  )
  return pooledStd === 0 ? 0 : (mean1 - mean2) / pooledStd
}

// Simple Mann-Whitney U test approximation for large samples
function mannWhitneyU(group1: number[], group2: number[]): number | null {
  if (group1.length < 10 || group2.length < 10) return null

  const n1 = group1.length
  const n2 = group2.length
  const combined = [
    ...group1.map((v) => ({ value: v, group: 1 })),
    ...group2.map((v) => ({ value: v, group: 2 })),
  ].sort((a, b) => a.value - b.value)

  // Assign ranks
  let rank = 1
  for (const item of combined) {
    ;(item as { rank: number }).rank = rank++
  }

  // Sum of ranks for group 1
  const r1 = combined
    .filter((x) => x.group === 1)
    .reduce((sum, x) => sum + (x as { rank: number }).rank, 0)

  // U statistic
  const u1 = n1 * n2 + (n1 * (n1 + 1)) / 2 - r1
  const u = Math.min(u1, n1 * n2 - u1)

  // Normal approximation for p-value
  const meanU = (n1 * n2) / 2
  const stdU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)
  const z = (u - meanU) / stdU

  // Two-tailed p-value approximation
  const pValue = 2 * (1 - normalCDF(Math.abs(z)))
  return pValue
}

function normalCDF(z: number): number {
  // Approximation of normal CDF
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = z < 0 ? -1 : 1
  z = Math.abs(z) / Math.sqrt(2)

  const t = 1.0 / (1.0 + p * z)
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z)

  return 0.5 * (1.0 + sign * y)
}

function summarizeStats(data: number[]): StatisticalSummary {
  const outliers = findOutliers(data)
  const ci = calculate95CI(data)
  const { q1, q3 } = calculateIQR(data)

  return {
    n: data.length,
    mean: calculateMean(data),
    median: calculateMedian(data),
    stdDev: calculateStdDev(data),
    min: Math.min(...data),
    max: Math.max(...data),
    ci95Lower: ci.lower,
    ci95Upper: ci.upper,
    iqrLower: q1,
    iqrUpper: q3,
    outliers,
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function log(message: string, verbose = true): void {
  if (verbose) {
    console.log(message)
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function getClaudeVersion(): string {
  try {
    const output = execSync('claude --version 2>&1', { encoding: 'utf-8', timeout: 5000 })
    const match = output.match(/(\d+\.\d+\.\d+)/)
    return match ? match[1] : 'unknown'
  } catch {
    return 'unknown'
  }
}

function getGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD 2>/dev/null', {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
    }).trim()
  } catch {
    return 'unknown'
  }
}

// ============================================================================
// Skill Management
// ============================================================================

function findSkillPath(skillName: string, customPath?: string): string | null {
  if (customPath && existsSync(customPath)) {
    return customPath
  }

  const searchPaths = [
    join(PROJECT_ROOT, '.claude/skills', skillName, 'SKILL.md'),
    join(homedir(), '.claude/skills', skillName, 'SKILL.md'),
  ]

  for (const path of searchPaths) {
    if (existsSync(path)) {
      return path
    }
  }

  return null
}

function installSkillToTemp(skillDir: string, tempName: string): string {
  const tempSkillsDir = join(homedir(), '.claude/skills')
  const tempPath = join(tempSkillsDir, tempName)

  // Clean up if exists
  if (existsSync(tempPath)) {
    rmSync(tempPath, { recursive: true, force: true })
  }

  // Copy entire skill directory
  mkdirSync(tempPath, { recursive: true })
  cpSync(skillDir, tempPath, { recursive: true })

  return tempPath
}

function removeSkillFromTemp(tempName: string): void {
  const tempPath = join(homedir(), '.claude/skills', tempName)
  if (existsSync(tempPath)) {
    rmSync(tempPath, { recursive: true, force: true })
  }
}

// ============================================================================
// Claude Invocation
// ============================================================================

function invokeClaudeWithSkill(
  skillName: string,
  prompt: string,
  model: string,
  timeoutMs = 120000
): InvocationResult {
  const sessionId = randomUUID()
  const startTime = Date.now()

  try {
    // Build command with proper flags
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
      cwd: PROJECT_ROOT,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    })

    const durationMs = Date.now() - startTime

    if (result.error) {
      return {
        success: false,
        sessionId,
        durationMs,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
        error: result.error.message,
      }
    }

    // Parse JSON output to extract usage
    const output = result.stdout || ''
    const usage = extractUsageFromJson(output)

    return {
      success: result.status === 0,
      sessionId,
      durationMs,
      usage,
      error: result.status !== 0 ? result.stderr || `Exit code: ${result.status}` : undefined,
      rawOutput: output.slice(0, 1000), // Keep first 1000 chars for debugging
    }
  } catch (err) {
    return {
      success: false,
      sessionId,
      durationMs: Date.now() - startTime,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function extractUsageFromJson(output: string): TokenUsage {
  try {
    // Find the result object with usage data
    const lines = output.split('\n').filter((l) => l.trim())

    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'result' && obj.usage) {
          return {
            inputTokens: obj.usage.input_tokens || 0,
            outputTokens: obj.usage.output_tokens || 0,
            cacheCreationTokens: obj.usage.cache_creation_input_tokens || 0,
            cacheReadTokens: obj.usage.cache_read_input_tokens || 0,
            totalTokens: (obj.usage.input_tokens || 0) + (obj.usage.output_tokens || 0),
            costUsd: obj.total_cost_usd || 0,
          }
        }
      } catch {
        // Try parsing as array
        try {
          const arr = JSON.parse(line)
          if (Array.isArray(arr)) {
            const resultObj = arr.find((x) => x.type === 'result' && x.usage)
            if (resultObj) {
              return {
                inputTokens: resultObj.usage.input_tokens || 0,
                outputTokens: resultObj.usage.output_tokens || 0,
                cacheCreationTokens: resultObj.usage.cache_creation_input_tokens || 0,
                cacheReadTokens: resultObj.usage.cache_read_input_tokens || 0,
                totalTokens:
                  (resultObj.usage.input_tokens || 0) + (resultObj.usage.output_tokens || 0),
                costUsd: resultObj.total_cost_usd || 0,
              }
            }
          }
        } catch {
          // Continue to next line
        }
      }
    }

    // Fallback: try to parse entire output as JSON array
    try {
      const parsed = JSON.parse(output)
      if (Array.isArray(parsed)) {
        const resultObj = parsed.find((x) => x.type === 'result' && x.usage)
        if (resultObj) {
          return {
            inputTokens: resultObj.usage.input_tokens || 0,
            outputTokens: resultObj.usage.output_tokens || 0,
            cacheCreationTokens: resultObj.usage.cache_creation_input_tokens || 0,
            cacheReadTokens: resultObj.usage.cache_read_input_tokens || 0,
            totalTokens: (resultObj.usage.input_tokens || 0) + (resultObj.usage.output_tokens || 0),
            costUsd: resultObj.total_cost_usd || 0,
          }
        }
      }
    } catch {
      // Ignore
    }

    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    }
  } catch {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    }
  }
}

// ============================================================================
// Transformation Service Integration
// ============================================================================

interface TransformationResult {
  transformed: boolean
  mainSkillContent: string
  subSkills: Array<{ filename: string; content: string }>
  subagent?: { filename: string; content: string }
  stats: {
    originalLines: number
    optimizedLines: number
    subSkillCount: number
    tasksParallelized: boolean
    subagentGenerated: boolean
    tokenReductionPercent: number
    transformDurationMs: number
  }
}

async function transformSkill(
  skillName: string,
  description: string,
  content: string
): Promise<TransformationResult> {
  // Try multiple possible paths (dist structure varies)
  const possiblePaths = [
    join(PROJECT_ROOT, 'packages/core/dist/src/services/TransformationService.js'),
    join(PROJECT_ROOT, 'packages/core/dist/services/TransformationService.js'),
  ]

  let distPath: string | null = null
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      distPath = path
      break
    }
  }

  if (!distPath) {
    throw new Error(
      `TransformationService not built. Run: npm run build (or docker exec skillsmith-dev-1 npm run build)`
    )
  }

  const { TransformationService } = await import(distPath)
  const service = new TransformationService()
  return service.transformWithoutCache(skillName, description, content)
}

// ============================================================================
// A/B Test Runner
// ============================================================================

async function runABTest(options: ABTestOptions): Promise<ABTestResult | null> {
  const {
    skillName,
    testPrompt,
    iterations,
    warmupIterations,
    model,
    dryRun,
    verbose,
    keepTempSkills,
  } = options

  // Find skill
  const skillPath = findSkillPath(skillName, options.skillPath)
  if (!skillPath) {
    console.error(`Skill not found: ${skillName}`)
    return null
  }

  const skillDir = dirname(skillPath)
  const skillContent = readFileSync(skillPath, 'utf-8')

  // Extract description from frontmatter
  const descMatch = skillContent.match(/description:\s*["']?([^"'\n]+)["']?/i)
  const description = descMatch?.[1] || `${skillName} skill`

  log(`\nSkill: ${skillName}`, verbose)
  log(`Path: ${skillPath}`, verbose)
  log(`Content hash: ${sha256(skillContent)}`, verbose)

  // Transform skill
  log(`\nTransforming skill...`, verbose)
  let transformResult: TransformationResult
  try {
    transformResult = await transformSkill(skillName, description, skillContent)
  } catch (err) {
    console.error(`Transformation failed: ${err}`)
    return null
  }

  const prediction: TransformationPrediction = {
    tokenReductionPercent: transformResult.stats.tokenReductionPercent,
    originalLines: transformResult.stats.originalLines,
    optimizedLines: transformResult.stats.optimizedLines,
    subSkillCount: transformResult.stats.subSkillCount,
    subagentGenerated: transformResult.stats.subagentGenerated,
    tasksParallelized: transformResult.stats.tasksParallelized,
    transformDurationMs: transformResult.stats.transformDurationMs,
  }

  log(`  Original lines: ${prediction.originalLines}`, verbose)
  log(`  Optimized lines: ${prediction.optimizedLines}`, verbose)
  log(`  Predicted token reduction: ${prediction.tokenReductionPercent}%`, verbose)

  if (dryRun) {
    console.log('\n--- DRY RUN ---')
    console.log('Would run with:')
    console.log(`  Iterations: ${iterations}`)
    console.log(`  Warmup: ${warmupIterations}`)
    console.log(`  Model: ${model}`)
    console.log(`  Prompt: "${testPrompt}"`)
    console.log('\nOptimized SKILL.md preview:')
    console.log(transformResult.mainSkillContent.slice(0, 500) + '...')
    return null
  }

  // Build metadata
  const metadata: ExperimentMetadata = {
    experimentId: randomUUID(),
    timestamp: new Date().toISOString(),
    claudeVersion: getClaudeVersion(),
    claudeModel: model,
    nodeVersion: process.version,
    platform: platform(),
    osRelease: release(),
    skillName,
    skillContentHash: sha256(skillContent),
    testPrompt,
    testPromptHash: sha256(testPrompt),
    iterations,
    warmupIterations,
    gitCommit: getGitCommit(),
    transformationServiceVersion: '1.0.0', // TODO: Extract from package.json
  }

  // Install skills to temp locations
  const originalTempName = `__test_original_${Date.now()}`
  const optimizedTempName = `__test_optimized_${Date.now()}`

  log(`\nInstalling test skills...`, verbose)
  const originalTempPath = installSkillToTemp(skillDir, originalTempName)
  log(`  Original: ${originalTempPath}`, verbose)

  // Create optimized skill directory
  const optimizedTempPath = join(homedir(), '.claude/skills', optimizedTempName)
  mkdirSync(optimizedTempPath, { recursive: true })
  writeFileSync(join(optimizedTempPath, 'SKILL.md'), transformResult.mainSkillContent)
  for (const subSkill of transformResult.subSkills) {
    writeFileSync(join(optimizedTempPath, subSkill.filename), subSkill.content)
  }
  if (
    transformResult.subagent &&
    transformResult.subagent.filename &&
    transformResult.subagent.content
  ) {
    writeFileSync(
      join(optimizedTempPath, transformResult.subagent.filename),
      transformResult.subagent.content
    )
  }
  log(`  Optimized: ${optimizedTempPath}`, verbose)

  try {
    // Warmup runs (discarded)
    if (warmupIterations > 0) {
      log(`\nRunning ${warmupIterations} warmup iterations...`, verbose)
      for (let i = 0; i < warmupIterations; i++) {
        invokeClaudeWithSkill(originalTempName, testPrompt, model)
        invokeClaudeWithSkill(optimizedTempName, testPrompt, model)
      }
    }

    // Test original skill
    log(`\nRunning ${iterations} iterations with ORIGINAL skill...`, verbose)
    const originalResults: InvocationResult[] = []
    for (let i = 0; i < iterations; i++) {
      if (verbose) process.stdout.write(`  ${i + 1}/${iterations}\r`)
      const result = invokeClaudeWithSkill(originalTempName, testPrompt, model)
      originalResults.push(result)
    }
    if (verbose) console.log()

    // Test optimized skill
    log(`Running ${iterations} iterations with OPTIMIZED skill...`, verbose)
    const optimizedResults: InvocationResult[] = []
    for (let i = 0; i < iterations; i++) {
      if (verbose) process.stdout.write(`  ${i + 1}/${iterations}\r`)
      const result = invokeClaudeWithSkill(optimizedTempName, testPrompt, model)
      optimizedResults.push(result)
    }
    if (verbose) console.log()

    // Calculate statistics
    const originalTokens = originalResults.filter((r) => r.success).map((r) => r.usage.totalTokens)
    const optimizedTokens = optimizedResults
      .filter((r) => r.success)
      .map((r) => r.usage.totalTokens)
    const originalDurations = originalResults.filter((r) => r.success).map((r) => r.durationMs)
    const optimizedDurations = optimizedResults.filter((r) => r.success).map((r) => r.durationMs)
    const originalCosts = originalResults.filter((r) => r.success).map((r) => r.usage.costUsd)
    const optimizedCosts = optimizedResults.filter((r) => r.success).map((r) => r.usage.costUsd)

    const originalStats = summarizeStats(originalTokens)
    const optimizedStats = summarizeStats(optimizedTokens)

    // Calculate comparisons
    const actualTokenReduction =
      originalStats.mean > 0
        ? ((originalStats.mean - optimizedStats.mean) / originalStats.mean) * 100
        : 0

    const actualLatencyReduction =
      calculateMean(originalDurations) > 0
        ? ((calculateMean(originalDurations) - calculateMean(optimizedDurations)) /
            calculateMean(originalDurations)) *
          100
        : 0

    const actualCostReduction =
      calculateMean(originalCosts) > 0
        ? ((calculateMean(originalCosts) - calculateMean(optimizedCosts)) /
            calculateMean(originalCosts)) *
          100
        : 0

    const predictionVariance = prediction.tokenReductionPercent - actualTokenReduction
    const effectSize = calculateCohenD(originalTokens, optimizedTokens)
    const pValue = mannWhitneyU(originalTokens, optimizedTokens)

    // Determine verdict
    let verdict: ABTestResult['verdict']
    if (
      originalTokens.length < MIN_ITERATIONS_FOR_STATS ||
      optimizedTokens.length < MIN_ITERATIONS_FOR_STATS
    ) {
      verdict = 'INSUFFICIENT_DATA'
    } else if (Math.abs(predictionVariance) <= TOLERANCE_PERCENT) {
      verdict = 'VALIDATED'
    } else if (Math.abs(predictionVariance) <= TOLERANCE_PERCENT * 2) {
      verdict = 'PARTIALLY_VALIDATED'
    } else {
      verdict = 'NOT_VALIDATED'
    }

    return {
      metadata,
      prediction,
      original: {
        raw: originalResults,
        stats: originalStats,
      },
      optimized: {
        raw: optimizedResults,
        stats: optimizedStats,
      },
      comparison: {
        tokenReductionPercent: Math.round(actualTokenReduction * 10) / 10,
        latencyReductionPercent: Math.round(actualLatencyReduction * 10) / 10,
        costReductionPercent: Math.round(actualCostReduction * 10) / 10,
        predictionVariance: Math.round(predictionVariance * 10) / 10,
        withinTolerance: Math.abs(predictionVariance) <= TOLERANCE_PERCENT,
        effectSize: Math.round(effectSize * 100) / 100,
        pValue,
      },
      verdict,
    }
  } finally {
    // Cleanup temp skills
    if (!keepTempSkills) {
      log(`\nCleaning up temp skills...`, verbose)
      removeSkillFromTemp(originalTempName)
      removeSkillFromTemp(optimizedTempName)
    } else {
      log(`\nKeeping temp skills for inspection:`, verbose)
      log(`  Original: ~/.claude/skills/${originalTempName}`, verbose)
      log(`  Optimized: ~/.claude/skills/${optimizedTempName}`, verbose)
    }
  }
}

// ============================================================================
// Report Generation
// ============================================================================

function generateMarkdownReport(result: ABTestResult): string {
  const lines: string[] = []

  lines.push('# Skillsmith A/B Test Report')
  lines.push('')
  lines.push(`**Experiment ID:** \`${result.metadata.experimentId}\``)
  lines.push(`**Date:** ${result.metadata.timestamp}`)
  lines.push(`**Skill:** ${result.metadata.skillName}`)
  lines.push(`**Model:** ${result.metadata.claudeModel}`)
  lines.push('')

  // Verdict banner
  const verdictEmoji = {
    VALIDATED: '✅',
    PARTIALLY_VALIDATED: '⚠️',
    NOT_VALIDATED: '❌',
    INSUFFICIENT_DATA: '❓',
  }[result.verdict]

  lines.push(`## Verdict: ${verdictEmoji} ${result.verdict.replace(/_/g, ' ')}`)
  lines.push('')

  // Summary table
  lines.push('## Summary')
  lines.push('')
  lines.push('| Metric | Predicted | Actual | Variance |')
  lines.push('|--------|-----------|--------|----------|')
  lines.push(
    `| Token Reduction | ${result.prediction.tokenReductionPercent}% | ${result.comparison.tokenReductionPercent}% | ${result.comparison.predictionVariance > 0 ? '+' : ''}${result.comparison.predictionVariance}% |`
  )
  lines.push(`| Latency Reduction | - | ${result.comparison.latencyReductionPercent}% | - |`)
  lines.push(`| Cost Reduction | - | ${result.comparison.costReductionPercent}% | - |`)
  lines.push('')

  // Statistical analysis
  lines.push('## Statistical Analysis')
  lines.push('')
  lines.push('### Token Usage (Original vs Optimized)')
  lines.push('')
  lines.push('| Statistic | Original | Optimized |')
  lines.push('|-----------|----------|-----------|')
  lines.push(`| N (successful) | ${result.original.stats.n} | ${result.optimized.stats.n} |`)
  lines.push(
    `| Mean | ${Math.round(result.original.stats.mean)} | ${Math.round(result.optimized.stats.mean)} |`
  )
  lines.push(
    `| Median | ${Math.round(result.original.stats.median)} | ${Math.round(result.optimized.stats.median)} |`
  )
  lines.push(
    `| Std Dev | ${Math.round(result.original.stats.stdDev)} | ${Math.round(result.optimized.stats.stdDev)} |`
  )
  lines.push(
    `| 95% CI | [${Math.round(result.original.stats.ci95Lower)}, ${Math.round(result.original.stats.ci95Upper)}] | [${Math.round(result.optimized.stats.ci95Lower)}, ${Math.round(result.optimized.stats.ci95Upper)}] |`
  )
  lines.push(
    `| Outliers | ${result.original.stats.outliers.length} | ${result.optimized.stats.outliers.length} |`
  )
  lines.push('')

  lines.push('### Effect Size & Significance')
  lines.push('')
  lines.push(
    `- **Cohen's d:** ${result.comparison.effectSize} (${interpretCohenD(result.comparison.effectSize)})`
  )
  if (result.comparison.pValue !== null) {
    lines.push(
      `- **Mann-Whitney U p-value:** ${result.comparison.pValue.toFixed(4)} (${result.comparison.pValue < 0.05 ? 'significant' : 'not significant'})`
    )
  } else {
    lines.push(`- **Mann-Whitney U:** Not calculated (requires N ≥ 10 per group)`)
  }
  lines.push('')

  // Transformation details
  lines.push('## Transformation Details')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('|--------|-------|')
  lines.push(`| Original Lines | ${result.prediction.originalLines} |`)
  lines.push(`| Optimized Lines | ${result.prediction.optimizedLines} |`)
  lines.push(
    `| Line Reduction | ${Math.round((1 - result.prediction.optimizedLines / result.prediction.originalLines) * 100)}% |`
  )
  lines.push(`| Sub-skills Created | ${result.prediction.subSkillCount} |`)
  lines.push(`| Subagent Generated | ${result.prediction.subagentGenerated ? 'Yes' : 'No'} |`)
  lines.push(`| Tasks Parallelized | ${result.prediction.tasksParallelized ? 'Yes' : 'No'} |`)
  lines.push(`| Transform Duration | ${result.prediction.transformDurationMs}ms |`)
  lines.push('')

  // Reproducibility metadata
  lines.push('## Reproducibility Metadata')
  lines.push('')
  lines.push('```yaml')
  lines.push(`experiment_id: ${result.metadata.experimentId}`)
  lines.push(`timestamp: ${result.metadata.timestamp}`)
  lines.push(`claude_version: ${result.metadata.claudeVersion}`)
  lines.push(`claude_model: ${result.metadata.claudeModel}`)
  lines.push(`node_version: ${result.metadata.nodeVersion}`)
  lines.push(`platform: ${result.metadata.platform}`)
  lines.push(`os_release: ${result.metadata.osRelease}`)
  lines.push(`skill_content_hash: ${result.metadata.skillContentHash}`)
  lines.push(`test_prompt_hash: ${result.metadata.testPromptHash}`)
  lines.push(`iterations: ${result.metadata.iterations}`)
  lines.push(`warmup_iterations: ${result.metadata.warmupIterations}`)
  lines.push(`git_commit: ${result.metadata.gitCommit}`)
  lines.push('```')
  lines.push('')

  lines.push('## Test Prompt')
  lines.push('')
  lines.push(`> ${result.metadata.testPrompt}`)
  lines.push('')

  lines.push('---')
  lines.push('*Generated by Skillsmith A/B Test Suite v2.0*')

  return lines.join('\n')
}

function interpretCohenD(d: number): string {
  const absD = Math.abs(d)
  if (absD < 0.2) return 'negligible'
  if (absD < 0.5) return 'small'
  if (absD < 0.8) return 'medium'
  return 'large'
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): ABTestOptions {
  const args = process.argv.slice(2)

  const options: ABTestOptions = {
    skillName: 'governance',
    testPrompt: '',
    iterations: 10,
    warmupIterations: 2,
    model: 'sonnet',
    dryRun: false,
    verbose: true,
    keepTempSkills: false,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--skill':
      case '-s':
        options.skillName = args[++i]
        break
      case '--skill-path':
        options.skillPath = args[++i]
        break
      case '--prompt':
      case '-p':
        options.testPrompt = args[++i]
        break
      case '--iterations':
      case '-n':
        options.iterations = parseInt(args[++i], 10)
        break
      case '--warmup':
      case '-w':
        options.warmupIterations = parseInt(args[++i], 10)
        break
      case '--model':
      case '-m':
        options.model = args[++i]
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--quiet':
      case '-q':
        options.verbose = false
        break
      case '--keep-temp':
        options.keepTempSkills = true
        break
      case '--help':
      case '-h':
        console.log(`
Skillsmith A/B Test Suite v2.0

Validates TransformationService predictions against actual Claude Code
token consumption using scientifically rigorous methodology.

Usage:
  npx tsx scripts/transformation-ab-test.ts [options]

Options:
  --skill, -s <name>       Skill name to test (default: governance)
  --skill-path <path>      Direct path to skill directory
  --prompt, -p <text>      Test prompt (default: skill-specific)
  --iterations, -n <n>     Number of test iterations (default: 10, recommended: 30)
  --warmup, -w <n>         Warmup iterations (default: 2)
  --model, -m <model>      Claude model (default: sonnet)
  --dry-run                Show what would be tested without running
  --quiet, -q              Suppress verbose output
  --keep-temp              Keep temp skill directories for inspection
  --help, -h               Show this help

Methodology:
  1. Skills installed to temp ~/.claude/skills/ directories
  2. Fresh session (--session-id) for each invocation
  3. Per-invocation tokens via --output-format json
  4. Statistical analysis: mean, median, std dev, 95% CI
  5. Effect size (Cohen's d) and significance testing

Examples:
  npx tsx scripts/transformation-ab-test.ts --skill governance
  npx tsx scripts/transformation-ab-test.ts --skill governance -n 30 -m opus
  npx tsx scripts/transformation-ab-test.ts --dry-run
`)
        process.exit(0)
    }
  }

  // Set default prompt based on skill
  if (!options.testPrompt) {
    options.testPrompt = DEFAULT_TEST_PROMPTS[options.skillName] || DEFAULT_TEST_PROMPTS.default
  }

  return options
}

async function main(): Promise<void> {
  const options = parseArgs()

  console.log('╔═══════════════════════════════════════════════════════════════╗')
  console.log('║          Skillsmith A/B Test Suite v2.0                       ║')
  console.log('║          Scientifically Rigorous Token Measurement            ║')
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log(`║  Skill: ${options.skillName.padEnd(52)} ║`)
  console.log(`║  Model: ${options.model.padEnd(52)} ║`)
  console.log(`║  Iterations: ${String(options.iterations).padEnd(48)} ║`)
  console.log('╚═══════════════════════════════════════════════════════════════╝')

  if (options.iterations < RECOMMENDED_ITERATIONS) {
    console.log(
      `\n⚠️  Note: ${RECOMMENDED_ITERATIONS}+ iterations recommended for statistical significance`
    )
  }

  const result = await runABTest(options)

  if (!result) {
    if (!options.dryRun) {
      process.exit(1)
    }
    return
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(generateMarkdownReport(result))

  // Save reports
  const reportsDir = join(PROJECT_ROOT, 'reports')
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true })
  }

  const dateStr = new Date().toISOString().split('T')[0]
  const reportPath = join(reportsDir, `ab-test-${options.skillName}-${dateStr}.md`)
  const jsonPath = join(reportsDir, `ab-test-${options.skillName}-${dateStr}.json`)

  writeFileSync(reportPath, generateMarkdownReport(result))
  writeFileSync(jsonPath, JSON.stringify(result, null, 2))

  console.log('')
  console.log('Reports saved:')
  console.log(`  ${reportPath}`)
  console.log(`  ${jsonPath}`)

  // Exit with appropriate code
  if (result.verdict === 'NOT_VALIDATED') {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('A/B test failed:', err)
  process.exit(1)
})
