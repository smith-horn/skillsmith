/**
 * SMI-632: BenchmarkRunner - Performance benchmark infrastructure
 * SMI-689: Enhanced with MemoryProfiler integration
 * SMI-1189: Refactored to use extracted modules
 *
 * Features:
 * - Run benchmark suites
 * - Measure p50, p95, p99 latencies
 * - Memory usage tracking with MemoryProfiler
 * - Memory regression detection (fail if heap grows >10% vs baseline)
 * - Warm-up runs before measurement
 * - Statistical analysis (mean, stddev)
 */

import * as os from 'os'
import * as fs from 'fs'
import { percentile, sampleStddev, mean } from './stats.js'
import {
  MemoryProfiler,
  type MemoryBaseline,
  type MemoryRegressionResult,
} from './MemoryProfiler.js'
import {
  DEFAULT_CONFIG,
  type BenchmarkConfig,
  type BenchmarkResult,
  type BenchmarkStats,
  type BenchmarkReport,
  type BenchmarkDefinition,
  type EnvironmentInfo,
  type MemoryStats,
  type DetailedMemoryStats,
} from './types.js'

// Re-export types for backwards compatibility
export type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkStats,
  BenchmarkReport,
  BenchmarkDefinition,
  BenchmarkFn,
  EnvironmentInfo,
  MemoryStats,
  DetailedMemoryStats,
  MemoryRegressionInfo,
  ComparisonResult,
  MetricComparison,
} from './types.js'

// Re-export formatters and comparator for backwards compatibility
export { formatReportAsJson, formatReportAsText, formatBytes } from './formatters.js'
export {
  compareReports,
  hasRegressions,
  getRegressedBenchmarks,
  getImprovedBenchmarks,
} from './comparator.js'

/**
 * Core benchmark runner for performance testing
 */
export class BenchmarkRunner {
  private config: Required<BenchmarkConfig>
  private benchmarks: BenchmarkDefinition[] = []
  private results: BenchmarkResult[] = []
  /** SMI-689: Memory profiler instance */
  private memoryProfiler: MemoryProfiler | null = null

  constructor(config: BenchmarkConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    // SMI-689: Initialize memory profiler if enabled
    if (this.config.enableMemoryProfiler) {
      this.memoryProfiler = new MemoryProfiler()
      if (this.config.memoryBaselines && Object.keys(this.config.memoryBaselines).length > 0) {
        this.memoryProfiler.loadBaselines(this.config.memoryBaselines)
      }
    }
  }

  /**
   * Get the memory profiler instance (SMI-689)
   */
  getMemoryProfiler(): MemoryProfiler | null {
    return this.memoryProfiler
  }

  /**
   * Add a benchmark to the suite
   */
  add(definition: BenchmarkDefinition): this {
    this.benchmarks.push(definition)
    return this
  }

  /**
   * Run all benchmarks in the suite
   */
  async run(): Promise<BenchmarkReport> {
    const startTime = Date.now()
    this.results = []

    for (const benchmark of this.benchmarks) {
      // SMI-689: Start memory profiling if enabled
      if (this.memoryProfiler) {
        this.memoryProfiler.trackMemory(benchmark.name)
      }

      const result = await this.runBenchmark(benchmark)
      this.results.push(result)

      // SMI-689: Stop memory profiling and save baseline (only if no baseline was pre-loaded)
      if (this.memoryProfiler) {
        this.memoryProfiler.stopTracking(benchmark.name)
        // Only save new baseline if one wasn't already loaded for this benchmark
        if (!this.config.memoryBaselines[benchmark.name]) {
          this.memoryProfiler.saveBaseline(benchmark.name)
        }
      }
    }

    const totalDuration = Date.now() - startTime

    return this.generateReport(totalDuration)
  }

