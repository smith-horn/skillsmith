import { describe, it, expect } from 'vitest'
import { generateMarkdownReport, generateJsonReport } from '../../src/benchmarks/evoskill/report.js'
import type { HarnessResult } from '../../src/benchmarks/evoskill/harness.js'
import type { EvoSkillBenchmarkResult } from '../../src/benchmarks/evoskill/types.js'

function makeResult(overrides: Partial<EvoSkillBenchmarkResult> = {}): EvoSkillBenchmarkResult {
  return {
    condition: 'baseline',
    benchmark: 'officeqa',
    split: 'test',
    accuracy: 0.6,
    taskCount: 100,
    correctCount: 60,
    costTokens: 50000,
    costDollars: 1.5,
    wallClockMs: 30000,
    ...overrides,
  }
}

function makeHarnessResult(results: EvoSkillBenchmarkResult[]): HarnessResult {
  return {
    results,
    aggregated: results,
    wallClockMs: 60000,
  }
}

describe('generateMarkdownReport', () => {
  it('generates a valid markdown table', () => {
    const result = makeHarnessResult([
      makeResult({ condition: 'baseline', benchmark: 'officeqa', accuracy: 0.6 }),
      makeResult({ condition: 'search', benchmark: 'officeqa', accuracy: 0.7 }),
    ])

    const md = generateMarkdownReport(result)
    expect(md).toContain('# EvoSkill Benchmark Results')
    expect(md).toContain('| baseline')
    expect(md).toContain('| search')
    expect(md).toContain('60.0%')
    expect(md).toContain('70.0%')
  })

  it('formats accuracy with std when present', () => {
    const result = makeHarnessResult([
      makeResult({ accuracy: 0.65, accuracyStd: 0.03 }),
    ])

    const md = generateMarkdownReport(result)
    expect(md).toContain('65.0 ± 3.0%')
  })

  it('renders dash for missing benchmarks', () => {
    const result = makeHarnessResult([
      makeResult({ benchmark: 'officeqa' }),
    ])

    const md = generateMarkdownReport(result)
    // sealqa and browsecomp columns should have dashes
    expect(md).toContain('—')
  })

  it('includes Pareto frontier section', () => {
    const result = makeHarnessResult([
      makeResult({ condition: 'cheap', accuracy: 0.5, costDollars: 0.5 }),
      makeResult({ condition: 'expensive', accuracy: 0.9, costDollars: 5.0 }),
    ])

    const md = generateMarkdownReport(result)
    expect(md).toContain('Pareto Frontier')
    expect(md).toContain('Pareto-Optimal')
  })

  it('includes IR metrics table when present', () => {
    const result = makeHarnessResult([
      makeResult({ irMetrics: { ndcg5: 0.85, mrr: 0.9, map5: 0.75 } }),
    ])

    const md = generateMarkdownReport(result)
    expect(md).toContain('IR Metrics')
    expect(md).toContain('0.850')
  })

  it('accepts custom title', () => {
    const result = makeHarnessResult([makeResult()])
    const md = generateMarkdownReport(result, { title: 'Custom Title' })
    expect(md).toContain('# Custom Title')
  })
})

describe('generateJsonReport', () => {
  it('generates valid JSON', () => {
    const result = makeHarnessResult([makeResult()])
    const json = generateJsonReport(result)
    const parsed = JSON.parse(json)

    expect(parsed.generatedAt).toBeDefined()
    expect(parsed.wallClockMs).toBe(60000)
    expect(parsed.aggregated).toHaveLength(1)
    expect(parsed.results).toHaveLength(1)
  })

  it('omits accuracyStd when undefined', () => {
    const result = makeHarnessResult([makeResult()])
    const json = generateJsonReport(result)
    const parsed = JSON.parse(json)

    expect(parsed.results[0].accuracyStd).toBeUndefined()
  })

  it('includes Pareto frontier', () => {
    const result = makeHarnessResult([
      makeResult({ condition: 'a', accuracy: 0.9, costDollars: 1.0 }),
      makeResult({ condition: 'b', accuracy: 0.5, costDollars: 2.0 }),
    ])
    const json = generateJsonReport(result)
    const parsed = JSON.parse(json)

    expect(parsed.paretoFrontier.length).toBeGreaterThan(0)
    // 'a' dominates 'b' (higher accuracy, lower cost)
    expect(parsed.paretoFrontier[0].condition).toBe('a')
  })
})
