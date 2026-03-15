// Tests for harness per-task progress events — SMI-3331
import { describe, it, expect } from 'vitest'
import { runHarness } from './harness.js'
import type { HarnessProgressEvent } from './harness.js'
import type { HarnessConfig } from './types.js'
import type { AgentClient } from './agent-runner.js'

// Minimal mock agent that returns a fixed response
function createMockAgentClient(): AgentClient {
  return {
    async runTask() {
      return {
        content: 'mock answer',
        inputTokens: 10,
        outputTokens: 5,
      }
    },
  }
}

// CSV dataset for officeqa — 10 rows so test split (70%) yields 7 tasks
const MOCK_DATASET = [
  'question,answer',
  'What is 1+1?,2',
  'What is 2+2?,4',
  'What is 3+3?,6',
  'What is 4+4?,8',
  'What is 5+5?,10',
  'What is 6+6?,12',
  'What is 7+7?,14',
  'What is 8+8?,16',
  'What is 9+9?,18',
  'What is 10+10?,20',
].join('\n')

describe('runHarness — task_complete events (SMI-3331)', () => {
  it('emits task_complete for each task in each condition', async () => {
    const events: HarnessProgressEvent[] = []

    const config: HarnessConfig = {
      benchmarks: ['officeqa'],
      conditions: [
        {
          name: 'baseline',
          skillSelector: async () => [],
          modelId: 'claude-sonnet-4-6',
          seed: 42,
        },
      ],
      seeds: [42],
      sampleFraction: 1.0,
      datasetDir: '/mock',
      outputDir: '/tmp/test-output',
      dryRun: false,
    }

    await runHarness(
      config,
      {
        agentClient: createMockAgentClient(),
        getScorer: () => () => 1.0,
        readFile: async () => MOCK_DATASET,
      },
      (event) => {
        events.push(event)
      }
    )

    const taskEvents = events.filter((e) => e.type === 'task_complete')

    // 10 rows with 70% test split = 7 test tasks
    expect(taskEvents.length).toBeGreaterThanOrEqual(1)

    // Verify first task event structure
    expect(taskEvents[0].taskIndex).toBe(1)
    expect(taskEvents[0].totalTasks).toBe(taskEvents.length)
    expect(taskEvents[0].condition).toBe('baseline')
    expect(taskEvents[0].benchmark).toBe('officeqa')
    expect(taskEvents[0].seed).toBe(42)
    expect(taskEvents[0].taskId).toBeDefined()
    expect(taskEvents[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(taskEvents[0].error).toBeUndefined()

    // Verify sequential ordering
    for (let i = 0; i < taskEvents.length; i++) {
      expect(taskEvents[i].taskIndex).toBe(i + 1)
    }
  })

  it('does not emit task_complete events in dry-run mode', async () => {
    const events: HarnessProgressEvent[] = []

    const config: HarnessConfig = {
      benchmarks: ['officeqa'],
      conditions: [
        {
          name: 'baseline',
          skillSelector: async () => [],
          modelId: 'claude-sonnet-4-6',
          seed: 42,
        },
      ],
      seeds: [42],
      sampleFraction: 1.0,
      datasetDir: '/mock',
      outputDir: '/tmp/test-output',
      dryRun: true,
    }

    await runHarness(
      config,
      {
        agentClient: createMockAgentClient(),
        getScorer: () => () => 1.0,
        readFile: async () => MOCK_DATASET,
      },
      (event) => {
        events.push(event)
      }
    )

    const taskEvents = events.filter((e) => e.type === 'task_complete')
    expect(taskEvents.length).toBe(0)
  })

  it('includes error field when agent returns an error', async () => {
    const events: HarnessProgressEvent[] = []
    let callCount = 0

    const errorClient: AgentClient = {
      async runTask() {
        callCount++
        if (callCount === 2) {
          throw new Error('API timeout')
        }
        return { content: 'answer', inputTokens: 10, outputTokens: 5 }
      },
    }

    const config: HarnessConfig = {
      benchmarks: ['officeqa'],
      conditions: [
        {
          name: 'baseline',
          skillSelector: async () => [],
          modelId: 'claude-sonnet-4-6',
          seed: 42,
        },
      ],
      seeds: [42],
      sampleFraction: 1.0,
      datasetDir: '/mock',
      outputDir: '/tmp/test-output',
      dryRun: false,
    }

    await runHarness(
      config,
      {
        agentClient: errorClient,
        getScorer: () => () => 1.0,
        readFile: async () => MOCK_DATASET,
      },
      (event) => {
        events.push(event)
      }
    )

    const taskEvents = events.filter((e) => e.type === 'task_complete')
    expect(taskEvents.length).toBeGreaterThanOrEqual(1)

    // Exactly one task should have an error (the 2nd call)
    const errorEvents = taskEvents.filter((e) => e.error)
    const okEvents = taskEvents.filter((e) => !e.error)
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].error).toContain('API timeout')
    expect(okEvents.length).toBe(taskEvents.length - 1)
  })
})
