import { describe, it, expect, vi } from 'vitest'
import { runEvoSkillTask, runEvoSkillBatch, calculateCost } from '../../src/benchmarks/evoskill/agent-runner.js'
import type { BenchmarkTask } from '../../src/benchmarks/evoskill/types.js'
import type { AgentClient } from '../../src/benchmarks/evoskill/agent-runner.js'

const task: BenchmarkTask = {
  id: 'test-1',
  question: 'What is 2+2?',
  groundTruth: '4',
  split: 'test',
  benchmark: 'officeqa',
}

const mockClient: AgentClient = {
  async runTask() {
    return { content: '4', inputTokens: 100, outputTokens: 50 }
  },
}

describe('runEvoSkillTask', () => {
  it('returns predicted content and tokens', async () => {
    const result = await runEvoSkillTask(task, {
      client: mockClient,
      modelId: 'claude-sonnet-4-6',
      skills: [],
    })

    expect(result.taskId).toBe('test-1')
    expect(result.predicted).toBe('4')
    expect(result.tokens.inputTokens).toBe(100)
    expect(result.tokens.outputTokens).toBe(50)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()
  })

  it('captures errors gracefully', async () => {
    const failClient: AgentClient = {
      async runTask() { throw new Error('API error') },
    }

    const result = await runEvoSkillTask(task, {
      client: failClient,
      modelId: 'claude-sonnet-4-6',
      skills: [],
    })

    expect(result.predicted).toBe('')
    expect(result.error).toBe('API error')
    expect(result.tokens.inputTokens).toBe(0)
  })

  it('retries on rate limit errors', async () => {
    let attempts = 0
    const rateLimitClient: AgentClient = {
      async runTask() {
        attempts++
        if (attempts < 3) throw new Error('429 rate limit exceeded')
        return { content: 'ok', inputTokens: 10, outputTokens: 5 }
      },
    }

    const result = await runEvoSkillTask(task, {
      client: rateLimitClient,
      modelId: 'claude-sonnet-4-6',
      skills: [],
    })

    expect(result.predicted).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('does not retry on non-rate-limit errors', async () => {
    let attempts = 0
    const errorClient: AgentClient = {
      async runTask() {
        attempts++
        throw new Error('Invalid request')
      },
    }

    const result = await runEvoSkillTask(task, {
      client: errorClient,
      modelId: 'claude-sonnet-4-6',
      skills: [],
    })

    expect(attempts).toBe(1)
    expect(result.error).toBe('Invalid request')
  })
})

describe('runEvoSkillBatch', () => {
  it('runs all tasks and reports progress', async () => {
    const tasks: BenchmarkTask[] = [
      { ...task, id: 't1' },
      { ...task, id: 't2' },
      { ...task, id: 't3' },
    ]

    const progress: Array<[number, number]> = []
    const results = await runEvoSkillBatch(tasks, {
      client: mockClient,
      modelId: 'claude-sonnet-4-6',
      skills: [],
    }, (completed, total) => progress.push([completed, total]))

    expect(results).toHaveLength(3)
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]])
  })
})

describe('calculateCost', () => {
  it('calculates cost for sonnet model', () => {
    const cost = calculateCost(
      { inputTokens: 1000, outputTokens: 500 },
      'claude-sonnet-4-6'
    )
    // 1000 * 3e-6 + 500 * 15e-6 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105)
  })

  it('calculates cost for opus model', () => {
    const cost = calculateCost(
      { inputTokens: 1000, outputTokens: 500 },
      'claude-opus-4-6'
    )
    // 1000 * 15e-6 + 500 * 75e-6 = 0.015 + 0.0375 = 0.0525
    expect(cost).toBeCloseTo(0.0525)
  })

  it('uses default pricing for unknown models', () => {
    const cost = calculateCost(
      { inputTokens: 1000, outputTokens: 500 },
      'unknown-model'
    )
    // Uses default (same as sonnet)
    expect(cost).toBeCloseTo(0.0105)
  })
})
