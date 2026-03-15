// Tests for evaluator scorer error handling — SMI-3332
import { describe, it, expect } from 'vitest'
import { evaluate, aggregateSeeds } from './evaluator.js'
import type { BenchmarkTask } from './types.js'
import type { TaskResult } from './agent-runner.js'

function makeTasks(count: number): BenchmarkTask[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    question: `Question ${i + 1}`,
    groundTruth: `Answer ${i + 1}`,
    split: 'test' as const,
    benchmark: 'officeqa' as const,
  }))
}

function makeResults(tasks: BenchmarkTask[]): TaskResult[] {
  return tasks.map((t) => ({
    taskId: t.id,
    predicted: t.groundTruth,
    tokens: { inputTokens: 100, outputTokens: 50 },
    durationMs: 1000,
  }))
}

describe('evaluate — scorer error handling (SMI-3332)', () => {
  it('returns errorCount when scorer throws on all tasks', async () => {
    const tasks = makeTasks(3)
    const results = makeResults(tasks)
    const throwingScorer = () => {
      throw new Error('Judge crashed')
    }

    const result = await evaluate(tasks, results, {
      scorer: throwingScorer,
      condition: 'test',
      benchmark: 'officeqa',
      split: 'test',
      modelId: 'claude-sonnet-4-6',
    })

    expect(result.errorCount).toBe(3)
    expect(result.correctCount).toBe(0)
    expect(result.accuracy).toBe(0)
    expect(result.scorerErrors).toHaveLength(3)
    expect(result.scorerErrors![0].taskId).toBe('t1')
    expect(result.scorerErrors![0].message).toBe('Judge crashed')
  })

  it('returns partial accuracy when scorer throws on some tasks', async () => {
    const tasks = makeTasks(4)
    const results = makeResults(tasks)
    let callCount = 0
    const partialScorer = () => {
      callCount++
      if (callCount === 2) throw new Error('Intermittent failure')
      return 1.0 // correct
    }

    const result = await evaluate(tasks, results, {
      scorer: partialScorer,
      condition: 'test',
      benchmark: 'officeqa',
      split: 'test',
      modelId: 'claude-sonnet-4-6',
    })

    expect(result.errorCount).toBe(1)
    expect(result.correctCount).toBe(3)
    expect(result.accuracy).toBe(3 / 4)
    expect(result.scorerErrors).toHaveLength(1)
    expect(result.scorerErrors![0].taskId).toBe('t2')
  })

  it('returns no scorerErrors when scorer succeeds on all tasks', async () => {
    const tasks = makeTasks(2)
    const results = makeResults(tasks)

    const result = await evaluate(tasks, results, {
      scorer: () => 1.0,
      condition: 'test',
      benchmark: 'officeqa',
      split: 'test',
      modelId: 'claude-sonnet-4-6',
    })

    expect(result.errorCount).toBe(0)
    expect(result.correctCount).toBe(2)
    expect(result.scorerErrors).toBeUndefined()
  })

  it('skips scoring for tasks with errors (no double-counting)', async () => {
    const tasks = makeTasks(2)
    const results: TaskResult[] = [
      {
        taskId: 't1',
        predicted: 'ans',
        tokens: { inputTokens: 100, outputTokens: 50 },
        durationMs: 500,
      },
      {
        taskId: 't2',
        predicted: '',
        tokens: { inputTokens: 100, outputTokens: 50 },
        durationMs: 500,
        error: 'timeout',
      },
    ]

    let scorerCalls = 0
    const result = await evaluate(tasks, results, {
      scorer: () => {
        scorerCalls++
        return 1.0
      },
      condition: 'test',
      benchmark: 'officeqa',
      split: 'test',
      modelId: 'claude-sonnet-4-6',
    })

    // Scorer should only be called for t1 (t2 has error + empty predicted)
    expect(scorerCalls).toBe(1)
    expect(result.errorCount).toBe(0)
  })
})

describe('aggregateSeeds — errorCount aggregation', () => {
  it('sums errorCount across seeds', () => {
    const results = [
      {
        condition: 'c1',
        benchmark: 'officeqa',
        split: 'test',
        accuracy: 0.5,
        taskCount: 10,
        correctCount: 5,
        errorCount: 2,
        costTokens: 100,
        costDollars: 0.01,
        wallClockMs: 1000,
      },
      {
        condition: 'c1',
        benchmark: 'officeqa',
        split: 'test',
        accuracy: 0.6,
        taskCount: 10,
        correctCount: 6,
        errorCount: 1,
        costTokens: 100,
        costDollars: 0.01,
        wallClockMs: 1000,
      },
    ]

    const agg = aggregateSeeds(results)
    expect(agg.errorCount).toBe(3)
  })

  it('omits errorCount when all seeds have zero errors', () => {
    const results = [
      {
        condition: 'c1',
        benchmark: 'officeqa',
        split: 'test',
        accuracy: 0.5,
        taskCount: 10,
        correctCount: 5,
        costTokens: 100,
        costDollars: 0.01,
        wallClockMs: 1000,
      },
      {
        condition: 'c1',
        benchmark: 'officeqa',
        split: 'test',
        accuracy: 0.6,
        taskCount: 10,
        correctCount: 6,
        costTokens: 100,
        costDollars: 0.01,
        wallClockMs: 1000,
      },
    ]

    const agg = aggregateSeeds(results)
    expect(agg.errorCount).toBeUndefined()
  })
})
