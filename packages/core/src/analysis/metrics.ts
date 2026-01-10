/**
 * SMI-1337: Analysis Pipeline Metrics and Telemetry
 *
 * Provides metrics collection for the multi-language analysis pipeline:
 * - Files parsed per language (counter)
 * - Parse duration by language (histogram)
 * - Cache hit/miss rates (gauge)
 * - Worker pool utilization (gauge)
 * - Memory usage (gauge)
 * - Error counts by type (counter)
 *
 * Configuration:
 * - SKILLSMITH_TELEMETRY_ENABLED: Master switch for all telemetry (default: auto)
 * - SKILLSMITH_ANALYSIS_METRICS_ENABLED: Enable/disable analysis metrics (default: true)
 *
 * Graceful Fallback:
 * - If OpenTelemetry packages are not installed, uses in-memory implementations
 * - Metrics APIs remain functional for local statistics
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/metrics
 */

import type { Counter, Histogram, Gauge, MetricLabels } from '../telemetry/metrics.js'
import type { SupportedLanguage } from './types.js'

/**
 * Analysis metrics configuration
 */
export interface AnalysisMetricsConfig {
  /** Whether to enable metrics collection (default: true) */
  enabled?: boolean
  /** Prefix for all metric names (default: skillsmith.analysis) */
  metricPrefix?: string
}

/**
 * In-memory counter implementation
 */
class InMemoryCounter implements Counter {
  private values = new Map<string, number>()

  add(value: number, labels?: MetricLabels): void {
    const key = labels ? JSON.stringify(labels) : ''
    const current = this.values.get(key) ?? 0
    this.values.set(key, current + value)
  }

  increment(labels?: MetricLabels): void {
    this.add(1, labels)
  }

  getValues(): Map<string, number> {
    return new Map(this.values)
  }

  getTotal(): number {
    let total = 0
    for (const count of this.values.values()) {
      total += count
    }
    return total
  }

  reset(): void {
    this.values.clear()
  }
}

/**
 * In-memory histogram implementation
 */
class InMemoryHistogram implements Histogram {
  private values: number[] = []
  private labeledValues = new Map<string, number[]>()

  record(value: number, labels?: MetricLabels): void {
    this.values.push(value)
    if (labels) {
      const key = JSON.stringify(labels)
      const arr = this.labeledValues.get(key) ?? []
      arr.push(value)
      this.labeledValues.set(key, arr)
    }
  }

  getStats(): { count: number; sum: number; mean: number; p50: number; p95: number; p99: number } {
    if (this.values.length === 0) {
      return { count: 0, sum: 0, mean: 0, p50: 0, p95: 0, p99: 0 }
    }

    const sorted = [...this.values].sort((a, b) => a - b)
    const sum = sorted.reduce((acc, v) => acc + v, 0)
    const mean = sum / sorted.length

    const percentile = (p: number): number => {
      const index = Math.ceil((p / 100) * sorted.length) - 1
      return sorted[Math.max(0, index)]
    }

    return {
      count: sorted.length,
      sum,
      mean,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
    }
  }

  getStatsByLabel(labels: MetricLabels): ReturnType<typeof this.getStats> {
    const key = JSON.stringify(labels)
    const values = this.labeledValues.get(key) ?? []

    if (values.length === 0) {
      return { count: 0, sum: 0, mean: 0, p50: 0, p95: 0, p99: 0 }
    }

    const sorted = [...values].sort((a, b) => a - b)
    const sum = sorted.reduce((acc, v) => acc + v, 0)
    const mean = sum / sorted.length

    const percentile = (p: number): number => {
      const index = Math.ceil((p / 100) * sorted.length) - 1
      return sorted[Math.max(0, index)]
    }

    return {
      count: sorted.length,
      sum,
      mean,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
    }
  }

  reset(): void {
    this.values = []
    this.labeledValues.clear()
  }
}

/**
 * In-memory gauge implementation
 */
class InMemoryGauge implements Gauge {
  private values = new Map<string, number>()

  set(value: number, labels?: MetricLabels): void {
    const key = labels ? JSON.stringify(labels) : ''
    this.values.set(key, value)
  }

  getValue(labels?: MetricLabels): number {
    const key = labels ? JSON.stringify(labels) : ''
    return this.values.get(key) ?? 0
  }

  getAllValues(): Map<string, number> {
    return new Map(this.values)
  }

  reset(): void {
    this.values.clear()
  }
}

/**
 * Analysis metrics snapshot for export
 */
