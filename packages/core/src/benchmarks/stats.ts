/**
 * SMI-632/SMI-677: Shared statistical utilities for benchmark calculations
 *
 * This module provides consistent statistical calculations across
 * BenchmarkRunner and IndexBenchmark.
 */

/**
 * Calculate percentile value from sorted array using linear interpolation
 *
 * Uses the percentile rank method with linear interpolation between adjacent values.
 * This provides more accurate percentile estimates than simple nearest-rank method.
 *
 * @param sorted - Sorted array of values (ascending order)
 * @param p - Percentile to calculate (0-100)
 * @returns The interpolated percentile value, rounded to 3 decimal places
 *
 * @example
 * percentile([1, 2, 3, 4, 5], 50) // returns 3
 * percentile([1, 2, 3, 4, 5], 95) // returns 4.8 (interpolated)
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]

  const rank = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  const weight = rank - lower

  const value = sorted[lower] * (1 - weight) + sorted[upper] * weight
  return Math.round(value * 1000) / 1000
}

/**
 * Calculate mean of an array of values
 *
 * @param values - Array of numeric values
 * @returns The arithmetic mean, or 0 for empty array
 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, val) => sum + val, 0) / values.length
}

/**
 * Calculate sample standard deviation
 *
 * Uses Bessel's correction (n-1 denominator) for sample standard deviation,
 * which provides an unbiased estimate of population standard deviation.
 *
 * @param values - Array of numeric values
 * @returns The sample standard deviation, or 0 for arrays with less than 2 elements
 */
export function sampleStddev(values: number[]): number {
  if (values.length < 2) return 0

  const avg = mean(values)
  const variance =
    values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/**
 * Calculate all common statistics from a set of latencies
 *
 * @param latencies - Array of latency measurements
 * @returns Statistical summary including percentiles, mean, stddev, min, max
 */
export interface LatencyStats {
  count: number
  p50: number
  p95: number
  p99: number
  mean: number
  stddev: number
  min: number
  max: number
}

export function calculateLatencyStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return {
      count: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      mean: 0,
      stddev: 0,
      min: 0,
      max: 0,
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b)
  const n = sorted.length

  return {
    count: n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: Math.round(mean(sorted) * 1000) / 1000,
    stddev: Math.round(sampleStddev(sorted) * 1000) / 1000,
    min: sorted[0],
    max: sorted[n - 1],
  }
}
