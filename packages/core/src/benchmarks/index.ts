/**
 * SMI-632: Benchmark module exports
 *
 * Provides performance benchmarking infrastructure for:
 * - Search query latency
 * - Indexing throughput
 * - Statistical analysis
 * - CI integration
 */

// Core benchmark runner
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
  formatReportAsJson,
  formatReportAsText,
  compareReports,
} from './BenchmarkRunner.js'

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
  const { suite, compare, output = 'text', iterations } = options

  console.log('Starting Skillsmith Performance Benchmarks\n')

  const results: BenchmarkReport[] = []

  // Run search benchmarks
  if (!suite || suite === 'search') {
    console.log('Running search benchmarks...')
    const searchBenchmark = new SearchBenchmark({
      iterations: iterations ?? 1000,
      skillCount: 1000,
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
    const indexBenchmark = new IndexBenchmark({
      iterations: iterations ?? 100,
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
}

/**
 * CLI options for benchmark runner
 */
export interface CLIOptions {
  /** Run specific suite (search, index) */
  suite?: 'search' | 'index'
  /** Path to baseline JSON for comparison */
  compare?: string
  /** Output format (text, json) */
  output?: 'text' | 'json'
  /** Number of iterations (overrides default) */
  iterations?: number
}

// Re-export everything for convenience
import { SearchBenchmark, validateSearchResults } from './SearchBenchmark.js'
import { IndexBenchmark, validateIndexResults } from './IndexBenchmark.js'
import {
  type BenchmarkReport,
  formatReportAsJson,
  formatReportAsText,
  compareReports,
} from './BenchmarkRunner.js'
