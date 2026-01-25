/**
 * SMI-739: Custom Metrics Registration
 * SMI-755: Graceful fallback when OpenTelemetry unavailable
 *
 * Provides metrics collection for Skillsmith operations.
 *
 * @see metric-types.ts for type definitions
 * @see metric-helpers.ts for helper classes
 */

// Re-export types
export type {
  MetricType,
  MetricsConfig,
  MetricLabels,
  Counter,
  Histogram,
  Gauge,
  MetricsSnapshot,
} from './metric-types.js'

export { LATENCY_BUCKETS } from './metric-types.js'

// Import types and helpers
import type { Counter, Histogram, Gauge, MetricsConfig, MetricsSnapshot } from './metric-types.js'
import {
  checkOTelAvailability,
  dynamicImport,
  NoOpGauge,
  InMemoryCounter,
  InMemoryHistogram,
} from './metric-helpers.js'

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

    const telemetryDisabled = process.env.SKILLSMITH_TELEMETRY_ENABLED === 'false'
    if (telemetryDisabled) {
      this.enabled = false
    } else {
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

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.enabled) {
      this.initialized = true
      return
    }

    const isAvailable = await checkOTelAvailability()
    if (!isAvailable) {
      console.info(
        '[Skillsmith Metrics] OpenTelemetry not installed. Using in-memory metrics (available via getSnapshot()).'
      )
      this.initialized = true
      return
    }

    try {
      await dynamicImport('@opentelemetry/api')
      this.initialized = true
    } catch (error) {
      console.warn('[Skillsmith Metrics] Failed to initialize OpenTelemetry:', error)
      this.enabled = false
      this.initialized = true
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  createCounter(name: string, _options?: { description?: string; unit?: string }): Counter {
    if (this.counters.has(name)) return this.counters.get(name)!
    const counter = new InMemoryCounter()
    this.counters.set(name, counter)
    return counter
  }

  createHistogram(
    name: string,
    _options?: { description?: string; unit?: string; buckets?: number[] }
  ): Histogram {
    if (this.histograms.has(name)) return this.histograms.get(name)!
    const histogram = new InMemoryHistogram()
    this.histograms.set(name, histogram)
    return histogram
  }

  createGauge(name: string, _options?: { description?: string; unit?: string }): Gauge {
    if (this.gauges.has(name)) return this.gauges.get(name)!
    const gauge = new NoOpGauge()
    this.gauges.set(name, gauge)
    return gauge
  }

  getCacheHitRatio(): number {
    const hits = this.counters.get('skillsmith.cache.hits') as InMemoryCounter | undefined
    const misses = this.counters.get('skillsmith.cache.misses') as InMemoryCounter | undefined
    if (!hits || !misses) return 0

    let totalHits = 0,
      totalMisses = 0
    for (const [, count] of hits.getValues()) totalHits += count
    for (const [, count] of misses.getValues()) totalMisses += count

    const total = totalHits + totalMisses
    return total > 0 ? totalHits / total : 0
  }

  getSnapshot(): MetricsSnapshot {
    const snapshot: MetricsSnapshot = {
      timestamp: new Date().toISOString(),
      counters: {},
      histograms: {},
      gauges: {},
    }

    for (const [name, counter] of this.counters) {
      if (counter instanceof InMemoryCounter) {
        let total = 0
        for (const [, count] of counter.getValues()) total += count
        snapshot.counters[name] = total
      }
    }

    for (const [name, histogram] of this.histograms) {
      if (histogram instanceof InMemoryHistogram) {
        snapshot.histograms[name] = histogram.getStats()
      }
    }

    for (const [name, gauge] of this.gauges) {
      snapshot.gauges[name] = gauge.getValue()
    }

    return snapshot
  }

  reset(): void {
    for (const [name] of this.counters) this.counters.set(name, new InMemoryCounter())
    for (const [name] of this.histograms) this.histograms.set(name, new InMemoryHistogram())
    for (const [name] of this.gauges) this.gauges.set(name, new NoOpGauge())
  }
}

// Default metrics registry instance
let defaultRegistry: MetricsRegistry | null = null

export function getMetrics(): MetricsRegistry {
  if (!defaultRegistry) defaultRegistry = new MetricsRegistry()
  return defaultRegistry
}

export async function initializeMetrics(config?: MetricsConfig): Promise<MetricsRegistry> {
  if (defaultRegistry) defaultRegistry.reset()
  defaultRegistry = new MetricsRegistry(config)
  await defaultRegistry.initialize()
  return defaultRegistry
}

export async function timeAsync<T>(
  histogram: Histogram,
  fn: () => Promise<T>,
  labels?: Record<string, string | number | boolean>
): Promise<T> {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    histogram.record(performance.now() - start, labels)
  }
}

export function timeSync<T>(
  histogram: Histogram,
  fn: () => T,
  labels?: Record<string, string | number | boolean>
): T {
  const start = performance.now()
  try {
    return fn()
  } finally {
    histogram.record(performance.now() - start, labels)
  }
}
