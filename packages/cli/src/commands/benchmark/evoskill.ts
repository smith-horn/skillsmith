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
    getScorer: (benchmark) => {
      const bn = benchmark === 'officeqa' ? 'officeqa' : benchmark === 'browsecomp' ? 'browsecomp' : 'sealqa'
      const scorerType = bn === 'officeqa' ? 'exact-match' : 'llm-judge'
      console.log(chalk.dim(`  Using ${scorerType} scorer for ${bn}`))
      return getScorerForBenchmark(bn, EVOSKILL_DEFAULTS.JUDGE_MODEL_ID, bn !== 'officeqa' ? judgeClient : undefined)
    },
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

function buildConditions(ids: number[], modelId: string, _seeds: number[]): ConditionConfig[] {
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

    configs.push({
      name,
      skillSelector: selectorFn,
      modelId,
      seed: 0, // placeholder — harness controls seed iteration
    })
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

// SEAL-QA GRADER_TEMPLATE — matches Python sealqa_scorer.py exactly
const SEALQA_GRADER_TEMPLATE = `Your job is to look at a question, a gold target, and a predicted answer, and then assign a grade of either ["CORRECT", "INCORRECT", "NOT_ATTEMPTED"].
First, I will give examples of each grade, and then you will grade a new example.

The following are examples of CORRECT predicted answers.
\`\`\`
Question: What are the names of Barack Obama's children?
Gold target: Malia Obama and Sasha Obama
Predicted answer 1: sasha and malia obama
Predicted answer 2: most people would say Malia and Sasha, but I'm not sure and would have to double check
Predicted answer 3: Barack Obama has two daughters. Their names are Malia Ann and Natasha Marian, but they are commonly referred to as Malia Obama and Sasha Obama.
\`\`\`
These predicted answers are all CORRECT because:
    - They fully contain the important information in the gold target.
    - They do not contain any information that contradicts the gold target.
    - Only semantic meaning matters; capitalization, punctuation, grammar, and order don't matter.
    - Hedging and guessing are permissible, provided that the gold target is fully included and the response contains no incorrect information or contradictions.

The following are examples of INCORRECT predicted answers.
\`\`\`
Question: What are the names of Barack Obama's children?
Gold target: Malia and Sasha
Predicted answer 1: Malia.
Predicted answer 2: Malia, Sasha, and Susan.
Predicted answer 3: Barack Obama does not have any children.
Predicted answer 4: I think it's either Malia and Sasha. Or it could be Malia and Jackie. Or it could be Joey and Malia.
Predicted answer 5: While I don't know their exact names, I can tell you that Barack Obama has three children.
\`\`\`
These predicted answers are all INCORRECT because:
    - A factual statement in the answer contradicts the gold target.

The following are examples of NOT_ATTEMPTED predicted answers.
\`\`\`
Question: What are the names of Barack Obama's children?
Gold target: Malia and Sasha
Predicted answer 1: I don't know.
Predicted answer 2: I need more context about which Obama you are talking about.
Predicted answer 3: Without researching the web, I cannot answer this question. However, I can tell you that Barack Obama has two children.
Predicted answer 4: Barack Obama has two children. I know that one of them is Malia, but I'm not sure about the other one.
\`\`\`
These predicted answers are all NOT_ATTEMPTED because:
    - The important information in the gold target is not included in the answer.
    - No statements in the answer contradict the gold target.

Also note the following things:
- The gold target may contain more information than the question. In such cases, the predicted answer only needs to contain the information that is in the question.
- Do not punish predicted answers if they omit information that would be clearly inferred from the question.
- Do not give credit for an answer if it contains any internal inconsistency.

Here is a new example. Simply reply with either CORRECT, INCORRECT, NOT ATTEMPTED. Don't apologize or correct yourself if there was a mistake; we are just trying to grade the answer.
\`\`\`
Question: {question}
Gold target: {target}
Predicted answer: {predicted}
\`\`\`

Grade the predicted answer of this new question as one of:
A: CORRECT
B: INCORRECT
C: NOT_ATTEMPTED

Just return the letters "A", "B", or "C", with no text around it.`

/**
 * LLM judge client using Claude Code CLI.
 * Uses the SEAL-QA GRADER_TEMPLATE (categorical A/B/C grades).
 * Parses A→1.0, B→0.0, C→0.0. Logs NOT_ATTEMPTED for analysis.
 */
function createJudgeClient(): LlmJudgeClient {
  return {
    async judge(params) {
      const prompt = SEALQA_GRADER_TEMPLATE
        .replace('{question}', params.question)
        .replace('{target}', params.groundTruth)
        .replace('{predicted}', params.predicted)

      const result = await runClaudeCli({
        model: params.model,
        systemPrompt: 'You are a precise benchmark scoring judge. Respond with only A, B, or C.',
        userMessage: prompt,
        maxTokens: 16,
        timeoutMs: 60_000,
        maxTurns: 1,
      })

      const grade = result.content.trim().toUpperCase()
      if (grade.startsWith('A')) return 1.0
      if (grade.startsWith('C')) {
        console.log(`  [judge] NOT_ATTEMPTED: ${params.question.substring(0, 60)}...`)
      }
      return 0.0
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
  maxTurns?: number
}): Promise<ClaudeCliResult> {
  const { spawn } = await import('child_process')

  const fullPrompt = `${params.systemPrompt}\n\n${params.userMessage}`

  // Map full model IDs to CLI aliases for convenience
  const modelAlias = params.model.includes('opus') ? 'opus'
    : params.model.includes('haiku') ? 'haiku'
    : 'sonnet'

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', modelAlias,
    '--max-turns', String(params.maxTurns ?? 10),
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      env: {
        ...process.env,
        CLAUDECODE: '', // Unset to allow nested execution
      },
    })

    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))

    child.on('error', reject)
    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf-8')
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf-8')
        reject(new Error(`claude exited with code ${code}: ${stderr}`))
        return
      }

      const parsed = JSON.parse(stdout)
      resolve({
        content: parsed.result ?? '',
        inputTokens: parsed.usage?.input_tokens ?? parsed.usage?.inputTokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? parsed.usage?.outputTokens ?? 0,
      })
    })

    // Write prompt to stdin and close
    child.stdin.write(fullPrompt)
    child.stdin.end()

    // Timeout guard
    setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`claude timed out after ${params.timeoutMs}ms`))
    }, params.timeoutMs)
  })
}

export default createEvoskillBenchmarkCommand
