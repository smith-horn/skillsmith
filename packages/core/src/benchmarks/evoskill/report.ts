// EvoSkill report generator — SMI-3274
// Self-specified schema: markdown tables + JSON export

import type { EvoSkillBenchmarkResult } from './types.js'
import type { HarnessResult } from './harness.js'

export interface ReportOptions {
  title?: string
  includeRawResults?: boolean
  includePareto?: boolean
}

/**
 * Generate markdown comparison table.
 * Columns: Condition | OfficeQA Acc | SEAL-QA Acc | BrowseComp Acc | Cost ($) | Time (s)
 */
export function generateMarkdownReport(
  harnessResult: HarnessResult,
  options: ReportOptions = {}
): string {
  const { title = 'EvoSkill Benchmark Results', includePareto = true } = options
  const { aggregated, wallClockMs } = harnessResult

  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`Total wall clock: ${(wallClockMs / 1000).toFixed(1)}s`)
  lines.push('')

  // Main comparison table
  lines.push('## Comparison Table')
  lines.push('')
  lines.push(
    '| Condition | OfficeQA Acc | SEAL-QA Acc | BrowseComp Acc | Cost ($) | Time (s) | Errors |'
  )
  lines.push(
    '|-----------|-------------|------------|----------------|----------|----------|--------|'
  )

  const conditions = [...new Set(aggregated.map((r) => r.condition))]
  const benchmarks: Array<'officeqa' | 'sealqa' | 'browsecomp'> = [
    'officeqa',
    'sealqa',
    'browsecomp',
  ]

  for (const cond of conditions) {
    const cells = [cond]

    let totalCost = 0
    let totalTime = 0
    let totalErrors = 0

    for (const bm of benchmarks) {
      const result = aggregated.find((r) => r.condition === cond && r.benchmark === bm)
      if (result) {
        cells.push(formatAccuracy(result.accuracy, result.accuracyStd))
        totalCost += result.costDollars
        totalTime += result.wallClockMs / 1000
        totalErrors += result.errorCount ?? 0
      } else {
        cells.push('—')
      }
    }

    cells.push(`$${totalCost.toFixed(2)}`)
    cells.push(totalTime.toFixed(1))
    cells.push(totalErrors > 0 ? String(totalErrors) : '0')
    lines.push(`| ${cells.join(' | ')} |`)
  }

  lines.push('')

  // Pareto frontier
  if (includePareto) {
    lines.push('## Pareto Frontier (Accuracy vs Cost)')
    lines.push('')
    const paretoPoints = computeParetoFrontier(aggregated)
    if (paretoPoints.length > 0) {
      lines.push('| Condition | Benchmark | Accuracy | Cost ($) | Pareto-Optimal |')
      lines.push('|-----------|-----------|----------|----------|----------------|')
      for (const p of paretoPoints) {
        const isOptimal = p.isPareto ? 'Yes' : ''
        lines.push(
          `| ${p.condition} | ${p.benchmark} | ${(p.accuracy * 100).toFixed(1)}% | $${p.cost.toFixed(2)} | ${isOptimal} |`
        )
      }
      lines.push('')
    }
  }

  // IR metrics table (if any results have them)
  const withIr = aggregated.filter((r) => r.irMetrics)
  if (withIr.length > 0) {
    lines.push('## IR Metrics (Retrieval Conditions)')
    lines.push('')
    lines.push('| Condition | Benchmark | nDCG@5 | MRR | MAP@5 |')
    lines.push('|-----------|-----------|--------|-----|-------|')
    for (const r of withIr) {
      const ir = r.irMetrics!
      lines.push(
        `| ${r.condition} | ${r.benchmark} | ${ir.ndcg5.toFixed(3)} | ${ir.mrr.toFixed(3)} | ${ir.map5.toFixed(3)} |`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** Generate JSON report */
export function generateJsonReport(harnessResult: HarnessResult): string {
  const output = {
    generatedAt: new Date().toISOString(),
    wallClockMs: harnessResult.wallClockMs,
    aggregated: harnessResult.aggregated.map(serializeResult),
    results: harnessResult.results.map(serializeResult),
    paretoFrontier: computeParetoFrontier(harnessResult.aggregated)
      .filter((p) => p.isPareto)
      .map((p) => ({
        condition: p.condition,
        benchmark: p.benchmark,
        accuracy: p.accuracy,
        cost: p.cost,
      })),
  }
  return JSON.stringify(output, null, 2)
}

/** Format accuracy as percentage with optional std */
function formatAccuracy(accuracy: number, std?: number): string {
  const pct = (accuracy * 100).toFixed(1)
  if (std === undefined) return `${pct}%`
  return `${pct} ± ${(std * 100).toFixed(1)}%`
}

/** Serialize result for JSON (omit undefined fields) */
function serializeResult(r: EvoSkillBenchmarkResult): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    condition: r.condition,
    benchmark: r.benchmark,
    split: r.split,
    accuracy: r.accuracy,
    taskCount: r.taskCount,
    correctCount: r.correctCount,
    costTokens: r.costTokens,
    costDollars: r.costDollars,
    wallClockMs: r.wallClockMs,
  }
  if (r.errorCount !== undefined && r.errorCount > 0) obj.errorCount = r.errorCount
  if (r.accuracyStd !== undefined) obj.accuracyStd = r.accuracyStd
  if (r.irMetrics) obj.irMetrics = r.irMetrics
  return obj
}

interface ParetoPoint {
  condition: string
  benchmark: string
  accuracy: number
  cost: number
  isPareto: boolean
}

/** Compute Pareto frontier: no other point dominates on both accuracy AND cost */
function computeParetoFrontier(results: EvoSkillBenchmarkResult[]): ParetoPoint[] {
  const points: ParetoPoint[] = results.map((r) => ({
    condition: r.condition,
    benchmark: r.benchmark,
    accuracy: r.accuracy,
    cost: r.costDollars,
    isPareto: false,
  }))

  // Group by benchmark for per-benchmark Pareto
  const byBenchmark = new Map<string, ParetoPoint[]>()
  for (const p of points) {
    const group = byBenchmark.get(p.benchmark) ?? []
    group.push(p)
    byBenchmark.set(p.benchmark, group)
  }

  for (const group of byBenchmark.values()) {
    for (const p of group) {
      // A point is Pareto-optimal if no other point has >= accuracy AND <= cost
      p.isPareto = !group.some(
        (other) =>
          other !== p &&
          other.accuracy >= p.accuracy &&
          other.cost <= p.cost &&
          (other.accuracy > p.accuracy || other.cost < p.cost)
      )
    }
  }

  return points
}
