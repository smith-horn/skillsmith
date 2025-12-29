/**
 * SMI-739: Telemetry Module Exports
 *
 * Provides OpenTelemetry tracing and metrics for Skillsmith:
 * - Distributed tracing for request flows
 * - Custom metrics for performance monitoring
 * - Graceful fallback when tracing is disabled
 */

// Tracer exports
export {
  SkillsmithTracer,
  getTracer,
  initializeTracing,
  shutdownTracing,
  traced,
  type TracerConfig,
  type SpanAttributes,
  type SpanWrapper,
} from './tracer.js'

// Metrics exports
export {
  MetricsRegistry,
  getMetrics,
  initializeMetrics,
  timeAsync,
  timeSync,
  LATENCY_BUCKETS,
  type MetricsConfig,
  type MetricLabels,
  type Counter,
  type Histogram,
  type Gauge,
  type MetricsSnapshot,
} from './metrics.js'

/**
 * Initialize all telemetry (tracing + metrics)
 * Call this at application startup
 */
export async function initializeTelemetry(config?: {
  tracing?: import('./tracer.js').TracerConfig
  metrics?: import('./metrics.js').MetricsConfig
}): Promise<void> {
  const { initializeTracing } = await import('./tracer.js')
  const { initializeMetrics } = await import('./metrics.js')

  await Promise.all([initializeTracing(config?.tracing), initializeMetrics(config?.metrics)])
}

/**
 * Shutdown all telemetry
 * Call this at application shutdown
 */
export async function shutdownTelemetry(): Promise<void> {
  const { shutdownTracing } = await import('./tracer.js')
  await shutdownTracing()
}
