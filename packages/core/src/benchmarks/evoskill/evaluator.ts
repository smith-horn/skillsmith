// EvoSkill evaluator — SMI-3272
// Scores predictions, aggregates results, computes IR metrics

import type { BenchmarkTask, EvoSkillBenchmarkResult, ScorerFn } from './types.js'
import type { TaskResult } from './agent-runner.js'
import { calculateCost } from './agent-runner.js'
import { ndcg, mrr, mapAtK } from './ir-metrics.js'

export interface EvaluatorConfig {
  scorer: ScorerFn
  condition: string
  benchmark: string
  split: string
  modelId: string
  /** Whether to compute IR metrics (for retrieval conditions 3-4) */
  computeIrMetrics?: boolean
  /** Ranked skill IDs for IR metrics (ordered by relevance) */
  rankedSkillIds?: string[]
  /** Relevant skill IDs (ground truth) for IR metrics */
  relevantSkillIds?: Set<string>
}

/**
 * Evaluate task results and produce an aggregate benchmark result.
 */
export async function evaluate(
  tasks: BenchmarkTask[],
  results: TaskResult[],
  config: EvaluatorConfig
): Promise<EvoSkillBenchmarkResult> {
  const { scorer, condition, benchmark, split, modelId, computeIrMetrics } = config

  // Build task map for lookup
  const taskMap = new Map(tasks.map((t) => [t.id, t]))

  let correctCount = 0
  let totalTokens = { inputTokens: 0, outputTokens: 0 }
  let totalDurationMs = 0

  for (const result of results) {
    const task = taskMap.get(result.taskId)
    if (!task) continue

    if (!result.error && result.predicted) {
      const score = await scorer(task.question, result.predicted, task.groundTruth)
      if (score >= 0.5) correctCount++
    }

    totalTokens.inputTokens += result.tokens.inputTokens
    totalTokens.outputTokens += result.tokens.outputTokens
    totalDurationMs += result.durationMs
  }

  const taskCount = results.length
  const accuracy = taskCount > 0 ? correctCount / taskCount : 0
  const costDollars = calculateCost(totalTokens, modelId)

  const evalResult: EvoSkillBenchmarkResult = {
    condition,
    benchmark,
    split,
    accuracy,
    taskCount,
    correctCount,
    costTokens: totalTokens.inputTokens + totalTokens.outputTokens,
    costDollars,
    wallClockMs: totalDurationMs,
  }

  // IR metrics for retrieval conditions
  if (computeIrMetrics && config.rankedSkillIds && config.relevantSkillIds) {
    const ranked = config.rankedSkillIds
    const relevant = config.relevantSkillIds
    evalResult.irMetrics = {
      ndcg5: ndcg(ranked, new Map([...relevant].map((id) => [id, 1])), 5),
      mrr: mrr(ranked, relevant),
      map5: mapAtK(ranked, relevant, 5),
    }
  }

  return evalResult
}

/**
 * Aggregate multiple seed runs into a single result with mean ± std.
 */
export function aggregateSeeds(
  results: EvoSkillBenchmarkResult[]
): EvoSkillBenchmarkResult {
  if (results.length === 0) {
    throw new Error('Cannot aggregate 0 results')
  }

  if (results.length === 1) {
    // Single seed: accuracyStd stays undefined
    return { ...results[0] }
  }

  const accuracies = results.map((r) => r.accuracy)
  const meanAccuracy = accuracies.reduce((a, b) => a + b, 0) / accuracies.length
  const variance =
    accuracies.reduce((sum, a) => sum + (a - meanAccuracy) ** 2, 0) / (accuracies.length - 1)
  const std = Math.sqrt(variance)

  const totalCostTokens = results.reduce((s, r) => s + r.costTokens, 0)
  const totalCostDollars = results.reduce((s, r) => s + r.costDollars, 0)
  const totalWallClock = results.reduce((s, r) => s + r.wallClockMs, 0)
  const totalTasks = results.reduce((s, r) => s + r.taskCount, 0)
  const totalCorrect = results.reduce((s, r) => s + r.correctCount, 0)

  // Average IR metrics across seeds if present
  let irMetrics: EvoSkillBenchmarkResult['irMetrics']
  const withIr = results.filter((r) => r.irMetrics)
  if (withIr.length > 0) {
    irMetrics = {
      ndcg5: withIr.reduce((s, r) => s + r.irMetrics!.ndcg5, 0) / withIr.length,
      mrr: withIr.reduce((s, r) => s + r.irMetrics!.mrr, 0) / withIr.length,
      map5: withIr.reduce((s, r) => s + r.irMetrics!.map5, 0) / withIr.length,
    }
  }

  return {
    condition: results[0].condition,
    benchmark: results[0].benchmark,
    split: results[0].split,
    accuracy: meanAccuracy,
    accuracyStd: std,
    taskCount: totalTasks,
    correctCount: totalCorrect,
    costTokens: totalCostTokens,
    costDollars: totalCostDollars,
    wallClockMs: totalWallClock,
    irMetrics,
  }
}
