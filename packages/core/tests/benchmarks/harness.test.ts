import { describe, it, expect } from 'vitest'
import { runHarness } from '../../src/benchmarks/evoskill/harness.js'
import type { HarnessConfig } from '../../src/benchmarks/evoskill/types.js'
import type { HarnessDependencies, HarnessProgressEvent } from '../../src/benchmarks/evoskill/harness.js'

// Minimal CSV dataset for testing
const TEST_CSV = [
  'question,answer',
  'Q1?,A1',
  'Q2?,A2',
  'Q3?,A3',
  'Q4?,A4',
  'Q5?,A5',
  'Q6?,A6',
  'Q7?,A7',
  'Q8?,A8',
  'Q9?,A9',
  'Q10?,A10',
].join('\n')

function createMockDeps(): HarnessDependencies {
  return {
    agentClient: {
      async runTask() {
        return { content: 'A1', inputTokens: 50, outputTokens: 20 }
      },
    },
    getScorer: () => (_q: string, predicted: string, groundTruth: string) =>
      predicted === groundTruth ? 1.0 : 0.0,
    readFile: async () => TEST_CSV,
  }
}

describe('runHarness', () => {
  it('runs dry-run mode without API calls', async () => {
    const config: HarnessConfig = {
      benchmarks: ['officeqa'],
      conditions: [
        { name: 'baseline', skillSelector: async () => [], modelId: 'claude-sonnet-4-6', seed: 42 },
      ],
      seeds: [42],
      sampleFraction: 1.0,
      datasetDir: '/tmp',
      outputDir: '/tmp/results',
      dryRun: true,
    }

    const result = await runHarness(config, createMockDeps())

    expect(result.results).toHaveLength(1)
    expect(result.results[0].accuracy).toBe(0)
    expect(result.results[0].costTokens).toBe(0)
  })

  it('emits progress events', async () => {
    const events: HarnessProgressEvent[] = []
    const config: HarnessConfig = {
      benchmarks: ['officeqa'],
      conditions: [
        { name: 'test', skillSelector: async () => [], modelId: 'claude-sonnet-4-6', seed: 42 },
      ],
      seeds: [42],
      sampleFraction: 1.0,
      datasetDir: '/tmp',
      outputDir: '/tmp/results',
      dryRun: true,
    }

    await runHarness(config, createMockDeps(), (e) => events.push(e))

    const types = events.map((e) => e.type)
    expect(types).toContain('seed_start')
    expect(types).toContain('condition_start')
    expect(types).toContain('condition_complete')
    expect(types).toContain('seed_complete')
    expect(types).toContain('harness_complete')
  })

  it('uses different seeds for dataset splits', async () => {
    const config: HarnessConfig = {
      benchmarks: ['officeqa'],
      conditions: [
        { name: 'baseline', skillSelector: async () => [], modelId: 'claude-sonnet-4-6', seed: 42 },
      ],
      seeds: [42, 43],
      sampleFraction: 1.0,
      datasetDir: '/tmp',
      outputDir: '/tmp/results',
      dryRun: true,
    }

    const result = await runHarness(config, createMockDeps())
    // Two seeds × one condition = 2 results
    expect(result.results).toHaveLength(2)
    // Aggregated should collapse to 1
    expect(result.aggregated).toHaveLength(1)
  })

  it('applies sample fraction', async () => {
    const config: HarnessConfig = {
      benchmarks: ['officeqa'],
      conditions: [
        { name: 'test', skillSelector: async () => [], modelId: 'claude-sonnet-4-6', seed: 42 },
      ],
      seeds: [42],
      sampleFraction: 0.5,
      datasetDir: '/tmp',
      outputDir: '/tmp/results',
      dryRun: true,
    }

    const result = await runHarness(config, createMockDeps())
    // 10 rows × 70% test × 50% sample ≈ 3-4 tasks
    expect(result.results[0].taskCount).toBeLessThan(7)
    expect(result.results[0].taskCount).toBeGreaterThan(0)
  })
})
