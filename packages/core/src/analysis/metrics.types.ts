/**
 * Analysis Metrics Types
 * @module analysis/metrics.types
 */

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
 * Histogram statistics
 */
export interface HistogramStats {
  count: number
  sum: number
  mean: number
  p50: number
  p95: number
  p99: number
}
