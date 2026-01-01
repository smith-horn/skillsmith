/**
 * Performance Baseline Collector
 *
 * Captures timing and resource metrics during E2E tests
 * to establish baselines for future performance tracking.
 *
 * @see docs/testing/e2e-testing-plan.md
 */

export interface TimingMetric {
  name: string
  command: string
  durationMs: number
  timestamp: string
}

export interface MemoryMetric {
  name: string
  command: string
  heapUsedMB: number
  heapTotalMB: number
  externalMB: number
  timestamp: string
}

export interface PercentileStats {
  min: number
  max: number
  median: number
  mean: number
  p95: number
  p99: number
  count: number
}

export interface BaselineReport {
  timestamp: string
  environment: {
    type: string
    nodeVersion: string
    platform: string
    arch: string
  }
  baselines: {
    [category: string]: {
      [metric: string]: PercentileStats | number
    }
  }
  rawMetrics: {
    timing: TimingMetric[]
    memory: MemoryMetric[]
  }
}

// Collected metrics during test run
const timingMetrics: TimingMetric[] = []
const memoryMetrics: MemoryMetric[] = []

/**
 * Record timing for a command execution
 */
export function recordTiming(name: string, command: string, durationMs: number): void {
  timingMetrics.push({
    name,
    command,
    durationMs,
    timestamp: new Date().toISOString(),
  })
}

/**
 * Record memory usage for a command execution
 */
export function recordMemory(name: string, command: string): void {
  const usage = process.memoryUsage()
  memoryMetrics.push({
    name,
    command,
    heapUsedMB: Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100,
    heapTotalMB: Math.round((usage.heapTotal / 1024 / 1024) * 100) / 100,
    externalMB: Math.round((usage.external / 1024 / 1024) * 100) / 100,
    timestamp: new Date().toISOString(),
  })
}

/**
 * Measure async function execution time
 */
export async function measureAsync<T>(
  name: string,
  command: string,
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now()
  const result = await fn()
  const durationMs = performance.now() - start

  recordTiming(name, command, durationMs)
  recordMemory(name, command)

  return { result, durationMs }
}

/**
 * Measure sync function execution time
 */
export function measureSync<T>(
  name: string,
  command: string,
  fn: () => T
): { result: T; durationMs: number } {
  const start = performance.now()
  const result = fn()
  const durationMs = performance.now() - start

  recordTiming(name, command, durationMs)
  recordMemory(name, command)

  return { result, durationMs }
}

/**
 * Calculate percentile statistics for an array of numbers
 */
function calculateStats(values: number[]): PercentileStats {
  if (values.length === 0) {
    return { min: 0, max: 0, median: 0, mean: 0, p95: 0, p99: 0, count: 0 }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)

  const percentile = (p: number): number => {
    const index = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, index)] ?? 0
  }

  return {
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    median: percentile(50),
    mean: Math.round((sum / sorted.length) * 100) / 100,
    p95: percentile(95),
    p99: percentile(99),
    count: sorted.length,
  }
}

/**
 * Group metrics by command category
 */
function groupByCategory(metrics: TimingMetric[]): Record<string, TimingMetric[]> {
  const groups: Record<string, TimingMetric[]> = {}

  for (const metric of metrics) {
    // Extract category from command (e.g., "skillsmith search" -> "search")
    const parts = metric.command.split(' ')
    const category = (parts.length > 1 ? parts[1] : parts[0]) ?? 'unknown'

    if (!groups[category]) {
      groups[category] = []
    }
    groups[category]!.push(metric)
  }

  return groups
}

/**
 * Generate baseline report from collected metrics
 */
export function generateBaselineReport(): BaselineReport {
  const timingGroups = groupByCategory(timingMetrics)
  const baselines: BaselineReport['baselines'] = {}

  // Calculate timing baselines per category
  for (const [category, metrics] of Object.entries(timingGroups)) {
    const durations = metrics.map((m) => m.durationMs)
    baselines[category] = {
      timing: calculateStats(durations),
    }
  }

  // Calculate overall memory baseline
  if (memoryMetrics.length > 0) {
    const heapUsed = memoryMetrics.map((m) => m.heapUsedMB)
    baselines['memory'] = {
      heapUsedMB: calculateStats(heapUsed),
      peakHeapMB: Math.max(...heapUsed),
    }
  }

  return {
    timestamp: new Date().toISOString(),
    environment: {
      type: process.env['SKILLSMITH_E2E'] ? 'codespace' : 'local',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    baselines,
    rawMetrics: {
      timing: timingMetrics,
      memory: memoryMetrics,
    },
  }
}

/**
 * Export baseline report as JSON
 */
export function exportBaselineJSON(): string {
  return JSON.stringify(generateBaselineReport(), null, 2)
}

/**
 * Export baseline report as Markdown
 */
export function exportBaselineMarkdown(): string {
  const report = generateBaselineReport()
  const lines: string[] = []

  lines.push('# Performance Baseline Report')
  lines.push('')
  lines.push(`**Generated**: ${report.timestamp}`)
  lines.push('')
  lines.push('## Environment')
  lines.push('')
  lines.push(`- **Type**: ${report.environment.type}`)
  lines.push(`- **Node Version**: ${report.environment.nodeVersion}`)
  lines.push(`- **Platform**: ${report.environment.platform}-${report.environment.arch}`)
  lines.push('')

  lines.push('## Timing Baselines')
  lines.push('')
  lines.push('| Command | Median (ms) | P95 (ms) | P99 (ms) | Count |')
  lines.push('|---------|-------------|----------|----------|-------|')

  for (const [category, metrics] of Object.entries(report.baselines)) {
    if (category === 'memory') continue
    const timing = (metrics as { timing: PercentileStats }).timing
    lines.push(
      `| ${category} | ${timing.median.toFixed(1)} | ${timing.p95.toFixed(1)} | ${timing.p99.toFixed(1)} | ${timing.count} |`
    )
  }
  lines.push('')

  if (report.baselines['memory']) {
    lines.push('## Memory Baselines')
    lines.push('')
    const mem = report.baselines['memory'] as { heapUsedMB: PercentileStats; peakHeapMB: number }
    const heapStats = mem.heapUsedMB
    lines.push(`- **Median Heap Used**: ${heapStats.median.toFixed(1)} MB`)
    lines.push(`- **P95 Heap Used**: ${heapStats.p95.toFixed(1)} MB`)
    lines.push(`- **Peak Heap**: ${mem.peakHeapMB} MB`)
    lines.push('')
  }

  lines.push('## Raw Metrics')
  lines.push('')
  lines.push(`Total timing samples: ${report.rawMetrics.timing.length}`)
  lines.push(`Total memory samples: ${report.rawMetrics.memory.length}`)
  lines.push('')

  return lines.join('\n')
}

/**
 * Clear all collected metrics (for test isolation)
 */
export function clearMetrics(): void {
  timingMetrics.length = 0
  memoryMetrics.length = 0
}

/**
 * Get current metrics count
 */
export function getMetricsCount(): { timing: number; memory: number } {
  return {
    timing: timingMetrics.length,
    memory: memoryMetrics.length,
  }
}

export default {
  recordTiming,
  recordMemory,
  measureAsync,
  measureSync,
  generateBaselineReport,
  exportBaselineJSON,
  exportBaselineMarkdown,
  clearMetrics,
  getMetricsCount,
}
