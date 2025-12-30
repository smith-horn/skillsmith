/**
 * SMI-739: Custom Metrics Registration
 * SMI-755: Graceful fallback when OpenTelemetry unavailable
 *
 * Provides metrics collection for Skillsmith operations:
 * - Request latency histograms
 * - Cache hit/miss counters
 * - Error rate counters
 * - Active operations gauges
 *
 * Configuration:
 * - OTEL_EXPORTER_OTLP_ENDPOINT: OTLP endpoint for metrics export
 * - SKILLSMITH_TELEMETRY_ENABLED: Master switch for all telemetry (default: auto)
 * - SKILLSMITH_METRICS_ENABLED: Enable/disable metrics (default: true if endpoint set)
 *
 * Graceful Fallback:
 * - If OpenTelemetry packages are not installed, uses in-memory implementations
 * - Metrics APIs remain functional for local statistics
 */

/** Whether OpenTelemetry packages are available */
let otelAvailable: boolean | null = null

/**
 * Dynamic import helper that bypasses TypeScript type checking (SMI-755)
 */
async function dynamicImport(moduleName: string): Promise<unknown> {
  try {
    const importFn = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>
    return await importFn(moduleName)
  } catch {
    return null
  }
}

/**
 * Check if OpenTelemetry is available (SMI-755)
 */
async function checkOTelAvailability(): Promise<boolean> {
  if (otelAvailable !== null) return otelAvailable

  const result = await dynamicImport('@opentelemetry/api')
  otelAvailable = result !== null
  return otelAvailable
}

/**
 * Metric types
 */
export type MetricType = 'counter' | 'histogram' | 'gauge'

/**
 * Metrics configuration
 */
export interface MetricsConfig {
  /** Service name for metrics (default: skillsmith) */
  serviceName?: string
  /** OTLP endpoint URL */
  endpoint?: string
  /** Export interval in ms (default: 60000) */
  exportIntervalMs?: number
  /** Enable console export for debugging (default: false) */
  consoleExport?: boolean
}

/**
 * Histogram bucket boundaries for latency metrics
 */
export const LATENCY_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

/**
 * Metric labels/attributes
 */
export interface MetricLabels {
  [key: string]: string | number | boolean
}

/**
 * Counter metric interface
 */
export interface Counter {
  /** Add a value to the counter */
  add(value: number, labels?: MetricLabels): void
  /** Increment by 1 */
  increment(labels?: MetricLabels): void
}

/**
 * Histogram metric interface
 */
export interface Histogram {
  /** Record a value */
  record(value: number, labels?: MetricLabels): void
}

/**
 * Gauge metric interface
 */
export interface Gauge {
  /** Set the gauge value */
  set(value: number, labels?: MetricLabels): void
  /** Get the current value (if tracked) */
  getValue(labels?: MetricLabels): number
}

/**
 * No-op gauge implementation (used for gauges that track values locally)
 */
class NoOpGauge implements Gauge {
  private values = new Map<string, number>()

  set(value: number, labels?: MetricLabels): void {
    const key = labels ? JSON.stringify(labels) : ''
    this.values.set(key, value)
  }

  getValue(labels?: MetricLabels): number {
    const key = labels ? JSON.stringify(labels) : ''
    return this.values.get(key) ?? 0
  }
}

/**
 * In-memory counter for when OTEL is not available
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
}

/**
 * In-memory histogram for when OTEL is not available
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
}

/**
 * Skillsmith Metrics Registry
 */
export class MetricsRegistry {
  private counters = new Map<string, Counter>()
  private histograms = new Map<string, Histogram>()
  private gauges = new Map<string, Gauge>()
  private enabled = false
  private initialized = false
  private config: Required<MetricsConfig>

  // Predefined metrics
  readonly mcpRequestLatency: Histogram
  readonly mcpRequestCount: Counter
  readonly mcpErrorCount: Counter
  readonly dbQueryLatency: Histogram
  readonly dbQueryCount: Counter
  readonly cacheHits: Counter
  readonly cacheMisses: Counter
  readonly cacheSize: Gauge
  readonly embeddingLatency: Histogram
  readonly embeddingCount: Counter
  readonly searchLatency: Histogram
  readonly searchCount: Counter
  readonly activeOperations: Gauge

