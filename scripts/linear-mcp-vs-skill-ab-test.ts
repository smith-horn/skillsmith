#!/usr/bin/env npx tsx
/**
 * Linear MCP vs Skill A/B Test
 *
 * Compares token usage, latency, and error rates between:
 * 1. Linear MCP Server tools (mcp__linear__*)
 * 2. Linear Skill (/linear with Linear-specialist agent)
 *
 * Usage:
 *   npx tsx scripts/linear-mcp-vs-skill-ab-test.ts --test-case TC1
 *   npx tsx scripts/linear-mcp-vs-skill-ab-test.ts --test-case TC8 --iterations 10
 *   npx tsx scripts/linear-mcp-vs-skill-ab-test.ts --dry-run
 */

import { spawnSync, execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { platform, release } from 'node:os'
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
  toolCalls: number
  errors: number
  retries: number
  userIntervention: boolean
  error?: string
  rawOutput?: string
  linearIssueId?: string
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
}

interface TestCaseResult {
  metadata: {
    experimentId: string
    timestamp: string
    claudeVersion: string
    claudeModel: string
    nodeVersion: string
    platform: string
    osRelease: string
    testCase: string
    iterations: number
    warmupIterations: number
    gitCommit: string
    linearTeam: string
  }
  mcp: {
    raw: InvocationResult[]
    stats: StatisticalSummary
  }
  skill: {
    raw: InvocationResult[]
    stats: StatisticalSummary
  }
  comparison: {
    tokenReductionPercent: number
    latencyReductionPercent: number
    effectSize: number
    pValue: number | null
    verdict: 'MCP_BETTER' | 'SKILL_BETTER' | 'NO_DIFFERENCE' | 'INSUFFICIENT_DATA'
  }
}

interface TestCase {
  id: string
  name: string
  mcpPrompt: (ts: string) => string
  skillPrompt: (ts: string) => string
}

interface ABTestOptions {
  testCase: string
  iterations: number
  warmupIterations: number
  model: string
  team: string
  dryRun: boolean
  verbose: boolean
}

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

const TEST_CASES: TestCase[] = [
  {
    id: 'TC1',
    name: 'Single Issue Create',
    mcpPrompt: (ts) =>
      `Using ONLY the mcp__linear__create_issue tool (NOT the /linear skill), create a new issue titled "[AB-TEST] TC1 - mcp-${ts}" with description "Test issue for MCP vs Skill A/B experiment. Timestamp: mcp-${ts}". Team: Skillsmith. Do NOT use any skill or Task tool.`,
    skillPrompt: (ts) =>
      `/linear Create a new issue titled "[AB-TEST] TC1 - skill-${ts}" with description "Test issue for MCP vs Skill A/B experiment. Timestamp: skill-${ts}". Team: Skillsmith.`,
  },
  {
    id: 'TC2',
    name: 'Issue with Labels',
    mcpPrompt: (ts) =>
      `Using ONLY mcp__linear__* tools (NOT the /linear skill), first list available labels for team Skillsmith, then create a new issue titled "[AB-TEST] TC2 - mcp-${ts}" with the "bug" label if it exists. Team: Skillsmith.`,
    skillPrompt: (ts) =>
      `/linear Create a new issue titled "[AB-TEST] TC2 - skill-${ts}" with the "bug" label. Team: Skillsmith.`,
  },
  {
    id: 'TC3',
    name: 'Issue with Relations',
    mcpPrompt: (ts) =>
      `Using ONLY mcp__linear__* tools (NOT the /linear skill), create two issues: "[AB-TEST] TC3-A - mcp-${ts}" and "[AB-TEST] TC3-B - mcp-${ts}". Then update TC3-B to be blocked by TC3-A. Team: Skillsmith.`,
    skillPrompt: (ts) =>
      `/linear Create two issues: "[AB-TEST] TC3-A - skill-${ts}" and "[AB-TEST] TC3-B - skill-${ts}". Make TC3-B blocked by TC3-A. Team: Skillsmith.`,
  },
  {
    id: 'TC4',
    name: 'Bulk Create (3)',
    mcpPrompt: (ts) =>
      `Using ONLY mcp__linear__create_issue tool (NOT the /linear skill), create 3 issues: "[AB-TEST] TC4-1 - mcp-${ts}", "[AB-TEST] TC4-2 - mcp-${ts}", "[AB-TEST] TC4-3 - mcp-${ts}". Team: Skillsmith.`,
    skillPrompt: (ts) =>
      `/linear Create 3 issues: "[AB-TEST] TC4-1 - skill-${ts}", "[AB-TEST] TC4-2 - skill-${ts}", "[AB-TEST] TC4-3 - skill-${ts}". Team: Skillsmith.`,
  },
  {
    id: 'TC5',
    name: 'Search and Update',
    mcpPrompt: (ts) =>
      `Using ONLY mcp__linear__* tools (NOT the /linear skill), search for all issues with "[AB-TEST]" in the title in team Skillsmith, then mark the 3 oldest ones as "Done". (Request: ${ts})`,
    skillPrompt: (ts) =>
      `/linear Find all issues with "[AB-TEST]" in the title in team Skillsmith and mark the 3 oldest ones as "Done". (Request: ${ts})`,
  },
  {
    id: 'TC6',
    name: 'Get Issue Details',
    mcpPrompt: (ts) =>
      `Using ONLY the mcp__linear__get_issue tool (NOT the /linear skill), get the details of issue SMI-1950 including all attachments and relations. (Request: ${ts})`,
    skillPrompt: (ts) =>
      `/linear Get full details of issue SMI-1950 including attachments and relations. (Request: ${ts})`,
  },
  {
    id: 'TC7',
    name: 'Add Comment',
    mcpPrompt: (ts) =>
      `Using ONLY the mcp__linear__create_comment tool (NOT the /linear skill), add a comment "A/B test comment from MCP at ${ts}" to issue SMI-1950.`,
    skillPrompt: (ts) =>
      `/linear Add a comment "A/B test comment from Skill at ${ts}" to issue SMI-1950.`,
  },
  {
    id: 'TC8',
    name: 'Search and Update Oldest',
    mcpPrompt: (ts) =>
      `Using ONLY mcp__linear__* tools (NOT the /linear skill), find all issues with "[AB-TEST]" in the title in team Skillsmith, identify the oldest one by createdAt, and mark it as "Done". (Request: ${ts})`,
    skillPrompt: (ts) =>
      `/linear Find the oldest issue with "[AB-TEST]" in the title in team Skillsmith and mark it as "Done". (Request: ${ts})`,
  },
]

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

