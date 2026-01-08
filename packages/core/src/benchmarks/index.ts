/**
 * SMI-632: Benchmark module exports
 * SMI-689: Enhanced with MemoryProfiler integration
 * SMI-1189: Updated to export from split modules
 *
 * Provides performance benchmarking infrastructure for:
 * - Search query latency
 * - Indexing throughput
 * - Statistical analysis
 * - CI integration
 * - Memory profiling and leak detection
 */

// Core benchmark runner (includes re-exports for backwards compatibility)
export {
  BenchmarkRunner,
  type BenchmarkConfig,
  type BenchmarkResult,
  type BenchmarkStats,
  type BenchmarkReport,
  type BenchmarkDefinition,
  type BenchmarkFn,
  type MemoryStats,
  type EnvironmentInfo,
  type ComparisonResult,
  type MetricComparison,
  type DetailedMemoryStats,
  type MemoryRegressionInfo,
  formatReportAsJson,
  formatReportAsText,
  formatBytes,
  compareReports,
  hasRegressions,
  getRegressedBenchmarks,
  getImprovedBenchmarks,
} from './BenchmarkRunner.js'

// Types module (direct access)
export { DEFAULT_CONFIG } from './types.js'

// Formatters module (direct access)
export { formatBytes as formatBytesUtil } from './formatters.js'

// Comparator module (direct access)
export { hasRegressions as hasRegressionsUtil } from './comparator.js'

// SMI-689: Memory profiler
export {
  MemoryProfiler,
  defaultMemoryProfiler,
  type MemorySnapshot,
  type MemoryStats as ProfilerMemoryStats,
  type MemoryBaseline,
  type LeakDetectionResult,
  type MemoryRegressionResult,
} from './MemoryProfiler.js'

// Search benchmarks
export {
  SearchBenchmark,
  type SearchBenchmarkConfig,
  type ValidationResult,
  SEARCH_TARGETS,
  validateSearchResults,
} from './SearchBenchmark.js'

// Index benchmarks
export {
  IndexBenchmark,
  type IndexBenchmarkConfig,
  type ThroughputResult,
  type SizeImpactResult,
  type IndexValidationResult,
  INDEX_TARGETS,
  validateIndexResults,
} from './IndexBenchmark.js'

// SMI-738: Cache benchmarks
export {
  CacheBenchmark,
  type CacheBenchmarkConfig,
  type CacheValidationResult,
  CACHE_TARGETS,
  validateCacheResults,
} from './cacheBenchmark.js'

// SMI-738: Embedding benchmarks
export {
  EmbeddingBenchmark,
  type EmbeddingBenchmarkConfig,
  type EmbeddingValidationResult,
  EMBEDDING_TARGETS,
  validateEmbeddingResults,
} from './embeddingBenchmark.js'

// SMI-677: Shared statistical utilities
export {
  percentile,
  mean,
  sampleStddev,
  calculateLatencyStats,
  type LatencyStats,
} from './stats.js'

/**
 * CLI-friendly benchmark runner
 *
 * Usage:
 *   npx ts-node -e "import { runAllBenchmarks } from './benchmarks'; runAllBenchmarks()"
 *
 * Or with npm script:
 *   npm run benchmark
 *   npm run benchmark -- --suite search
 *   npm run benchmark -- --suite index
 *   npm run benchmark -- --compare baseline.json
 */