  constructor(config: MetricsConfig = {}) {
    this.config = {
      serviceName: config.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'skillsmith',
      endpoint: config.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
      exportIntervalMs: config.exportIntervalMs ?? 60000,
      consoleExport: config.consoleExport ?? false,
    }

    // SMI-755: Check master telemetry switch first
    const telemetryDisabled = process.env.SKILLSMITH_TELEMETRY_ENABLED === 'false'
    if (telemetryDisabled) {
      this.enabled = false
      // Still create in-memory metrics for local use, just skip OTEL export
      // Skip further enable checks - master switch overrides all
    } else {
      // Check if metrics should be enabled
      const explicitlyEnabled = process.env.SKILLSMITH_METRICS_ENABLED === 'true'
      const explicitlyDisabled = process.env.SKILLSMITH_METRICS_ENABLED === 'false'

      if (explicitlyDisabled) {
        this.enabled = false
      } else if (explicitlyEnabled || this.config.endpoint || this.config.consoleExport) {
        this.enabled = true
      }
    }

    // Create predefined metrics
    this.mcpRequestLatency = this.createHistogram('skillsmith.mcp.request.latency', {
      description: 'Latency of MCP tool requests in milliseconds',
      unit: 'ms',
    })

    this.mcpRequestCount = this.createCounter('skillsmith.mcp.request.count', {
      description: 'Total number of MCP tool requests',
    })

    this.mcpErrorCount = this.createCounter('skillsmith.mcp.error.count', {
      description: 'Total number of MCP tool errors',
    })

    this.dbQueryLatency = this.createHistogram('skillsmith.db.query.latency', {
      description: 'Latency of database queries in milliseconds',
      unit: 'ms',
    })

    this.dbQueryCount = this.createCounter('skillsmith.db.query.count', {
      description: 'Total number of database queries',
    })

    this.cacheHits = this.createCounter('skillsmith.cache.hits', {
      description: 'Total number of cache hits',
    })

    this.cacheMisses = this.createCounter('skillsmith.cache.misses', {
      description: 'Total number of cache misses',
    })

    this.cacheSize = this.createGauge('skillsmith.cache.size', {
      description: 'Current cache size in entries',
    })

    this.embeddingLatency = this.createHistogram('skillsmith.embedding.latency', {
      description: 'Latency of embedding generation in milliseconds',
      unit: 'ms',
    })

    this.embeddingCount = this.createCounter('skillsmith.embedding.count', {
      description: 'Total number of embeddings generated',
    })

    this.searchLatency = this.createHistogram('skillsmith.search.latency', {
      description: 'Latency of search operations in milliseconds',
      unit: 'ms',
    })

    this.searchCount = this.createCounter('skillsmith.search.count', {
      description: 'Total number of search operations',
    })

    this.activeOperations = this.createGauge('skillsmith.operations.active', {
      description: 'Number of currently active operations',
    })
  }

  /**
   * Initialize metrics collection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    if (!this.enabled) {
      this.initialized = true
      return
    }

    // SMI-755: Check if OpenTelemetry is available before attempting to load
    const isAvailable = await checkOTelAvailability()
    if (!isAvailable) {
      // Metrics still work via in-memory implementations, just log info
      console.info(
        '[Skillsmith Metrics] OpenTelemetry not installed. ' +
          'Using in-memory metrics (available via getSnapshot()).'
      )
      this.initialized = true
      return
    }

    try {
      // SMI-755: Lazy load OTEL metrics API with error handling
      // Note: Full OTEL metrics setup would require additional SDK initialization
      // For now, we use in-memory metrics that can be exported via the stats endpoint
      await dynamicImport('@opentelemetry/api')
      this.initialized = true
    } catch (error) {
      console.warn('[Skillsmith Metrics] Failed to initialize OpenTelemetry:', error)
      this.enabled = false
      this.initialized = true
    }
  }

  /**
   * Check if metrics are enabled
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Create a counter metric
   */
  createCounter(name: string, _options?: { description?: string; unit?: string }): Counter {
    if (this.counters.has(name)) {
      return this.counters.get(name)!
    }

    // Use in-memory counter for now
    const counter = new InMemoryCounter()
    this.counters.set(name, counter)
    return counter
  }

