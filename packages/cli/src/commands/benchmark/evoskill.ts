// EvoSkill benchmark CLI entry point — SMI-3275
// Docker-first: docker exec skillsmith-dev-1 npm run benchmark:evoskill -- --benchmark officeqa

import { Command } from 'commander'
import chalk from 'chalk'
import * as fs from 'fs'
import * as path from 'path'
import {
  runHarness,
  createBaselineSelector,
  createCuratedSelector,
  createSearchSelector,
  createRecommendSelector,
  getScorerForBenchmark,
  generateMarkdownReport,
  generateJsonReport,
  CONDITIONS,
  EVOSKILL_DEFAULTS,
  type ConditionConfig,
  type HarnessConfig,
  type AgentClient,
  type LlmJudgeClient,
  type HarnessProgressEvent,
  type SkillSelectorFn,
} from '@skillsmith/core'

type BenchmarkName = 'officeqa' | 'sealqa' | 'browsecomp'

interface EvoskillOptions {
  benchmark: string
  condition: string
  seeds: string
  sample: string
  output: string
  datasetDir: string
  dryRun: boolean
  model: string
}

export function createEvoskillBenchmarkCommand(): Command {
  return new Command('evoskill')
    .description('Run EvoSkill benchmark evaluation harness')
    .option('-b, --benchmark <name>', 'Benchmark: officeqa, sealqa, browsecomp, all', 'all')
    .option('-c, --condition <ids>', 'Condition IDs: 1-9, all (comma-separated)', 'all')
    .option('-s, --seeds <n>', 'Number of seeds', '3')
    .option('--sample <fraction>', 'Sample fraction of test set (0-1)', '1.0')
    .option('-o, --output <dir>', 'Output directory', '/app/results/evoskill/')
    .option('-d, --dataset-dir <dir>', 'Base directory for dataset files', '/app/data/')
    .option('--dry-run', 'Validate config without API calls', false)
    .option('-m, --model <id>', 'Agent model ID', EVOSKILL_DEFAULTS.AGENT_MODEL_ID)
    .action(async (opts: EvoskillOptions) => {
      try {
        await runEvoskillBenchmark(opts)
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : error)
        process.exit(1)
      }
    })
}

async function runEvoskillBenchmark(opts: EvoskillOptions): Promise<void> {
  const benchmarks = parseBenchmarks(opts.benchmark)
  const conditionIds = parseConditions(opts.condition)
  const seeds = parseSeeds(opts.seeds)
  const sampleFraction = parseFloat(opts.sample)
  const modelId = opts.model

  console.log(chalk.bold('EvoSkill Benchmark Harness'))
  console.log(`  Benchmarks: ${benchmarks.join(', ')}`)
  console.log(`  Conditions: ${conditionIds.join(', ')}`)
  console.log(`  Seeds: ${seeds.join(', ')}`)
  console.log(`  Sample: ${(sampleFraction * 100).toFixed(0)}%`)
  console.log(`  Model: ${modelId}`)
  console.log(`  Dry run: ${opts.dryRun}`)
  console.log()

  // Build condition configs
  const conditions = buildConditions(conditionIds, modelId, seeds)

  // Build harness config
  const config: HarnessConfig = {
    benchmarks,
    conditions,
    seeds,
    sampleFraction,
    datasetDir: opts.datasetDir,
    outputDir: opts.output,
    dryRun: opts.dryRun,
  }

  // Create dependencies (agent client placeholder — real implementation uses Anthropic SDK)
  const agentClient = createAgentClient()
  const judgeClient = createJudgeClient()

  const result = await runHarness(config, {
    agentClient,
    getScorer: (benchmark) => getScorerForBenchmark(
      benchmark === 'officeqa' ? 'officeqa' : benchmark === 'browsecomp' ? 'browsecomp' : 'sealqa',
      EVOSKILL_DEFAULTS.JUDGE_MODEL_ID,
      benchmark !== 'officeqa' ? judgeClient : undefined
    ),
    readFile: async (filePath: string) => fs.readFileSync(filePath, 'utf-8'),
  }, (event: HarnessProgressEvent) => {
    switch (event.type) {
      case 'seed_start':
        console.log(chalk.cyan(`[seed=${event.seed}] Starting ${event.benchmark}...`))
        break
      case 'condition_complete':
        if (event.result) {
          const acc = (event.result.accuracy * 100).toFixed(1)
          console.log(
            chalk.green(`  [${event.condition}] accuracy=${acc}% cost=$${event.result.costDollars.toFixed(2)}`)
          )
        }
        break
      case 'harness_complete':
        console.log(chalk.bold('\nHarness complete.'))
        break
    }
  })

  // Write outputs
  fs.mkdirSync(opts.output, { recursive: true })

  const mdReport = generateMarkdownReport(result)
  const mdPath = path.join(opts.output, 'report.md')
  fs.writeFileSync(mdPath, mdReport)
  console.log(`Markdown report: ${mdPath}`)

  const jsonReport = generateJsonReport(result)
  const jsonPath = path.join(opts.output, 'results.json')
  fs.writeFileSync(jsonPath, jsonReport)
  console.log(`JSON results: ${jsonPath}`)

  console.log(`\nTotal wall clock: ${(result.wallClockMs / 1000).toFixed(1)}s`)
}

