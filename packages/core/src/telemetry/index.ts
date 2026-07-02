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

// Prometheus exports (SMI-1018)
export {
  exportToPrometheus,
  getPrometheusMetrics,
  createPrometheusHandler,
  type PrometheusExportOptions,
} from './prometheus.js'

// PostHog exports (SMI-1184)
export {
  initializePostHog,
  shutdownPostHog,
  flushPostHog,
  trackEvent,
  trackSkillSearch,
  trackSkillView,
  trackSkillInstall,
  trackSkillInvoke,
  trackApiError,
  identifyUser,
  isFeatureFlagEnabled,
  getPostHog,
  isPostHogEnabled,
  ALLOWED_TRAITS,
  type PostHogConfig,
  type SkillsmithEventType,
  type SkillEventProperties,
  type TrackSkillInvokeParams,
  type AllowedUserTraits,
} from './posthog.js'

// In-process HOF + registry (SMI-5016)
// Emission gate (SMI-5019 wire-in) — privacy-safe default-suppress.
// Marker context (SMI-5456) — AsyncLocalStorage-scoped agent-mediation marker.
export {
  withTelemetry,
  isTelemetered,
  setEmissionGate,
  runWithMarkerContext,
  type WithTelemetryOpts,
} from './wrap.js'

// Agent-mediation marker channel (SMI-5456) — `_meta` + session marker file.
export {
  resolveAgentMarker,
  readSessionMarker,
  extractMarkerMeta,
  NO_AGENT_MARKER,
  AGENT_MARKER_TTL_MS,
  AGENT_MARKER_SCHEMA_VERSION,
  KNOWN_HARNESS_FRAMEWORKS,
  type HarnessFramework,
  type AgentMarker,
  type AgentMarkerFile,
} from './agent-marker.js'

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