export async function runAllBenchmarks(options: CLIOptions = {}): Promise<void> {
  const {
    suite,
    compare,
    output = 'text',
    iterations,
    memory = false,
    memoryThreshold = 10,
    memoryBaseline,
  } = options

  console.log('Starting Skillsmith Performance Benchmarks\n')

  // SMI-689: Load memory baselines if provided
  let memoryBaselines: Record<string, import('./MemoryProfiler.js').MemoryBaseline> = {}
  if (memoryBaseline) {
    try {
      const fs = await import('fs')
      const baselineData = fs.readFileSync(memoryBaseline, 'utf-8')
      const parsed = JSON.parse(baselineData)
      memoryBaselines = parsed.memoryBaselines ?? {}
      console.log(`Loaded memory baselines from ${memoryBaseline}`)
    } catch (err) {
      console.warn(
        `Warning: Could not load memory baselines: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  const results: BenchmarkReport[] = []

  // Run search benchmarks
  if (!suite || suite === 'search') {
    console.log('Running search benchmarks...')
    // SMI-689: Enable memory profiling if requested
    const searchBenchmark = new SearchBenchmark({
      iterations: iterations ?? 1000,
      skillCount: 1000,
      enableMemoryProfiler: memory,
      memoryRegressionThreshold: memoryThreshold,
      memoryBaselines: memoryBaselines,
    })
    const searchReport = await searchBenchmark.run()
    results.push(searchReport)

    const searchValidation = validateSearchResults(searchReport)
    if (!searchValidation.passed) {
      console.error('Search benchmark failures:')
      searchValidation.failures.forEach((f) => console.error(`  - ${f}`))
    }
    if (searchValidation.warnings.length > 0) {
      console.warn('Search benchmark warnings:')
      searchValidation.warnings.forEach((w) => console.warn(`  - ${w}`))
    }
  }

  // Run index benchmarks
  if (!suite || suite === 'index') {
    console.log('Running index benchmarks...')
    // SMI-689: Enable memory profiling if requested
    const indexBenchmark = new IndexBenchmark({
      iterations: iterations ?? 100,
      enableMemoryProfiler: memory,
      memoryRegressionThreshold: memoryThreshold,
      memoryBaselines: memoryBaselines,
    })
    const indexReport = await indexBenchmark.run()
    results.push(indexReport)

    const indexValidation = validateIndexResults(indexReport)
    if (!indexValidation.passed) {
      console.error('Index benchmark failures:')
      indexValidation.failures.forEach((f) => console.error(`  - ${f}`))
    }
    if (indexValidation.warnings.length > 0) {
      console.warn('Index benchmark warnings:')
      indexValidation.warnings.forEach((w) => console.warn(`  - ${w}`))
    }
  }

  // SMI-738: Run cache benchmarks
  if (suite === 'cache') {
    console.log('Running cache benchmarks...')
    const cacheBenchmark = new CacheBenchmark({
      iterations: iterations ?? 1000,
      enableMemoryProfiler: memory,
      memoryRegressionThreshold: memoryThreshold,
      memoryBaselines: memoryBaselines,
    })
    const cacheReport = await cacheBenchmark.run()
    results.push(cacheReport)

    const cacheValidation = validateCacheResults(cacheReport)
    if (!cacheValidation.passed) {
      console.error('Cache benchmark failures:')
      cacheValidation.failures.forEach((f) => console.error(`  - ${f}`))
    }
    if (cacheValidation.warnings.length > 0) {
      console.warn('Cache benchmark warnings:')
      cacheValidation.warnings.forEach((w) => console.warn(`  - ${w}`))
    }
  }

  // SMI-738: Run embedding benchmarks
  if (suite === 'embedding') {
    console.log('Running embedding benchmarks...')
    const embeddingBenchmark = new EmbeddingBenchmark({
      iterations: iterations ?? 50,
      skipModelLoad: true, // Skip slow model load by default
      enableMemoryProfiler: memory,
      memoryRegressionThreshold: memoryThreshold,
      memoryBaselines: memoryBaselines,
    })
    const embeddingReport = await embeddingBenchmark.run()
    results.push(embeddingReport)

    const embeddingValidation = validateEmbeddingResults(embeddingReport)
    if (!embeddingValidation.passed) {
      console.error('Embedding benchmark failures:')
      embeddingValidation.failures.forEach((f) => console.error(`  - ${f}`))
    }
    if (embeddingValidation.warnings.length > 0) {
      console.warn('Embedding benchmark warnings:')
      embeddingValidation.warnings.forEach((w) => console.warn(`  - ${w}`))
    }
  }

  // Output results
  for (const report of results) {
    if (output === 'json') {
      console.log(formatReportAsJson(report))
    } else {
      console.log(formatReportAsText(report))
    }
  }

  // Compare with baseline if provided
  if (compare) {
    console.log('\nComparing with baseline...')
    const fs = await import('fs')
    const baselineData = fs.readFileSync(compare, 'utf-8')
    const baseline = JSON.parse(baselineData) as BenchmarkReport

    for (const report of results) {
      if (report.suite === baseline.suite) {
        const comparison = compareReports(baseline, report)
        console.log(`\nComparison for ${report.suite}:`)
        console.log(`  Regressions: ${comparison.summary.regressions}`)
        console.log(`  Improvements: ${comparison.summary.improvements}`)
        console.log(`  Unchanged: ${comparison.summary.unchanged}`)

        if (comparison.summary.regressions > 0) {
          console.error('\nRegression details:')
          for (const [name, comp] of Object.entries(comparison.comparisons)) {
            if (comp.isRegression) {
              console.error(`  ${name}: p95 increased by ${comp.p95ChangePercent}%`)
            }
          }
          process.exitCode = 1
        }
      }
    }
  }

  // SMI-689: Check for memory regressions
  if (memory) {
    let hasMemoryRegression = false
    for (const report of results) {
      if (report.memoryRegression?.hasRegressions) {
        hasMemoryRegression = true
        console.error(`\nMemory regression detected in ${report.suite}:`)
        for (const reg of report.memoryRegression.regressions) {
          console.error(`  ${reg.label}: heap grew by ${reg.changePercent.toFixed(1)}%`)
        }
      }
    }
    if (hasMemoryRegression) {
      process.exitCode = 1
    }
  }
}

/**
 * CLI options for benchmark runner
 */
export interface CLIOptions {
  /** Run specific suite (search, index, cache, embedding) */
  suite?: 'search' | 'index' | 'cache' | 'embedding'
  /** Path to baseline JSON for comparison */
  compare?: string
  /** Output format (text, json) */
  output?: 'text' | 'json'
  /** Number of iterations (overrides default) */
  iterations?: number
  /** SMI-689: Enable memory profiling */
  memory?: boolean
  /** SMI-689: Memory regression threshold percentage */
  memoryThreshold?: number
  /** SMI-689: Path to memory baselines JSON file */
  memoryBaseline?: string
}

// Re-export everything for convenience
import { SearchBenchmark, validateSearchResults } from './SearchBenchmark.js'
import { IndexBenchmark, validateIndexResults } from './IndexBenchmark.js'
import { CacheBenchmark, validateCacheResults } from './cacheBenchmark.js'
import { EmbeddingBenchmark, validateEmbeddingResults } from './embeddingBenchmark.js'
import {
  type BenchmarkReport,
  formatReportAsJson,
  formatReportAsText,
  compareReports,
} from './BenchmarkRunner.js'
