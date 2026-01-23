/**
 * In-Memory Metrics Implementations
 * @module analysis/metrics.implementations
 */

import type { Counter, Histogram, Gauge, MetricLabels } from '../telemetry/metrics.js'
import type { HistogramStats } from './metrics.types.js'

/**
 * In-memory counter implementation
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

  getStats(): HistogramStats {
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

  getStatsByLabel(labels: MetricLabels): HistogramStats {
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
export class InMemoryGauge implements Gauge {
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