export interface AnalysisMetricsSnapshot {
  timestamp: string
  filesParsed: {
    total: number
    byLanguage: Record<string, number>
  }
  parseDuration: {
    stats: { count: number; sum: number; mean: number; p50: number; p95: number; p99: number }
    byLanguage: Record<
      string,
      { count: number; sum: number; mean: number; p50: number; p95: number; p99: number }
    >
  }
  cache: {
    hits: number
    misses: number
    hitRate: number
    size: number
  }
  workerPool: {
    activeWorkers: number
    queuedTasks: number
    utilization: number
  }
  memory: {
    heapUsed: number
    heapTotal: number
    rss: number
  }
  errors: {
    total: number
    byType: Record<string, number>
  }
  aggregator: {
    filesProcessed: number
    totalImports: number
    totalExports: number
    totalFunctions: number
  }
}

/**
 * Analysis Pipeline Metrics Collector
 *
 * Provides comprehensive metrics collection for the multi-language
 * analysis pipeline with graceful fallback when telemetry is unavailable.
 *
 * @example
 * ```typescript
 * const metrics = new AnalysisMetrics()
 *
 * // Record file parse
 * metrics.recordFileParsed('typescript')
 *
 * // Record parse duration
 * metrics.recordParseDuration('typescript', 15.5)
 *
 * // Record cache operations
 * metrics.recordCacheHit()
 * metrics.recordCacheMiss()
 *
 * // Get snapshot
 * const snapshot = metrics.getSnapshot()
 * console.log(`Parse p95: ${snapshot.parseDuration.stats.p95}ms`)
 * ```
 */
export class AnalysisMetrics {
  private readonly enabled: boolean
  private readonly prefix: string

  // File parsing metrics
  readonly filesParsed: InMemoryCounter
  readonly parseDuration: InMemoryHistogram

  // Cache metrics
  readonly cacheHits: InMemoryCounter
  readonly cacheMisses: InMemoryCounter
  readonly cacheSize: InMemoryGauge

  // Worker pool metrics
  readonly workerPoolActive: InMemoryGauge
  readonly workerPoolQueued: InMemoryGauge
  readonly workerPoolUtilization: InMemoryGauge

  // Memory metrics
  readonly memoryHeapUsed: InMemoryGauge
  readonly memoryHeapTotal: InMemoryGauge
  readonly memoryRss: InMemoryGauge

  // Error metrics
  readonly errorCount: InMemoryCounter

  // Aggregator metrics
  readonly aggregatorFilesProcessed: InMemoryGauge
  readonly aggregatorImports: InMemoryGauge
  readonly aggregatorExports: InMemoryGauge
  readonly aggregatorFunctions: InMemoryGauge

  constructor(config: AnalysisMetricsConfig = {}) {
    // Check master telemetry switch
    const telemetryDisabled = process.env.SKILLSMITH_TELEMETRY_ENABLED === 'false'
    const metricsDisabled = process.env.SKILLSMITH_ANALYSIS_METRICS_ENABLED === 'false'

    this.enabled = config.enabled !== false && !telemetryDisabled && !metricsDisabled
    this.prefix = config.metricPrefix ?? 'skillsmith.analysis'

    // Initialize all metrics
    this.filesParsed = new InMemoryCounter()
    this.parseDuration = new InMemoryHistogram()

    this.cacheHits = new InMemoryCounter()
    this.cacheMisses = new InMemoryCounter()
    this.cacheSize = new InMemoryGauge()

    this.workerPoolActive = new InMemoryGauge()
    this.workerPoolQueued = new InMemoryGauge()
    this.workerPoolUtilization = new InMemoryGauge()

    this.memoryHeapUsed = new InMemoryGauge()
    this.memoryHeapTotal = new InMemoryGauge()
    this.memoryRss = new InMemoryGauge()

    this.errorCount = new InMemoryCounter()

    this.aggregatorFilesProcessed = new InMemoryGauge()
    this.aggregatorImports = new InMemoryGauge()
    this.aggregatorExports = new InMemoryGauge()
    this.aggregatorFunctions = new InMemoryGauge()
  }

  /**
   * Check if metrics collection is enabled
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Record a file being parsed
   *
   * @param language - The language of the parsed file
   */
  recordFileParsed(language: SupportedLanguage | string): void {
    if (!this.enabled) return
    this.filesParsed.increment({ language })
  }

  /**
   * Record parse duration for a file
   *
   * @param language - The language of the parsed file
   * @param durationMs - Parse duration in milliseconds
   */
  recordParseDuration(language: SupportedLanguage | string, durationMs: number): void {
    if (!this.enabled) return
    this.parseDuration.record(durationMs, { language })
  }

