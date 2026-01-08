/**
 * SMI-632: Benchmark Types
 * SMI-689: Enhanced with MemoryProfiler types
 * SMI-1189: Extracted from BenchmarkRunner.ts
 *
 * Type definitions for performance benchmarking infrastructure.
 */

import type { MemoryBaseline, MemoryRegressionResult } from './MemoryProfiler.js'

/**
 * Benchmark configuration options
 */
export interface BenchmarkConfig {
  /** Number of warm-up iterations before measurement */
  warmupIterations?: number
  /** Number of measured iterations */
  iterations?: number
  /** Enable memory profiling */
  measureMemory?: boolean
  /** Suite name for grouping */
  suiteName?: string
  /** Enable detailed memory profiling with MemoryProfiler (SMI-689) */
  enableMemoryProfiler?: boolean
  /** Memory regression threshold percentage (SMI-689, default: 10) */
  memoryRegressionThreshold?: number
  /** Memory baselines for regression comparison (SMI-689) */
  memoryBaselines?: Record<string, MemoryBaseline>
}

/**
 * Single benchmark result
 */
export interface BenchmarkResult {
  name: string
  iterations: number
  latencies: number[]
  memoryUsage?: MemoryStats
  /** Number of errors encountered during benchmark execution */
  errors: number
  /** Error messages (capped at 10 to prevent memory issues) */
  errorMessages: string[]
}

/**
 * Memory usage statistics
 */
export interface MemoryStats {
  heapUsedBefore: number
  heapUsedAfter: number
  heapUsedPeak: number
  externalBefore: number
  externalAfter: number
}

/**
 * Statistical summary of benchmark results
 */
export interface BenchmarkStats {
  name: string
  iterations: number
  p50_ms: number
  p95_ms: number
  p99_ms: number
  mean_ms: number
  stddev_ms: number
  min_ms: number
  max_ms: number
  memoryPeak_mb?: number
  /** Number of errors encountered during benchmark execution */
  errors?: number
  /** Error messages (capped at 10) */
  errorMessages?: string[]
}

/**
 * Detailed memory profiling stats (SMI-689)
 */
export interface DetailedMemoryStats {
  /** Start heap size in bytes */
  startHeapSize: number
  /** End heap size in bytes */
  endHeapSize: number
  /** Peak heap size in bytes */
  peakHeapSize: number
  /** Heap growth in bytes */
  heapGrowth: number
  /** Heap growth as percentage */
  heapGrowthPercent: number
  /** Duration of profiling in ms */
  profilingDuration: number
  /** Number of samples collected */
  sampleCount: number
}

/**
 * Memory regression info (SMI-689)
 */
export interface MemoryRegressionInfo {
  /** Whether any regressions were detected */
  hasRegressions: boolean
  /** Threshold used for detection */
  threshold: number
  /** Details per benchmark */
  regressions: MemoryRegressionResult[]
}

/**
 * Complete benchmark report
 */
export interface BenchmarkReport {
  suite: string
  timestamp: string
  environment: EnvironmentInfo
  results: Record<string, BenchmarkStats>
  summary: {
    totalBenchmarks: number
    totalIterations: number
    totalDuration_ms: number
  }
  /** Detailed memory profiling data (SMI-689) */
  memoryProfile?: Record<string, DetailedMemoryStats>
  /** Memory regression info (SMI-689) */
  memoryRegression?: MemoryRegressionInfo
  /** Memory baselines for future comparison (SMI-689) */
  memoryBaselines?: Record<string, MemoryBaseline>
}

/**
 * Environment information for reproducibility
 */
export interface EnvironmentInfo {
  node: string
  platform: string
  arch: string
  docker: boolean
  database: string
  cpuCount: number
  memoryTotal_mb: number
}

/**
 * Benchmark function type
 */
export type BenchmarkFn = () => void | Promise<void>

/**
 * Benchmark definition
 */
export interface BenchmarkDefinition {
  name: string
  fn: BenchmarkFn
  setup?: () => void | Promise<void>
  teardown?: () => void | Promise<void>
}

/**
 * Comparison result between two reports
 */
export interface ComparisonResult {
  baseline: string
  current: string
  comparisons: Record<string, MetricComparison>
  summary: {
    totalComparisons: number
    regressions: number
    improvements: number
    unchanged: number
  }
}

/**
 * Single metric comparison
 */
export interface MetricComparison {
  baseline: BenchmarkStats
  current: BenchmarkStats
  p50ChangePercent: number
  p95ChangePercent: number
  p99ChangePercent: number
  isRegression: boolean
  isImprovement: boolean
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Required<BenchmarkConfig> = {
  warmupIterations: 10,
  iterations: 1000,
  measureMemory: true,
  suiteName: 'default',
  enableMemoryProfiler: false,
  memoryRegressionThreshold: 10,
  memoryBaselines: {},
}
