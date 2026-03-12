// EvoSkill benchmark harness orchestrator — SMI-3273
// Coordinates dataset loading, skill selection, agent execution, and evaluation
// Parallelism: conditions concurrent per seed; seeds serial

import type { BenchmarkTask, ConditionConfig, EvoSkillBenchmarkResult, HarnessConfig } from './types.js'
import type { AgentClient, TaskResult } from './agent-runner.js'
import type { ScorerFn } from './types.js'
import * as pathModule from 'path'
import { loadDataset } from './dataset-loader.js'
import { runEvoSkillBatch } from './agent-runner.js'
import { evaluate, aggregateSeeds } from './evaluator.js'

/** Progress callback for harness execution */
export type HarnessProgressFn = (event: HarnessProgressEvent) => void

export interface HarnessProgressEvent {
  type: 'seed_start' | 'condition_start' | 'condition_complete' | 'seed_complete' | 'harness_complete'
  seed?: number
  condition?: string
  benchmark?: string
  result?: EvoSkillBenchmarkResult
  progress?: { completed: number; total: number }
}

/** Dependencies injected from CLI layer */
export interface HarnessDependencies {
  agentClient: AgentClient
  /** Scorer per benchmark — each benchmark may need a different scorer */
  getScorer: (benchmark: 'officeqa' | 'sealqa' | 'browsecomp') => ScorerFn
  /** Read file content from path */
  readFile: (path: string) => Promise<string>
}

export interface HarnessResult {
  results: EvoSkillBenchmarkResult[]
  aggregated: EvoSkillBenchmarkResult[]
  wallClockMs: number
}

/**
 * Run the full benchmark harness.
 * Seeds run serially; conditions within each seed run concurrently.
 */
export async function runHarness(
  config: HarnessConfig,
  deps: HarnessDependencies,
  onProgress?: HarnessProgressFn
): Promise<HarnessResult> {
  const harnessStart = Date.now()
  const allResults: EvoSkillBenchmarkResult[] = []

  for (const benchmark of config.benchmarks) {
    // Load raw dataset content once per benchmark
    const datasetPath = pathModule.join(config.datasetDir, getDatasetPath(benchmark))
    const datasetContent = await deps.readFile(datasetPath)

    for (const seed of config.seeds) {
      onProgress?.({ type: 'seed_start', seed, benchmark })

      // Re-split dataset with this seed for different train/val/test shuffle
      const dataset = loadDataset(datasetContent, benchmark, { seed })

      // Use test split (or sample fraction thereof)
      let testTasks = dataset.test
      if (config.sampleFraction < 1) {
        const sampleSize = Math.max(1, Math.round(testTasks.length * config.sampleFraction))
        testTasks = testTasks.slice(0, sampleSize)
      }

      // Run conditions concurrently within this seed
      const conditionPromises = config.conditions.map(async (condition) => {
        onProgress?.({ type: 'condition_start', seed, condition: condition.name, benchmark })

        if (config.dryRun) {
          return createDryRunResult(condition, benchmark, testTasks.length)
        }

        return runCondition(condition, benchmark, testTasks, seed, deps)
      })

      const seedResults = await Promise.all(conditionPromises)

      for (const result of seedResults) {
        allResults.push(result)
        onProgress?.({
          type: 'condition_complete',
          seed,
          condition: result.condition,
          benchmark,
          result,
        })
      }

      onProgress?.({ type: 'seed_complete', seed, benchmark })
    }
  }

  // Aggregate across seeds per (condition, benchmark) pair
  const aggregated = aggregateResults(allResults)

  onProgress?.({ type: 'harness_complete' })

  return {
    results: allResults,
    aggregated,
    wallClockMs: Date.now() - harnessStart,
  }
}

/** Run a single condition on a benchmark's test tasks */
async function runCondition(
  condition: ConditionConfig,
  benchmark: string,
  testTasks: BenchmarkTask[],
  seed: number,
  deps: HarnessDependencies
): Promise<EvoSkillBenchmarkResult> {
  // Select skills
  const skills = await condition.skillSelector(testTasks)

  // Run tasks through agent
  const taskResults: TaskResult[] = await runEvoSkillBatch(testTasks, {
    client: deps.agentClient,
    modelId: condition.modelId,
    skills,
  })

  // Evaluate with benchmark-specific scorer
  const scorer = deps.getScorer(benchmark as 'officeqa' | 'sealqa' | 'browsecomp')
  return evaluate(testTasks, taskResults, {
    scorer,
    condition: condition.name,
    benchmark,
    split: 'test',
    modelId: condition.modelId,
  })
}

/** Create a placeholder result for dry-run mode */
function createDryRunResult(
  condition: ConditionConfig,
  benchmark: string,
  taskCount: number
): EvoSkillBenchmarkResult {
  return {
    condition: condition.name,
    benchmark,
    split: 'test',
    accuracy: 0,
    taskCount,
    correctCount: 0,
    costTokens: 0,
    costDollars: 0,
    wallClockMs: 0,
  }
}

/** Aggregate results across seeds for each (condition, benchmark) pair */
function aggregateResults(results: EvoSkillBenchmarkResult[]): EvoSkillBenchmarkResult[] {
  const groups = new Map<string, EvoSkillBenchmarkResult[]>()

  for (const r of results) {
    const key = `${r.condition}:${r.benchmark}`
    const group = groups.get(key) ?? []
    group.push(r)
    groups.set(key, group)
  }

  return [...groups.values()].map(aggregateSeeds)
}

/** Dataset file paths (relative to data directory) */
function getDatasetPath(benchmark: 'officeqa' | 'sealqa' | 'browsecomp'): string {
  switch (benchmark) {
    case 'officeqa':
      return 'dabstep_data.csv'
    case 'sealqa':
      return 'seal-0.csv'
    case 'browsecomp':
      return 'browsecomp_data.json'
  }
}
