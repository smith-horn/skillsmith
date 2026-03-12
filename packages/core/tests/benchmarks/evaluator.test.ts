import { describe, it, expect } from 'vitest'
import { evaluate, aggregateSeeds } from '../../src/benchmarks/evoskill/evaluator.js'
import type { BenchmarkTask, EvoSkillBenchmarkResult } from '../../src/benchmarks/evoskill/types.js'
import type { TaskResult } from '../../src/benchmarks/evoskill/agent-runner.js'

const makeTasks = (n: number): BenchmarkTask[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `test-${i + 1}`,
    question: `Question ${i + 1}`,
    groundTruth: `Answer ${i + 1}`,
    split: 'test' as const,
    benchmark: 'officeqa' as const,
  }))

const makeResults = (tasks: BenchmarkTask[], correctIds: Set<string>): TaskResult[] =>
  tasks.map((t) => ({
    taskId: t.id,
    predicted: correctIds.has(t.id) ? t.groundTruth : 'wrong',
    tokens: { inputTokens: 100, outputTokens: 50 },
    durationMs: 500,
  }))

describe('evaluate', () => {
  it('computes accuracy correctly', async () => {
    const tasks = makeTasks(10)
    const correct = new Set(['test-1', 'test-2', 'test-3'])
    const results = makeResults(tasks, correct)

    const result = await evaluate(tasks, results, {
      scorer: (_q, predicted, groundTruth) => (predicted === groundTruth ? 1.0 : 0.0),
      condition: 'baseline',
      benchmark: 'officeqa',
      split: 'test',
      modelId: 'claude-sonnet-4-6',
    })

    expect(result.accuracy).toBeCloseTo(0.3)
    expect(result.correctCount).toBe(3)
    expect(result.taskCount).toBe(10)
  })

  it('handles all correct', async () => {
    const tasks = makeTasks(5)
    const allCorrect = new Set(tasks.map((t) => t.id))
    const results = makeResults(tasks, allCorrect)

    const result = await evaluate(tasks, results, {
      scorer: (_q, predicted, groundTruth) => (predicted === groundTruth ? 1.0 : 0.0),
      condition: 'test',
      benchmark: 'officeqa',
      split: 'test',
      modelId: 'claude-sonnet-4-6',
    })

    expect(result.accuracy).toBe(1.0)
    expect(result.correctCount).toBe(5)
  })

  it('handles all wrong', async () => {
    const tasks = makeTasks(5)
    const results = makeResults(tasks, new Set())

    const result = await evaluate(tasks, results, {
      scorer: () => 0.0,
      condition: 'test',
      benchmark: 'officeqa',
      split: 'test',
      modelId: 'claude-sonnet-4-6',
    })

    expect(result.accuracy).toBe(0)
    expect(result.correctCount).toBe(0)
  })

  it('sums token costs', async () => {
    const tasks = makeTasks(3)
    const results = makeResults(tasks, new Set())

    const result = await evaluate(tasks, results, {
      scorer: () => 0.0,
      condition: 'test',
      benchmark: 'officeqa',
      split: 'test',
      modelId: 'claude-sonnet-4-6',
    })

    // 3 tasks × (100 input + 50 output) = 450 total tokens
    expect(result.costTokens).toBe(450)
    expect(result.costDollars).toBeGreaterThan(0)
  })

  it('handles error results gracefully', async () => {
    const tasks = makeTasks(2)
    const results: TaskResult[] = [
      { taskId: 'test-1', predicted: '', tokens: { inputTokens: 0, outputTokens: 0 }, durationMs: 100, error: 'timeout' },
      { taskId: 'test-2', predicted: 'Answer 2', tokens: { inputTokens: 100, outputTokens: 50 }, durationMs: 500 },
    ]

    const result = await evaluate(tasks, results, {
      scorer: (_q, predicted, groundTruth) => (predicted === groundTruth ? 1.0 : 0.0),
      condition: 'test',
      benchmark: 'officeqa',
      split: 'test',
      modelId: 'claude-sonnet-4-6',
    })

    expect(result.correctCount).toBe(1)
    expect(result.taskCount).toBe(2)
  })
})

describe('aggregateSeeds', () => {
  const makeResult = (accuracy: number, cost: number): EvoSkillBenchmarkResult => ({
    condition: 'baseline',
    benchmark: 'officeqa',
    split: 'test',
    accuracy,
    taskCount: 100,
    correctCount: Math.round(accuracy * 100),
    costTokens: 1000,
    costDollars: cost,
    wallClockMs: 5000,
  })

  it('returns single result unchanged (no std)', () => {
    const result = aggregateSeeds([makeResult(0.6, 1.5)])
    expect(result.accuracy).toBe(0.6)
    expect(result.accuracyStd).toBeUndefined()
  })

  it('computes mean and std for multiple seeds', () => {
    const results = [makeResult(0.6, 1.0), makeResult(0.7, 1.2), makeResult(0.65, 1.1)]
    const agg = aggregateSeeds(results)

    expect(agg.accuracy).toBeCloseTo(0.65)
    expect(agg.accuracyStd).toBeDefined()
    expect(agg.accuracyStd!).toBeGreaterThan(0)
  })

  it('sums costs across seeds', () => {
    const results = [makeResult(0.6, 1.0), makeResult(0.7, 1.5)]
    const agg = aggregateSeeds(results)

    expect(agg.costDollars).toBeCloseTo(2.5)
    expect(agg.costTokens).toBe(2000)
  })

  it('throws for empty input', () => {
    expect(() => aggregateSeeds([])).toThrow('Cannot aggregate 0 results')
  })
})