  /**
   * Run a single benchmark with error handling (SMI-678)
   */
  private async runBenchmark(definition: BenchmarkDefinition): Promise<BenchmarkResult> {
    const { warmupIterations, iterations, measureMemory } = this.config
    const latencies: number[] = []
    let errors = 0
    const errorMessages: string[] = []
    const MAX_ERROR_MESSAGES = 10

    // Setup phase
    if (definition.setup) {
      await definition.setup()
    }

    // Warm-up phase with error handling
    for (let i = 0; i < warmupIterations; i++) {
      try {
        await definition.fn()
      } catch (_err) {
        // Ignore warmup errors, just continue
      }
    }

    // Force garbage collection if available
    this.forceGC()

    // Capture memory before
    const memBefore = measureMemory ? process.memoryUsage() : null
    let memPeak = memBefore?.heapUsed ?? 0

    // Measurement phase with error handling (SMI-678)
    for (let i = 0; i < iterations; i++) {
      try {
        const start = performance.now()
        await definition.fn()
        const end = performance.now()
        latencies.push(end - start)

        // Track peak memory periodically
        if (measureMemory && i % 100 === 0) {
          const current = process.memoryUsage().heapUsed
          if (current > memPeak) {
            memPeak = current
          }
        }
      } catch (err) {
        errors++
        if (errorMessages.length < MAX_ERROR_MESSAGES) {
          errorMessages.push(err instanceof Error ? err.message : String(err))
        }
      }
    }

    // Capture memory after
    const memAfter = measureMemory ? process.memoryUsage() : null

    // Teardown phase
    if (definition.teardown) {
      await definition.teardown()
    }

    const result: BenchmarkResult = {
      name: definition.name,
      iterations: latencies.length, // Only count successful iterations
      latencies,
      errors,
      errorMessages,
    }

    if (measureMemory && memBefore && memAfter) {
      result.memoryUsage = {
        heapUsedBefore: memBefore.heapUsed,
        heapUsedAfter: memAfter.heapUsed,
        heapUsedPeak: memPeak,
        externalBefore: memBefore.external,
        externalAfter: memAfter.external,
      }
    }

    return result
  }

  /**
   * Generate a benchmark report from results
   */
  private generateReport(totalDuration: number): BenchmarkReport {
    const results: Record<string, BenchmarkStats> = {}
    let totalIterations = 0

    for (const result of this.results) {
      results[result.name] = this.calculateStats(result)
      totalIterations += result.iterations
    }

    const report: BenchmarkReport = {
      suite: this.config.suiteName,
      timestamp: new Date().toISOString(),
      environment: this.getEnvironmentInfo(),
      results,
      summary: {
        totalBenchmarks: this.results.length,
        totalIterations,
        totalDuration_ms: totalDuration,
      },
    }

    // SMI-689: Add memory profiling data if enabled
    if (this.memoryProfiler) {
      const completedStats = this.memoryProfiler.getCompletedStats()
      const memoryProfile: Record<string, DetailedMemoryStats> = {}

      for (const [label, stats] of completedStats) {
        memoryProfile[label] = {
          startHeapSize: stats.startSnapshot.usedHeapSize,
          endHeapSize: stats.endSnapshot?.usedHeapSize ?? 0,
          peakHeapSize: stats.peakHeapUsed,
          heapGrowth: stats.heapGrowth,
          heapGrowthPercent: stats.heapGrowthPercent,
          profilingDuration: stats.duration,
          sampleCount: stats.sampleCount,
        }
      }

      report.memoryProfile = memoryProfile
      report.memoryBaselines = this.memoryProfiler.exportBaselines()

      // Check for regressions if baselines were provided
      if (Object.keys(this.config.memoryBaselines).length > 0) {
        const regressions: MemoryRegressionResult[] = []
        for (const label of completedStats.keys()) {
          const result = this.memoryProfiler.checkRegression(
            label,
            this.config.memoryRegressionThreshold
          )
          if (result.hasRegression) {
            regressions.push(result)
          }
        }

        report.memoryRegression = {
          hasRegressions: regressions.length > 0,
          threshold: this.config.memoryRegressionThreshold,
          regressions,
        }
      }
    }

    return report
  }

