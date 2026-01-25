/**
 * Type definitions for Skillsmith Metrics
 * @module @skillsmith/core/telemetry/metric-types
 */

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
