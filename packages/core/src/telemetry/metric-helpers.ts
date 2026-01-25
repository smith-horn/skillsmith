/**
 * Helper classes and utilities for Skillsmith Metrics
 * @module @skillsmith/core/telemetry/metric-helpers
 */

import type { Counter, Gauge, Histogram, MetricLabels } from './metric-types.js'

/** Whether OpenTelemetry packages are available */
let otelAvailable: boolean | null = null

/**
 * Dynamic import helper that bypasses TypeScript type checking (SMI-755)
 */
export async function dynamicImport(moduleName: string): Promise<unknown> {
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
export async function checkOTelAvailability(): Promise<boolean> {
  if (otelAvailable !== null) return otelAvailable

  const result = await dynamicImport('@opentelemetry/api')
  otelAvailable = result !== null
  return otelAvailable
}

/**
 * No-op gauge implementation (used for gauges that track values locally)
 */
export class NoOpGauge implements Gauge {
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
export class InMemoryCounter implements Counter {
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
export class InMemoryHistogram implements Histogram {
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
