/**
 * SMI-632/SMI-677: Statistical Utilities Tests
 *
 * TDD tests for:
 * - Percentile calculations with linear interpolation
 * - Empty array handling
 * - Sample variance (Bessel's correction)
 * - Consistent results across modules
 */

import { describe, it, expect } from 'vitest'
import { percentile, mean, sampleStddev, calculateLatencyStats } from '../src/benchmarks/stats.js'

describe('stats utility - SMI-677 Percentile Calculations', () => {
  describe('percentile function', () => {
    it('should return 0 for empty array', () => {
      expect(percentile([], 50)).toBe(0)
    })

    it('should return the single value for single-element array', () => {
      expect(percentile([5], 50)).toBe(5)
      expect(percentile([5], 0)).toBe(5)
      expect(percentile([5], 100)).toBe(5)
    })

    it('should return median for odd-length array at p50', () => {
      expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
    })

    it('should interpolate correctly for p95', () => {
      // For [1, 2, 3, 4, 5] at p95:
      // rank = 0.95 * (5-1) = 3.8
      // lower = 3, upper = 4, weight = 0.8
      // value = sorted[3] * 0.2 + sorted[4] * 0.8 = 4 * 0.2 + 5 * 0.8 = 0.8 + 4.0 = 4.8
      expect(percentile([1, 2, 3, 4, 5], 95)).toBe(4.8)
    })

    it('should return first element for p0', () => {
      expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1)
    })

    it('should return last element for p100', () => {
      expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5)
    })

    it('should handle two-element arrays correctly', () => {
      // For [1, 10] at p50: rank = 0.5 * 1 = 0.5
      // value = 1 * 0.5 + 10 * 0.5 = 5.5
      expect(percentile([1, 10], 50)).toBe(5.5)
    })

    it('should interpolate for larger arrays', () => {
      // 10 elements: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      // p90: rank = 0.9 * 9 = 8.1
      // value = 9 * 0.9 + 10 * 0.1 = 8.1 + 1 = 9.1
      expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9.1)
    })
  })
})

describe('stats utility - SMI-679 Empty Array Guard', () => {
  describe('mean function', () => {
    it('should return 0 for empty array', () => {
      expect(mean([])).toBe(0)
    })

    it('should calculate mean correctly', () => {
      expect(mean([1, 2, 3, 4, 5])).toBe(3)
      expect(mean([10])).toBe(10)
    })
  })

  describe('sampleStddev function', () => {
    it('should return 0 for empty array', () => {
      expect(sampleStddev([])).toBe(0)
    })

    it('should return 0 for single-element array', () => {
      expect(sampleStddev([5])).toBe(0)
    })

    it('should use sample variance (n-1 denominator)', () => {
      // For [2, 4, 4, 4, 5, 5, 7, 9]:
      // mean = 5
      // sum of squared diffs = 9 + 1 + 1 + 1 + 0 + 0 + 4 + 16 = 32
      // sample variance = 32 / (8-1) = 32/7 = 4.571...
      // sample stddev = sqrt(4.571...) = 2.138...
      const values = [2, 4, 4, 4, 5, 5, 7, 9]
      const stddev = sampleStddev(values)
      expect(stddev).toBeCloseTo(2.138, 2)
    })
  })

  describe('calculateLatencyStats function', () => {
    it('should return zeros for empty array', () => {
      const stats = calculateLatencyStats([])
      expect(stats.count).toBe(0)
      expect(stats.p50).toBe(0)
      expect(stats.p95).toBe(0)
      expect(stats.p99).toBe(0)
      expect(stats.mean).toBe(0)
      expect(stats.stddev).toBe(0)
      expect(stats.min).toBe(0)
      expect(stats.max).toBe(0)
    })

    it('should calculate all stats correctly for normal array', () => {
      const latencies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      const stats = calculateLatencyStats(latencies)

      expect(stats.count).toBe(10)
      expect(stats.min).toBe(1)
      expect(stats.max).toBe(10)
      expect(stats.mean).toBe(5.5)
      expect(stats.p50).toBeCloseTo(5.5, 1)
    })
  })
})

describe('stats utility - Sample Variance (Bessel correction)', () => {
  it('should use n-1 denominator for variance calculation', () => {
    // Verify sample variance uses (n-1) denominator
    // Population stddev of [1, 2, 3] = sqrt((2/3)) = 0.816...
    // Sample stddev of [1, 2, 3] = sqrt(1) = 1.0
    const values = [1, 2, 3]
    const stddev = sampleStddev(values)

    // Population would give ~0.816
    // Sample should give exactly 1.0
    expect(stddev).toBe(1)
  })

  it('should match expected sample stddev for known dataset', () => {
    // Known dataset with calculated sample stddev
    const values = [10, 20, 30, 40, 50]
    // mean = 30
    // sum of squared diffs = 400 + 100 + 0 + 100 + 400 = 1000
    // sample variance = 1000 / 4 = 250
    // sample stddev = sqrt(250) = 15.811...
    const stddev = sampleStddev(values)
    expect(stddev).toBeCloseTo(15.811, 2)
  })
})
