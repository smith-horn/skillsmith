/**
 * SMI-632: Benchmark Report Comparison
 * SMI-1189: Extracted from BenchmarkRunner.ts
 *
 * Functions for comparing benchmark reports to detect
 * performance regressions and improvements.
 */

import type { BenchmarkReport, ComparisonResult, MetricComparison } from './types.js'

/**
 * Compare two benchmark reports to detect regressions/improvements
 *
 * @param baseline - Baseline report to compare against
 * @param current - Current report to compare
 * @returns Comparison result with regression/improvement details
 */
export function compareReports(
  baseline: BenchmarkReport,
  current: BenchmarkReport
): ComparisonResult {
  const comparisons: Record<string, MetricComparison> = {}
  let regressions = 0
  let improvements = 0

  for (const [name, currentStats] of Object.entries(current.results)) {
    const baselineStats = baseline.results[name]
    if (!baselineStats) continue

    const p50Change = ((currentStats.p50_ms - baselineStats.p50_ms) / baselineStats.p50_ms) * 100
    const p95Change = ((currentStats.p95_ms - baselineStats.p95_ms) / baselineStats.p95_ms) * 100
    const p99Change = ((currentStats.p99_ms - baselineStats.p99_ms) / baselineStats.p99_ms) * 100

    const isRegression = p95Change > 10 // 10% threshold
    const isImprovement = p95Change < -10

    if (isRegression) regressions++
    if (isImprovement) improvements++

    comparisons[name] = {
      baseline: baselineStats,
      current: currentStats,
      p50ChangePercent: Math.round(p50Change * 100) / 100,
      p95ChangePercent: Math.round(p95Change * 100) / 100,
      p99ChangePercent: Math.round(p99Change * 100) / 100,
      isRegression,
      isImprovement,
    }
  }

  return {
    baseline: baseline.timestamp,
    current: current.timestamp,
    comparisons,
    summary: {
      totalComparisons: Object.keys(comparisons).length,
      regressions,
      improvements,
      unchanged: Object.keys(comparisons).length - regressions - improvements,
    },
  }
}

/**
 * Check if a comparison has any regressions
 *
 * @param comparison - Comparison result to check
 * @returns True if any regressions were detected
 */
export function hasRegressions(comparison: ComparisonResult): boolean {
  return comparison.summary.regressions > 0
}

/**
 * Get only the regressed benchmarks from a comparison
 *
 * @param comparison - Comparison result to filter
 * @returns Array of [name, comparison] pairs for regressed benchmarks
 */
export function getRegressedBenchmarks(
  comparison: ComparisonResult
): Array<[string, MetricComparison]> {
  return Object.entries(comparison.comparisons).filter(([, comp]) => comp.isRegression)
}

/**
 * Get only the improved benchmarks from a comparison
 *
 * @param comparison - Comparison result to filter
 * @returns Array of [name, comparison] pairs for improved benchmarks
 */
export function getImprovedBenchmarks(
  comparison: ComparisonResult
): Array<[string, MetricComparison]> {
  return Object.entries(comparison.comparisons).filter(([, comp]) => comp.isImprovement)
}
