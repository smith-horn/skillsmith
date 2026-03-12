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
  createIterativeSelector,
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
      case 7: selectorFn = createIterativeSelector(); break
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

/** Placeholder agent client — replace with real Anthropic SDK calls */
function createAgentClient(): AgentClient {
  return {
    async runTask() {
      throw new Error(
        'AgentClient not configured. Set ANTHROPIC_API_KEY and provide a real implementation.'
      )
    },
  }
}

/** Placeholder judge client — replace with real Anthropic SDK calls */
function createJudgeClient(): LlmJudgeClient {
  return {
    async judge() {
      throw new Error(
        'LlmJudgeClient not configured. Set ANTHROPIC_API_KEY and provide a real implementation.'
      )
    },
  }
}

export default createEvoskillBenchmarkCommand