  /**
   * Calculate statistical metrics from latencies
   * Uses shared stats module for consistent calculations (SMI-677)
   * Includes empty array guard (SMI-679) and sample variance (Bessel correction)
   */
  private calculateStats(result: BenchmarkResult): BenchmarkStats {
    // SMI-679: Empty array guard
    if (result.latencies.length === 0) {
      return {
        name: result.name,
        iterations: 0,
        p50_ms: 0,
        p95_ms: 0,
        p99_ms: 0,
        mean_ms: 0,
        stddev_ms: 0,
        min_ms: 0,
        max_ms: 0,
        errors: result.errors,
        errorMessages: result.errorMessages,
      }
    }

    const sorted = [...result.latencies].sort((a, b) => a - b)
    const n = sorted.length

    // SMI-677: Use shared percentile function with linear interpolation
    // Use sample stddev (n-1 denominator) for Bessel correction
    const stats: BenchmarkStats = {
      name: result.name,
      iterations: result.iterations,
      p50_ms: percentile(sorted, 50),
      p95_ms: percentile(sorted, 95),
      p99_ms: percentile(sorted, 99),
      mean_ms: Math.round(mean(sorted) * 1000) / 1000,
      stddev_ms: Math.round(sampleStddev(sorted) * 1000) / 1000,
      min_ms: sorted[0],
      max_ms: sorted[n - 1],
      errors: result.errors,
      errorMessages: result.errorMessages,
    }

    if (result.memoryUsage) {
      stats.memoryPeak_mb = Math.round((result.memoryUsage.heapUsedPeak / 1024 / 1024) * 100) / 100
    }

    return stats
  }

  /**
   * @deprecated Use shared percentile from stats.ts instead (SMI-677)
   * Calculate percentile value from sorted array
   */
  private _legacyPercentile(sorted: number[], p: number): number {
    const index = Math.ceil((p / 100) * sorted.length) - 1
    const value = sorted[Math.max(0, index)]
    return Math.round(value * 1000) / 1000
  }

  /**
   * Get environment information
   */
  private getEnvironmentInfo(): EnvironmentInfo {
    return {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      docker: this.isDocker(),
      database: 'sqlite',
      cpuCount: os.cpus().length,
      memoryTotal_mb: Math.round(os.totalmem() / 1024 / 1024),
    }
  }

  /**
   * Detect if running in Docker
   */
  private isDocker(): boolean {
    try {
      // Check for .dockerenv file
      if (fs.existsSync('/.dockerenv')) {
        return true
      }
      // Check for docker in cgroup
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8')
      return cgroup.includes('docker')
    } catch {
      return false
    }
  }

  /**
   * Force garbage collection if available
   */
  private forceGC(): void {
    if (typeof global.gc === 'function') {
      global.gc()
    }
  }

  /**
   * Get raw results
   */
  getResults(): BenchmarkResult[] {
    return this.results
  }

  /**
   * Clear all benchmarks
   */
  clear(): void {
    this.benchmarks = []
    this.results = []
    if (this.memoryProfiler) {
      this.memoryProfiler.clear()
    }
  }

  /**
   * Enable memory profiler after construction (SMI-689)
   */
  enableMemoryProfiler(baselines?: Record<string, MemoryBaseline>): void {
    this.memoryProfiler = new MemoryProfiler()
    if (baselines) {
      this.memoryProfiler.loadBaselines(baselines)
      this.config.memoryBaselines = baselines
    }
  }

  /**
   * Get memory profiling report as string (SMI-689)
   */
  getMemoryReport(): string {
    if (!this.memoryProfiler) {
      return 'Memory profiling not enabled. Use enableMemoryProfiler: true in config.'
    }
    return this.memoryProfiler.formatMemoryReport()
  }
}