  /**
   * Create a histogram metric
   */
  createHistogram(
    name: string,
    _options?: { description?: string; unit?: string; buckets?: number[] }
  ): Histogram {
    if (this.histograms.has(name)) {
      return this.histograms.get(name)!
    }

    // Use in-memory histogram for now
    const histogram = new InMemoryHistogram()
    this.histograms.set(name, histogram)
    return histogram
  }

  /**
   * Create a gauge metric
   */
  createGauge(name: string, _options?: { description?: string; unit?: string }): Gauge {
    if (this.gauges.has(name)) {
      return this.gauges.get(name)!
    }

    // Use no-op gauge that tracks values
    const gauge = new NoOpGauge()
    this.gauges.set(name, gauge)
    return gauge
  }

  /**
   * Get current cache hit ratio
   */
  getCacheHitRatio(): number {
    const hits = this.counters.get('skillsmith.cache.hits') as InMemoryCounter | undefined
    const misses = this.counters.get('skillsmith.cache.misses') as InMemoryCounter | undefined

    if (!hits || !misses) return 0

    const hitValues = hits.getValues()
    const missValues = misses.getValues()

    let totalHits = 0
    let totalMisses = 0

    for (const [, count] of hitValues) {
      totalHits += count
    }
    for (const [, count] of missValues) {
      totalMisses += count
    }

    const total = totalHits + totalMisses
    return total > 0 ? totalHits / total : 0
  }

  /**
   * Get all metrics as a snapshot
   */
  getSnapshot(): MetricsSnapshot {
    const snapshot: MetricsSnapshot = {
      timestamp: new Date().toISOString(),
      counters: {},
      histograms: {},
      gauges: {},
    }

    // Collect counter values
    for (const [name, counter] of this.counters) {
      if (counter instanceof InMemoryCounter) {
        const values = counter.getValues()
        let total = 0
        for (const [, count] of values) {
          total += count
        }
        snapshot.counters[name] = total
      }
    }

    // Collect histogram stats
    for (const [name, histogram] of this.histograms) {
      if (histogram instanceof InMemoryHistogram) {
        snapshot.histograms[name] = histogram.getStats()
      }
    }

    // Collect gauge values
    for (const [name, gauge] of this.gauges) {
      snapshot.gauges[name] = gauge.getValue()
    }

    return snapshot
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    // Recreate all metrics
    for (const [name] of this.counters) {
      this.counters.set(name, new InMemoryCounter())
    }
    for (const [name] of this.histograms) {
      this.histograms.set(name, new InMemoryHistogram())
    }
    for (const [name] of this.gauges) {
      this.gauges.set(name, new NoOpGauge())
    }
  }
}

/**
 * Metrics snapshot for export
 */
export interface MetricsSnapshot {
  timestamp: string
  counters: Record<string, number>
  histograms: Record<
    string,
    { count: number; sum: number; mean: number; p50: number; p95: number; p99: number }
  >
  gauges: Record<string, number>
}

// Default metrics registry instance
let defaultRegistry: MetricsRegistry | null = null

/**
 * Get the default metrics registry
 */
export function getMetrics(): MetricsRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new MetricsRegistry()
  }
  return defaultRegistry
}

/**
 * Initialize the default metrics registry
 */
export async function initializeMetrics(config?: MetricsConfig): Promise<MetricsRegistry> {
  if (defaultRegistry) {
    defaultRegistry.reset()
  }
  defaultRegistry = new MetricsRegistry(config)
  await defaultRegistry.initialize()
  return defaultRegistry
}

/**
 * Helper: Time an async operation and record to histogram
 */
export async function timeAsync<T>(
  histogram: Histogram,
  fn: () => Promise<T>,
  labels?: MetricLabels
): Promise<T> {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    const duration = performance.now() - start
    histogram.record(duration, labels)
  }
}

/**
 * Helper: Time a sync operation and record to histogram
 */
export function timeSync<T>(histogram: Histogram, fn: () => T, labels?: MetricLabels): T {
  const start = performance.now()
  try {
    return fn()
  } finally {
    const duration = performance.now() - start
    histogram.record(duration, labels)
  }
}