function calculate95CI(data: number[]): { lower: number; upper: number } {
  if (data.length < 2) return { lower: 0, upper: 0 }
  const mean = calculateMean(data)
  const stdErr = calculateStdDev(data) / Math.sqrt(data.length)
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

function mannWhitneyU(group1: number[], group2: number[]): number | null {
  if (group1.length < 10 || group2.length < 10) return null

  const n1 = group1.length
  const n2 = group2.length
  const combined = [
    ...group1.map((v) => ({ value: v, group: 1 })),
    ...group2.map((v) => ({ value: v, group: 2 })),
  ].sort((a, b) => a.value - b.value)

  let rank = 1
  for (const item of combined) {
    ;(item as { rank: number }).rank = rank++
  }

  const r1 = combined
    .filter((x) => x.group === 1)
    .reduce((sum, x) => sum + (x as { rank: number }).rank, 0)

  const u1 = n1 * n2 + (n1 * (n1 + 1)) / 2 - r1
  const u = Math.min(u1, n1 * n2 - u1)

  const meanU = (n1 * n2) / 2
  const stdU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)
  const z = (u - meanU) / stdU

  const pValue = 2 * (1 - normalCDF(Math.abs(z)))
  return pValue
}

function normalCDF(z: number): number {
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
  const ci = calculate95CI(data)
  return {
    n: data.length,
    mean: calculateMean(data),
    median: calculateMedian(data),
    stdDev: calculateStdDev(data),
    min: data.length > 0 ? Math.min(...data) : 0,
    max: data.length > 0 ? Math.max(...data) : 0,
    ci95Lower: ci.lower,
    ci95Upper: ci.upper,
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function log(message: string, verbose: boolean): void {
  if (verbose) {
    console.log(message)
  }
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
// Claude Invocation
// ============================================================================

function invokeClaudeWithPrompt(
  prompt: string,
  model: string,
  timeoutMs = 180000
): InvocationResult {
  const sessionId = randomUUID()
  const startTime = Date.now()

  try {
    const args = [
      '--print',
      '--output-format',
      'json',
      '--session-id',
      sessionId,
      '--model',
      model,
      '--dangerously-skip-permissions',
      prompt,
    ]

    const result = spawnSync('claude', args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: PROJECT_ROOT,
      maxBuffer: 10 * 1024 * 1024,
    })

    const durationMs = Date.now() - startTime

    if (result.error) {
      return {
        success: false,
        sessionId,
        durationMs,
        usage: createEmptyUsage(),
        toolCalls: 0,
        errors: 1,
        retries: 0,
        userIntervention: false,
        error: result.error.message,
      }
    }

    const output = result.stdout || ''
    const parsed = parseClaudeOutput(output)

    return {
      success: result.status === 0,
      sessionId,
      durationMs,
      usage: parsed.usage,
      toolCalls: parsed.toolCalls,
      errors: result.status !== 0 ? 1 : 0,
      retries: 0,
      userIntervention: false,
      error: result.status !== 0 ? result.stderr || `Exit code: ${result.status}` : undefined,
      rawOutput:
        output.length > 10000
          ? output.slice(0, 2000) + '...[truncated]...' + output.slice(-5000)
          : output,
      linearIssueId: parsed.linearIssueId,
    }
  } catch (err) {
    return {
      success: false,
      sessionId,
      durationMs: Date.now() - startTime,
      usage: createEmptyUsage(),
      toolCalls: 0,
      errors: 1,
      retries: 0,
      userIntervention: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function createEmptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  }
}

function parseClaudeOutput(output: string): {
  usage: TokenUsage
  toolCalls: number
  linearIssueId?: string
} {
  let usage = createEmptyUsage()
  let toolCalls = 0
  let linearIssueId: string | undefined

  try {
    // First, try to parse the entire output as a JSON array (Claude CLI format)
    const parsed = JSON.parse(output)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item.type === 'result' && item.usage) {
          usage = {
            inputTokens: item.usage.input_tokens || 0,
            outputTokens: item.usage.output_tokens || 0,
            cacheCreationTokens: item.usage.cache_creation_input_tokens || 0,
            cacheReadTokens: item.usage.cache_read_input_tokens || 0,
            totalTokens: (item.usage.input_tokens || 0) + (item.usage.output_tokens || 0),
            costUsd: item.total_cost_usd || 0,
          }
        }
        if (item.type === 'tool_use') {
          toolCalls++
        }
      }

      // Extract Linear issue ID from output
      const issueMatch = output.match(/SMI-\d+/)
      if (issueMatch) {
        linearIssueId = issueMatch[0]
      }
    }
  } catch {
    // Fallback: try line-by-line parsing (for NDJSON format)
    const lines = output.split('\n').filter((l) => l.trim())
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'result' && obj.usage) {
          usage = {
            inputTokens: obj.usage.input_tokens || 0,
            outputTokens: obj.usage.output_tokens || 0,
            cacheCreationTokens: obj.usage.cache_creation_input_tokens || 0,
            cacheReadTokens: obj.usage.cache_read_input_tokens || 0,
            totalTokens: (obj.usage.input_tokens || 0) + (obj.usage.output_tokens || 0),
            costUsd: obj.total_cost_usd || 0,
          }
        }
        if (obj.type === 'tool_use') {
          toolCalls++
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  return { usage, toolCalls, linearIssueId }
}

// ============================================================================
// A/B Test Runner
// ============================================================================

async function runABTest(options: ABTestOptions): Promise<TestCaseResult | null> {
  const {
    testCase: testCaseId,
    iterations,
    warmupIterations,
    model,
    team,
    dryRun,
    verbose,
  } = options

  const testCase = TEST_CASES.find((tc) => tc.id === testCaseId)
  if (!testCase) {
    console.error(`Unknown test case: ${testCaseId}`)
    console.error(`Available: ${TEST_CASES.map((tc) => tc.id).join(', ')}`)
    return null
  }

  const timestamp = Date.now().toString()

  log(`\nTest Case: ${testCase.id} - ${testCase.name}`, verbose)
  log(`Team: ${team}`, verbose)
  log(`Iterations: ${iterations}`, verbose)

  if (dryRun) {
    console.log('\n--- DRY RUN ---')
    console.log('MCP Prompt:', testCase.mcpPrompt(timestamp))
    console.log('\nSkill Prompt:', testCase.skillPrompt(timestamp))
    return null
  }

  const metadata = {
    experimentId: randomUUID(),
    timestamp: new Date().toISOString(),
    claudeVersion: getClaudeVersion(),
    claudeModel: model,
    nodeVersion: process.version,
    platform: platform(),
    osRelease: release(),
    testCase: testCaseId,
    iterations,
    warmupIterations,
    gitCommit: getGitCommit(),
    linearTeam: team,
  }

  // Warmup
  if (warmupIterations > 0) {
    log(`\nRunning ${warmupIterations} warmup iterations...`, verbose)
    for (let i = 0; i < warmupIterations; i++) {
      const warmupTs = `warmup-${timestamp}`
      invokeClaudeWithPrompt(testCase.mcpPrompt(warmupTs), model)
      invokeClaudeWithPrompt(testCase.skillPrompt(warmupTs), model)
    }
  }

  // MCP tests
  log(`\nRunning ${iterations} MCP iterations...`, verbose)
  const mcpResults: InvocationResult[] = []
  for (let i = 0; i < iterations; i++) {
    if (verbose) process.stdout.write(`  MCP ${i + 1}/${iterations}\r`)
    const ts = `mcp-${timestamp}-${i}`
    const result = invokeClaudeWithPrompt(testCase.mcpPrompt(ts), model)
    mcpResults.push(result)
  }
  if (verbose) console.log()

  // Skill tests
  log(`Running ${iterations} Skill iterations...`, verbose)
  const skillResults: InvocationResult[] = []
  for (let i = 0; i < iterations; i++) {
    if (verbose) process.stdout.write(`  Skill ${i + 1}/${iterations}\r`)
    const ts = `skill-${timestamp}-${i}`
    const result = invokeClaudeWithPrompt(testCase.skillPrompt(ts), model)
    skillResults.push(result)
  }
  if (verbose) console.log()

  // Calculate statistics
  const mcpTokens = mcpResults.filter((r) => r.success).map((r) => r.usage.totalTokens)
  const skillTokens = skillResults.filter((r) => r.success).map((r) => r.usage.totalTokens)
  const mcpDurations = mcpResults.filter((r) => r.success).map((r) => r.durationMs)
  const skillDurations = skillResults.filter((r) => r.success).map((r) => r.durationMs)

  const mcpStats = summarizeStats(mcpTokens)
  const skillStats = summarizeStats(skillTokens)

  // Comparison
  const tokenReduction =
    mcpStats.mean > 0 ? ((mcpStats.mean - skillStats.mean) / mcpStats.mean) * 100 : 0

  const latencyReduction =
    calculateMean(mcpDurations) > 0
      ? ((calculateMean(mcpDurations) - calculateMean(skillDurations)) /
          calculateMean(mcpDurations)) *
        100
      : 0

  const effectSize = calculateCohenD(mcpTokens, skillTokens)
  const pValue = mannWhitneyU(mcpTokens, skillTokens)

  let verdict: TestCaseResult['comparison']['verdict']
  if (mcpTokens.length < 5 || skillTokens.length < 5) {
    verdict = 'INSUFFICIENT_DATA'
  } else if (pValue !== null && pValue < 0.05) {
    verdict = tokenReduction > 0 ? 'SKILL_BETTER' : 'MCP_BETTER'
  } else {
    verdict = 'NO_DIFFERENCE'
  }

  return {
    metadata,
    mcp: { raw: mcpResults, stats: mcpStats },
    skill: { raw: skillResults, stats: skillStats },
    comparison: {
      tokenReductionPercent: Math.round(tokenReduction * 10) / 10,
      latencyReductionPercent: Math.round(latencyReduction * 10) / 10,
      effectSize: Math.round(effectSize * 100) / 100,
      pValue,
      verdict,
    },
  }
}

// ============================================================================
// Report Generation
// ============================================================================

function generateMarkdownReport(result: TestCaseResult): string {
  const lines: string[] = []

  lines.push('# Linear MCP vs Skill A/B Test Report')
  lines.push('')
  lines.push(`**Test Case:** ${result.metadata.testCase}`)
  lines.push(`**Experiment ID:** \`${result.metadata.experimentId}\``)
  lines.push(`**Date:** ${result.metadata.timestamp}`)
  lines.push(`**Team:** ${result.metadata.linearTeam}`)
  lines.push(`**Model:** ${result.metadata.claudeModel}`)
  lines.push('')

  const verdictEmoji = {
    MCP_BETTER: '🔵 MCP Better',
    SKILL_BETTER: '🟢 Skill Better',
    NO_DIFFERENCE: '⚪ No Significant Difference',
    INSUFFICIENT_DATA: '❓ Insufficient Data',
  }[result.comparison.verdict]

  lines.push(`## Verdict: ${verdictEmoji}`)
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push('| Metric | MCP | Skill | Difference |')
  lines.push('|--------|-----|-------|------------|')
  lines.push(
    `| Mean Tokens | ${Math.round(result.mcp.stats.mean)} | ${Math.round(result.skill.stats.mean)} | ${result.comparison.tokenReductionPercent}% |`
  )
  lines.push(
    `| Median Tokens | ${Math.round(result.mcp.stats.median)} | ${Math.round(result.skill.stats.median)} | - |`
  )
  lines.push(
    `| Std Dev | ${Math.round(result.mcp.stats.stdDev)} | ${Math.round(result.skill.stats.stdDev)} | - |`
  )
  lines.push('')

  lines.push('## Statistical Analysis')
  lines.push('')
  lines.push(
    `- **Cohen's d:** ${result.comparison.effectSize} (${interpretCohenD(result.comparison.effectSize)})`
  )
  if (result.comparison.pValue !== null) {
    lines.push(
      `- **Mann-Whitney U p-value:** ${result.comparison.pValue.toFixed(4)} (${result.comparison.pValue < 0.05 ? 'significant' : 'not significant'})`
    )
  }
  lines.push('')

  lines.push('---')
  lines.push('*Generated by Linear MCP vs Skill A/B Test*')

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
    testCase: 'TC1',
    iterations: 10,
    warmupIterations: 1,
    model: 'sonnet',
    team: 'Skillsmith',
    dryRun: false,
    verbose: true,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--test-case':
      case '-t':
        options.testCase = args[++i]
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
      case '--team':
        options.team = args[++i]
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--quiet':
      case '-q':
        options.verbose = false
        break
      case '--help':
      case '-h':
        console.log(`
Linear MCP vs Skill A/B Test

Compares token usage between MCP tools and Skill for Linear operations.

Usage:
  npx tsx scripts/linear-mcp-vs-skill-ab-test.ts [options]

Options:
  --test-case, -t <id>    Test case ID (default: TC1)
  --iterations, -n <n>    Number of iterations (default: 10)
  --warmup, -w <n>        Warmup iterations (default: 1)
  --model, -m <model>     Claude model (default: sonnet)
  --team <name>           Linear team name (default: Skillsmith)
  --dry-run               Show prompts without running
  --quiet, -q             Suppress verbose output
  --help, -h              Show this help

Test Cases:
  TC1 - Single Issue Create
  TC2 - Issue with Labels
  TC3 - Issue with Relations
  TC4 - Bulk Create (3)
  TC5 - Search and Update
  TC6 - Get Issue Details
  TC7 - Add Comment
  TC8 - Search and Update Oldest
`)
        process.exit(0)
    }
  }

  return options
}