  /**
   * Record a cache hit
   *
   * @param language - Optional language for the cache hit
   */
  recordCacheHit(language?: SupportedLanguage | string): void {
    if (!this.enabled) return
    this.cacheHits.increment(language ? { language } : undefined)
  }

  /**
   * Record a cache miss
   *
   * @param language - Optional language for the cache miss
   */
  recordCacheMiss(language?: SupportedLanguage | string): void {
    if (!this.enabled) return
    this.cacheMisses.increment(language ? { language } : undefined)
  }

  /**
   * Update cache size
   *
   * @param size - Current cache size in bytes
   * @param entries - Current number of cache entries
   */
  updateCacheSize(size: number, entries?: number): void {
    if (!this.enabled) return
    this.cacheSize.set(size)
    if (entries !== undefined) {
      this.cacheSize.set(entries, { metric: 'entries' })
    }
  }

  /**
   * Update worker pool metrics
   *
   * @param activeWorkers - Number of currently active workers
   * @param queuedTasks - Number of tasks waiting in queue
   * @param poolSize - Total pool size for utilization calculation
   */
  updateWorkerPool(activeWorkers: number, queuedTasks: number, poolSize?: number): void {
    if (!this.enabled) return
    this.workerPoolActive.set(activeWorkers)
    this.workerPoolQueued.set(queuedTasks)
    if (poolSize && poolSize > 0) {
      this.workerPoolUtilization.set(activeWorkers / poolSize)
    }
  }

  /**
   * Update memory usage metrics
   *
   * Records current Node.js memory usage stats.
   */
  updateMemoryUsage(): void {
    if (!this.enabled) return
    const usage = process.memoryUsage()
    this.memoryHeapUsed.set(usage.heapUsed)
    this.memoryHeapTotal.set(usage.heapTotal)
    this.memoryRss.set(usage.rss)
  }

  /**
   * Record an error
   *
   * @param errorType - Type/category of the error
   * @param language - Optional language context
   */
  recordError(errorType: string, language?: SupportedLanguage | string): void {
    if (!this.enabled) return
    const labels: MetricLabels = { errorType }
    if (language) {
      labels.language = language
    }
    this.errorCount.increment(labels)
  }

  /**
   * Update aggregator metrics
   *
   * @param filesProcessed - Number of files processed
   * @param imports - Total imports found
   * @param exports - Total exports found
   * @param functions - Total functions found
   */
  updateAggregatorStats(
    filesProcessed: number,
    imports: number,
    exports: number,
    functions: number
  ): void {
    if (!this.enabled) return
    this.aggregatorFilesProcessed.set(filesProcessed)
    this.aggregatorImports.set(imports)
    this.aggregatorExports.set(exports)
    this.aggregatorFunctions.set(functions)
  }

  /**
   * Get cache hit rate
   *
   * @returns Cache hit rate as a decimal (0-1)
   */
  getCacheHitRate(): number {
    const hits = this.cacheHits.getTotal()
    const misses = this.cacheMisses.getTotal()
    const total = hits + misses
    return total > 0 ? hits / total : 0
  }

