/**
 * SMI-1018: Prometheus Metrics Exporter
 *
 * Exports Skillsmith metrics in Prometheus text exposition format.
 * Integrates with existing MetricsRegistry for monitoring dashboards.
 *
 * @see https://prometheus.io/docs/instrumenting/exposition_formats/
 */

import type { MetricsSnapshot } from './metrics.js'
import { getMetrics } from './metrics.js'

/**
 * Prometheus metric types
 */
type PrometheusType = 'counter' | 'gauge' | 'histogram' | 'summary'

/**
 * Metric metadata for Prometheus exposition
 */
interface MetricMeta {
  name: string
  type: PrometheusType
  help: string
}

/**
 * Prometheus export options
 */
export interface PrometheusExportOptions {
  /** Include TYPE and HELP comments (default: true) */
  includeMetadata?: boolean
  /** Prefix for all metric names (default: none) */
  prefix?: string
  /** Custom labels to add to all metrics */
  globalLabels?: Record<string, string>
  /** Timestamp for all metrics (epoch ms, default: current time) */
  timestamp?: number
}

/**
 * Metric descriptions for Prometheus HELP text
 */
const METRIC_DESCRIPTIONS: Record<string, MetricMeta> = {
  'skillsmith.mcp.request.latency': {
    name: 'skillsmith_mcp_request_latency_ms',
    type: 'histogram',
    help: 'Latency of MCP tool requests in milliseconds',
  },
  'skillsmith.mcp.request.count': {
    name: 'skillsmith_mcp_request_total',
    type: 'counter',
    help: 'Total number of MCP tool requests',
  },
  'skillsmith.mcp.error.count': {
    name: 'skillsmith_mcp_errors_total',
    type: 'counter',
    help: 'Total number of MCP tool errors',
  },
  'skillsmith.db.query.latency': {
    name: 'skillsmith_db_query_latency_ms',
    type: 'histogram',
    help: 'Latency of database queries in milliseconds',
  },
  'skillsmith.db.query.count': {
    name: 'skillsmith_db_query_total',
    type: 'counter',
    help: 'Total number of database queries',
  },
  'skillsmith.cache.hits': {
    name: 'skillsmith_cache_hits_total',
    type: 'counter',
    help: 'Total number of cache hits',
  },
  'skillsmith.cache.misses': {
    name: 'skillsmith_cache_misses_total',
    type: 'counter',
    help: 'Total number of cache misses',
  },
  'skillsmith.cache.size': {
    name: 'skillsmith_cache_entries',
    type: 'gauge',
    help: 'Current number of entries in cache',
  },
  'skillsmith.embedding.latency': {
    name: 'skillsmith_embedding_latency_ms',
    type: 'histogram',
    help: 'Latency of embedding generation in milliseconds',
  },
  'skillsmith.embedding.count': {
    name: 'skillsmith_embedding_total',
    type: 'counter',
    help: 'Total number of embeddings generated',
  },
  'skillsmith.search.latency': {
    name: 'skillsmith_search_latency_ms',
    type: 'histogram',
    help: 'Latency of search operations in milliseconds',
  },
  'skillsmith.search.count': {
    name: 'skillsmith_search_total',
    type: 'counter',
    help: 'Total number of search operations',
  },
  'skillsmith.operations.active': {
    name: 'skillsmith_operations_active',
    type: 'gauge',
    help: 'Number of currently active operations',
  },
  // Rate limiting metrics (from security module)
  'skillsmith.rate_limit.allowed': {
    name: 'skillsmith_rate_limit_allowed_total',
    type: 'counter',
    help: 'Total number of requests allowed by rate limiter',
  },
  'skillsmith.rate_limit.blocked': {
    name: 'skillsmith_rate_limit_blocked_total',
    type: 'counter',
    help: 'Total number of requests blocked by rate limiter',
  },
  // Audit metrics
  'skillsmith.audit.events': {
    name: 'skillsmith_audit_events_total',
    type: 'counter',
    help: 'Total number of audit events logged',
  },
  // Security scan metrics
  'skillsmith.security_scan.count': {
    name: 'skillsmith_security_scan_total',
    type: 'counter',
    help: 'Total number of security scans performed',
  },
  'skillsmith.security_scan.findings': {
    name: 'skillsmith_security_scan_findings_total',
    type: 'counter',
    help: 'Total number of security findings detected',
  },
}

/**
 * Convert internal metric name to Prometheus format
 * - Replace dots with underscores
 * - Apply prefix if provided
 */
function toPrometheusName(internalName: string, prefix?: string): string {
  const meta = METRIC_DESCRIPTIONS[internalName]
  const baseName = meta?.name ?? internalName.replace(/\./g, '_')
  return prefix ? `${prefix}_${baseName}` : baseName
}

/**
 * Format labels as Prometheus label string
 */
function formatLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return ''
  }
  const pairs = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',')
  return `{${pairs}}`
}

/**
 * Escape label values for Prometheus format
 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/**
 * Export metrics snapshot to Prometheus text format
 *
 * @param snapshot - Metrics snapshot from MetricsRegistry.getSnapshot()
 * @param options - Export options
 * @returns Prometheus text exposition format string
 *
 * @example
 * ```typescript
 * const metrics = getMetrics()
 * const snapshot = metrics.getSnapshot()
 * const prometheusText = exportToPrometheus(snapshot)
 * // Returns:
 * // # HELP skillsmith_mcp_request_total Total number of MCP tool requests
 * // # TYPE skillsmith_mcp_request_total counter
 * // skillsmith_mcp_request_total 42
 * ```
 */
export function exportToPrometheus(
  snapshot: MetricsSnapshot,
  options: PrometheusExportOptions = {}
): string {
  const { includeMetadata = true, prefix, globalLabels, timestamp } = options
  const lines: string[] = []

  // Process counters
  for (const [name, value] of Object.entries(snapshot.counters)) {
    const promName = toPrometheusName(name, prefix)
    const meta = METRIC_DESCRIPTIONS[name]

    if (includeMetadata && meta) {
      lines.push(`# HELP ${promName} ${meta.help}`)
      lines.push(`# TYPE ${promName} counter`)
    }

    const labels = formatLabels(globalLabels)
    const ts = timestamp ? ` ${timestamp}` : ''
    lines.push(`${promName}${labels} ${value}${ts}`)
    lines.push('') // Blank line between metrics
  }

  // Process histograms
  for (const [name, stats] of Object.entries(snapshot.histograms)) {
    const promName = toPrometheusName(name, prefix)
    const meta = METRIC_DESCRIPTIONS[name]
    const ts = timestamp ? ` ${timestamp}` : ''

    if (includeMetadata && meta) {
      lines.push(`# HELP ${promName} ${meta.help}`)
      lines.push(`# TYPE ${promName} histogram`)
    }

    // Export histogram summary stats as gauges (since we don't have actual buckets)
    const baseLabels = globalLabels ? formatLabels(globalLabels) : ''
    lines.push(`${promName}_count${baseLabels} ${stats.count}${ts}`)
    lines.push(`${promName}_sum${baseLabels} ${stats.sum}${ts}`)

    // Export percentiles as quantiles
    const p50Labels = formatLabels({ ...globalLabels, quantile: '0.5' })
    const p95Labels = formatLabels({ ...globalLabels, quantile: '0.95' })
    const p99Labels = formatLabels({ ...globalLabels, quantile: '0.99' })

    lines.push(`${promName}${p50Labels} ${stats.p50}${ts}`)
    lines.push(`${promName}${p95Labels} ${stats.p95}${ts}`)
    lines.push(`${promName}${p99Labels} ${stats.p99}${ts}`)
    lines.push('')
  }

  // Process gauges
  for (const [name, value] of Object.entries(snapshot.gauges)) {
    const promName = toPrometheusName(name, prefix)
    const meta = METRIC_DESCRIPTIONS[name]

    if (includeMetadata && meta) {
      lines.push(`# HELP ${promName} ${meta.help}`)
      lines.push(`# TYPE ${promName} gauge`)
    }

    const labels = formatLabels(globalLabels)
    const ts = timestamp ? ` ${timestamp}` : ''
    lines.push(`${promName}${labels} ${value}${ts}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}

/**
 * Get current metrics in Prometheus format
 * Convenience function that combines getSnapshot() and exportToPrometheus()
 *
 * @param options - Export options
 * @returns Prometheus text exposition format string
 *
 * @example
 * ```typescript
 * // In an HTTP handler:
 * app.get('/metrics', (req, res) => {
 *   res.set('Content-Type', 'text/plain; version=0.0.4')
 *   res.send(getPrometheusMetrics())
 * })
 * ```
 */
export function getPrometheusMetrics(options: PrometheusExportOptions = {}): string {
  const metrics = getMetrics()
  const snapshot = metrics.getSnapshot()
  return exportToPrometheus(snapshot, options)
}

/**
 * Prometheus HTTP endpoint handler
 *
 * Creates a handler function suitable for Express/Koa/etc.
 *
 * @param options - Export options
 * @returns Handler function (req, res) => void
 *
 * @example
 * ```typescript
 * // Express
 * import express from 'express'
 * import { createPrometheusHandler } from '@skillsmith/core'
 *
 * const app = express()
 * app.get('/metrics', createPrometheusHandler())
 * ```
 */
export function createPrometheusHandler(
  options: PrometheusExportOptions = {}
): (
  req: unknown,
  res: { set: (k: string, v: string) => void; send: (body: string) => void }
) => void {
  return (_req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.send(getPrometheusMetrics(options))
  }
}