async function main(): Promise<void> {
  const options = parseArgs()

  console.log('╔═══════════════════════════════════════════════════════════════╗')
  console.log('║          Linear MCP vs Skill A/B Test                         ║')
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log(`║  Test Case: ${options.testCase.padEnd(49)} ║`)
  console.log(`║  Team: ${options.team.padEnd(54)} ║`)
  console.log(`║  Iterations: ${String(options.iterations).padEnd(48)} ║`)
  console.log('╚═══════════════════════════════════════════════════════════════╝')

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
  const resultsDir = join(PROJECT_ROOT, 'docs/research/linear-mcp-vs-skill-results')
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true })
  }

  const dateStr = new Date().toISOString().split('T')[0]
  const jsonPath = join(resultsDir, `ab-test-mcp-vs-skill-${dateStr}.json`)
  const mdPath = join(resultsDir, `ab-test-mcp-vs-skill-${dateStr}.md`)

  // Append to existing results or create new
  let existingResults: TestCaseResult[] = []
  if (existsSync(jsonPath)) {
    try {
      existingResults = JSON.parse(readFileSync(jsonPath, 'utf-8'))
    } catch {
      // Start fresh if file is corrupted
    }
  }
  existingResults.push(result)

  writeFileSync(jsonPath, JSON.stringify(existingResults, null, 2))
  writeFileSync(mdPath, generateMarkdownReport(result))

  console.log('')
  console.log('Reports saved:')
  console.log(`  ${jsonPath}`)
  console.log(`  ${mdPath}`)
}

main().catch((err) => {
  console.error('A/B test failed:', err)
  process.exit(1)
})