  /**
   * Get files parsed by language
   *
   * @returns Map of language to count
   */
  getFilesByLanguage(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const [key, count] of this.filesParsed.getValues()) {
      if (key) {
        try {
          const labels = JSON.parse(key) as { language?: string }
          if (labels.language) {
            result[labels.language] = count
          }
        } catch {
          // Invalid key format, skip
        }
      }
    }
    return result
  }

  /**
   * Get parse duration stats by language
   *
   * @param language - Language to get stats for
   * @returns Duration statistics
   */
  getParseDurationByLanguage(
    language: SupportedLanguage | string
  ): ReturnType<InMemoryHistogram['getStats']> {
    return this.parseDuration.getStatsByLabel({ language })
  }

  /**
   * Get complete metrics snapshot
   *
   * @returns Snapshot of all current metrics
   */
  getSnapshot(): AnalysisMetricsSnapshot {
    const hits = this.cacheHits.getTotal()
    const misses = this.cacheMisses.getTotal()
    const cacheTotal = hits + misses

    // Build by-language parse stats
    const byLanguageStats: Record<
      string,
      { count: number; sum: number; mean: number; p50: number; p95: number; p99: number }
    > = {}
    const languages: SupportedLanguage[] = [
      'typescript',
      'javascript',
      'python',
      'go',
      'rust',
      'java',
    ]
    for (const lang of languages) {
      const stats = this.getParseDurationByLanguage(lang)
      if (stats.count > 0) {
        byLanguageStats[lang] = stats
      }
    }

    // Build error counts by type
    const errorsByType: Record<string, number> = {}
    for (const [key, count] of this.errorCount.getValues()) {
      if (key) {
        try {
          const labels = JSON.parse(key) as { errorType?: string }
          if (labels.errorType) {
            errorsByType[labels.errorType] = (errorsByType[labels.errorType] ?? 0) + count
          }
        } catch {
          // Invalid key format, skip
        }
      }
    }

    return {
      timestamp: new Date().toISOString(),
      filesParsed: {
        total: this.filesParsed.getTotal(),
        byLanguage: this.getFilesByLanguage(),
      },
      parseDuration: {
        stats: this.parseDuration.getStats(),
        byLanguage: byLanguageStats,
      },
      cache: {
        hits,
        misses,
        hitRate: cacheTotal > 0 ? hits / cacheTotal : 0,
        size: this.cacheSize.getValue(),
      },
      workerPool: {
        activeWorkers: this.workerPoolActive.getValue(),
        queuedTasks: this.workerPoolQueued.getValue(),
        utilization: this.workerPoolUtilization.getValue(),
      },
      memory: {
        heapUsed: this.memoryHeapUsed.getValue(),
        heapTotal: this.memoryHeapTotal.getValue(),
        rss: this.memoryRss.getValue(),
      },
      errors: {
        total: this.errorCount.getTotal(),
        byType: errorsByType,
      },
      aggregator: {
        filesProcessed: this.aggregatorFilesProcessed.getValue(),
        totalImports: this.aggregatorImports.getValue(),
        totalExports: this.aggregatorExports.getValue(),
        totalFunctions: this.aggregatorFunctions.getValue(),
      },
    }
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.filesParsed.reset()
    this.parseDuration.reset()
    this.cacheHits.reset()
    this.cacheMisses.reset()
    this.cacheSize.reset()
    this.workerPoolActive.reset()
    this.workerPoolQueued.reset()
    this.workerPoolUtilization.reset()
    this.memoryHeapUsed.reset()
    this.memoryHeapTotal.reset()
    this.memoryRss.reset()
    this.errorCount.reset()
    this.aggregatorFilesProcessed.reset()
    this.aggregatorImports.reset()
    this.aggregatorExports.reset()
    this.aggregatorFunctions.reset()
  }
}

// Default metrics instance
let defaultAnalysisMetrics: AnalysisMetrics | null = null

/**
 * Get the default analysis metrics instance
 *
 * @returns The shared AnalysisMetrics instance
 */
export function getAnalysisMetrics(): AnalysisMetrics {
  if (!defaultAnalysisMetrics) {
    defaultAnalysisMetrics = new AnalysisMetrics()
  }
  return defaultAnalysisMetrics
}

/**
 * Initialize the default analysis metrics instance
 *
 * @param config - Optional configuration
 * @returns The initialized AnalysisMetrics instance
 */
export function initializeAnalysisMetrics(config?: AnalysisMetricsConfig): AnalysisMetrics {
  if (defaultAnalysisMetrics) {
    defaultAnalysisMetrics.reset()
  }
  defaultAnalysisMetrics = new AnalysisMetrics(config)
  return defaultAnalysisMetrics
}

/**
 * Helper: Time an async operation and record to analysis metrics
 *
 * @param language - Language being parsed
 * @param fn - Async function to time
 * @param metrics - Optional metrics instance (uses default if not provided)
 * @returns Result of the function
 */
export async function timeParseAsync<T>(
  language: SupportedLanguage | string,
  fn: () => Promise<T>,
  metrics?: AnalysisMetrics
): Promise<T> {
  const m = metrics ?? getAnalysisMetrics()
  const start = performance.now()
  try {
    const result = await fn()
    m.recordFileParsed(language)
    return result
  } finally {
    const duration = performance.now() - start
    m.recordParseDuration(language, duration)
  }
}

/**
 * Helper: Time a sync operation and record to analysis metrics
 *
 * @param language - Language being parsed
 * @param fn - Function to time
 * @param metrics - Optional metrics instance (uses default if not provided)
 * @returns Result of the function
 */
export function timeParseSync<T>(
  language: SupportedLanguage | string,
  fn: () => T,
  metrics?: AnalysisMetrics
): T {
  const m = metrics ?? getAnalysisMetrics()
  const start = performance.now()
  try {
    const result = fn()
    m.recordFileParsed(language)
    return result
  } finally {
    const duration = performance.now() - start
    m.recordParseDuration(language, duration)
  }
}
