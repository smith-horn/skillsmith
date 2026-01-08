/**
 * SMI-632: Benchmark Report Formatters
 * SMI-689: Enhanced with memory profiling output
 * SMI-1189: Extracted from BenchmarkRunner.ts
 *
 * Functions for formatting benchmark reports in various output formats.
 */

import type { BenchmarkReport } from './types.js'

/**
 * Format bytes to human-readable string
 *
 * @param bytes - Number of bytes
 * @returns Human-readable string (e.g., "1.5 MB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k))
  const value = bytes / Math.pow(k, i)
  return `${value.toFixed(1)} ${sizes[i]}`
}

/**
 * Format a benchmark report as JSON for CI integration
 *
 * @param report - Benchmark report to format
 * @returns JSON string
 */
export function formatReportAsJson(report: BenchmarkReport): string {
  return JSON.stringify(report, null, 2)
}

/**
 * Format a benchmark report as human-readable text
 *
 * @param report - Benchmark report to format
 * @returns Formatted text string
 */
export function formatReportAsText(report: BenchmarkReport): string {
  const lines: string[] = [
    `Benchmark Report: ${report.suite}`,
    `Timestamp: ${report.timestamp}`,
    `Environment: Node ${report.environment.node} on ${report.environment.platform}/${report.environment.arch}`,
    `Docker: ${report.environment.docker ? 'Yes' : 'No'}`,
    '',
    'Results:',
    '-'.repeat(80),
  ]

  for (const [name, stats] of Object.entries(report.results)) {
    lines.push(`  ${name}:`)
    lines.push(`    Iterations: ${stats.iterations}`)
    lines.push(`    p50: ${stats.p50_ms}ms, p95: ${stats.p95_ms}ms, p99: ${stats.p99_ms}ms`)
    lines.push(`    Mean: ${stats.mean_ms}ms, StdDev: ${stats.stddev_ms}ms`)
    lines.push(`    Min: ${stats.min_ms}ms, Max: ${stats.max_ms}ms`)
    if (stats.memoryPeak_mb !== undefined) {
      lines.push(`    Memory Peak: ${stats.memoryPeak_mb}MB`)
    }
    // SMI-689: Add detailed memory profile if available
    if (report.memoryProfile?.[name]) {
      const mp = report.memoryProfile[name]
      lines.push(`    Memory Profile:`)
      lines.push(
        `      Heap Growth: ${formatBytes(mp.heapGrowth)} (${mp.heapGrowthPercent.toFixed(1)}%)`
      )
      lines.push(`      Peak Heap: ${formatBytes(mp.peakHeapSize)}`)
      lines.push(`      Samples: ${mp.sampleCount}`)
    }
    lines.push('')
  }

  lines.push('-'.repeat(80))
  lines.push(`Summary:`)
  lines.push(`  Total Benchmarks: ${report.summary.totalBenchmarks}`)
  lines.push(`  Total Iterations: ${report.summary.totalIterations}`)
  lines.push(`  Total Duration: ${report.summary.totalDuration_ms}ms`)

  // SMI-689: Add memory regression summary
  if (report.memoryRegression) {
    lines.push('')
    lines.push('Memory Regression Check:')
    if (report.memoryRegression.hasRegressions) {
      lines.push(
        `  WARNING: ${report.memoryRegression.regressions.length} regression(s) detected (threshold: ${report.memoryRegression.threshold}%)`
      )
      for (const reg of report.memoryRegression.regressions) {
        lines.push(`    - ${reg.label}: ${reg.changePercent.toFixed(1)}% increase`)
      }
    } else {
      lines.push(
        `  No memory regressions detected (threshold: ${report.memoryRegression.threshold}%)`
      )
    }
  }

  return lines.join('\n')
}