function parseBenchmarks(input: string): BenchmarkName[] {
  if (input === 'all') return ['officeqa', 'sealqa', 'browsecomp']
  const names = input.split(',').map((s) => s.trim()) as BenchmarkName[]
  for (const name of names) {
    if (!['officeqa', 'sealqa', 'browsecomp'].includes(name)) {
      throw new Error(`Unknown benchmark: ${name}`)
    }
  }
  return names
}

function parseConditions(input: string): number[] {
  if (input === 'all') return [1, 2, 3, 4, 5, 6, 7, 8, 9]
  return input.split(',').map((s) => {
    const n = parseInt(s.trim(), 10)
    if (isNaN(n) || n < 1 || n > 9) throw new Error(`Invalid condition: ${s}`)
    return n
  })
}

function parseSeeds(input: string): number[] {
  const n = parseInt(input, 10)
  if (isNaN(n) || n < 1) throw new Error(`Invalid seeds: ${input}`)
  return Array.from({ length: n }, (_, i) => EVOSKILL_DEFAULTS.SEED + i)
}

function buildConditions(ids: number[], modelId: string, seeds: number[]): ConditionConfig[] {
  const configs: ConditionConfig[] = []

  for (const id of ids) {
    const name = CONDITIONS[id as keyof typeof CONDITIONS]

    let selectorFn: SkillSelectorFn
    switch (id) {
      case 1: selectorFn = createBaselineSelector(); break
      case 3: selectorFn = createSearchSelector({ search: async () => [] }); break
      case 4: selectorFn = createRecommendSelector({ recommend: async () => [] }); break
      case 7:
        // Condition 7 (Skillsmith-Iterative) is Study B scope — skip in Study A runs
        console.log(chalk.yellow(`  Skipping condition 7 (${name}) — implemented in Study B`))
        continue
      case 9: selectorFn = createCuratedSelector([]); break
      case 2:
      case 5:
      case 6:
      case 8:
        throw new Error(
          `Condition ${id} (${name}) requires runtime dependencies not yet configured. ` +
          `Condition 2 needs --evolved-skill path, 5 needs TransformationService, ` +
          `6 needs SkillCreateRunner, 8 needs search client + evolve function.`
        )
      default:
        throw new Error(`Unknown condition ID: ${id}`)
    }

    for (const seed of seeds) {
      configs.push({
        name: `${name} (seed=${seed})`,
        skillSelector: selectorFn,
        modelId,
        seed,
      })
    }
  }

  return configs
}

/**
 * Agent client using Claude Code CLI (`claude -p --output-format json`).
 * Uses the Claude subscription — no API key needed.
 * The CLI is invoked with CLAUDECODE unset to allow nested execution.
 */
function createAgentClient(): AgentClient {
  return {
    async runTask(params) {
      return runClaudeCli({
        model: params.model,
        systemPrompt: params.systemPrompt,
        userMessage: params.userMessage,
        maxTokens: params.maxTokens,
        timeoutMs: params.timeoutMs,
      })
    },
  }
}

/**
 * LLM judge client using Claude Code CLI.
 * Uses the judge model (separate from the agent model) to score answers.
 */
function createJudgeClient(): LlmJudgeClient {
  return {
    async judge(params) {
      const prompt = [
        'You are a benchmark judge. Score whether the predicted answer matches the ground truth.',
        `Question: ${params.question}`,
        `Ground truth: ${params.groundTruth}`,
        `Predicted: ${params.predicted}`,
        '',
        'Respond with ONLY a number between 0.0 and 1.0:',
        '- 1.0 = correct or semantically equivalent',
        '- 0.5 = partially correct',
        '- 0.0 = incorrect',
      ].join('\n')

      const result = await runClaudeCli({
        model: params.model,
        systemPrompt: 'You are a precise benchmark scoring judge. Respond with only a number.',
        userMessage: prompt,
        maxTokens: 16,
        timeoutMs: 30_000,
      })

      const score = parseFloat(result.content.trim())
      if (isNaN(score)) return 0.0
      return Math.max(0, Math.min(1, score))
    },
  }
}

interface ClaudeCliResult {
  content: string
  inputTokens: number
  outputTokens: number
}

/**
 * Run Claude Code CLI in non-interactive mode.
 * Parses JSON output for structured response with token usage.
 */
async function runClaudeCli(params: {
  model: string
  systemPrompt: string
  userMessage: string
  maxTokens: number
  timeoutMs: number
}): Promise<ClaudeCliResult> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  const fullPrompt = `${params.systemPrompt}\n\n${params.userMessage}`

  // Map full model IDs to CLI aliases for convenience
  const modelAlias = params.model.includes('opus') ? 'opus'
    : params.model.includes('haiku') ? 'haiku'
    : 'sonnet'

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', modelAlias,
    '--max-turns', '1',
  ]

  const { stdout } = await execFileAsync('claude', args, {
    input: fullPrompt,
    timeout: params.timeoutMs,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      CLAUDECODE: '', // Unset to allow nested execution
    },
  })

  const parsed = JSON.parse(stdout)

  return {
    content: parsed.result ?? '',
    inputTokens: parsed.usage?.input_tokens ?? parsed.usage?.inputTokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? parsed.usage?.outputTokens ?? 0,
  }
}

export default createEvoskillBenchmarkCommand
