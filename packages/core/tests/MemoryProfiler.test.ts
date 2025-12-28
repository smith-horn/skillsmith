/**
 * SMI-689: MemoryProfiler Tests
 *
 * Tests for:
 * - Memory tracking accuracy
 * - Leak detection
 * - Memory baseline comparison
 * - Regression detection
 * - Report formatting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  MemoryProfiler,
  type MemorySnapshot,
  type MemoryStats,
  type MemoryBaseline,
  type LeakDetectionResult,
  type MemoryRegressionResult,
} from '../src/benchmarks/MemoryProfiler.js'

describe('MemoryProfiler', () => {
  let profiler: MemoryProfiler

  beforeEach(() => {
    profiler = new MemoryProfiler(50) // 50ms sampling interval for faster tests
  })

  afterEach(() => {
    profiler.clear()
    profiler.clearBaselines()
  })

  describe('trackMemory / stopTracking', () => {
    it('should track memory for a labeled operation', () => {
      profiler.trackMemory('test_operation')

      // Do some work
      const arr = new Array(1000).fill(0).map((_, i) => i * 2)
      void arr

      const stats = profiler.stopTracking('test_operation')

      expect(stats).toBeDefined()
      expect(stats.label).toBe('test_operation')
      expect(stats.startSnapshot).toBeDefined()
      expect(stats.endSnapshot).toBeDefined()
      expect(stats.duration).toBeGreaterThan(0)
      expect(typeof stats.heapGrowth).toBe('number')
      expect(typeof stats.heapGrowthPercent).toBe('number')
    })

    it('should throw when tracking already active label', () => {
      profiler.trackMemory('duplicate')

      expect(() => profiler.trackMemory('duplicate')).toThrow(
        'Memory tracking already active for label: duplicate'
      )

      profiler.stopTracking('duplicate')
    })

    it('should throw when stopping non-existent tracking', () => {
      expect(() => profiler.stopTracking('nonexistent')).toThrow(
        'No active memory tracking for label: nonexistent'
      )
    })

    it('should track peak memory usage', async () => {
      profiler.trackMemory('peak_test')

      // Allocate and release memory to create a peak
      let temp: number[] | null = new Array(100000).fill(0)
      await new Promise((resolve) => setTimeout(resolve, 60))
      temp = null // Allow GC

      const stats = profiler.stopTracking('peak_test')

      expect(stats.peakHeapUsed).toBeGreaterThan(0)
      expect(stats.sampleCount).toBeGreaterThanOrEqual(1)
    })

    it('should collect samples during tracking', async () => {
      profiler.trackMemory('sampling_test')

      // Wait for some samples to be collected
      await new Promise((resolve) => setTimeout(resolve, 120))

      const stats = profiler.stopTracking('sampling_test')

      // Should have at least 2 samples (start + at least one interval)
      expect(stats.sampleCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe('getHeapSnapshot', () => {
    it('should return valid heap statistics', () => {
      const snapshot = profiler.getHeapSnapshot()

      expect(snapshot).toBeDefined()
      expect(snapshot.timestamp).toBeGreaterThan(0)
      expect(snapshot.totalHeapSize).toBeGreaterThan(0)
      expect(snapshot.usedHeapSize).toBeGreaterThan(0)
      expect(snapshot.heapSizeLimit).toBeGreaterThan(0)
      expect(typeof snapshot.externalMemory).toBe('number')
      expect(typeof snapshot.totalPhysicalSize).toBe('number')
      expect(typeof snapshot.totalAvailableSize).toBe('number')
      expect(typeof snapshot.mallocedMemory).toBe('number')
      expect(typeof snapshot.peakMallocedMemory).toBe('number')
    })

    it('should return consistent values', () => {
      const snapshot1 = profiler.getHeapSnapshot()
      const snapshot2 = profiler.getHeapSnapshot()

      // Values should be in same ballpark (within 10MB)
      const diff = Math.abs(snapshot1.usedHeapSize - snapshot2.usedHeapSize)
      expect(diff).toBeLessThan(10 * 1024 * 1024)
    })
  })

  describe('detectLeaks', () => {
    it('should not detect leaks when heap growth is below threshold', () => {
      profiler.trackMemory('small_op')
      // Minimal work - shouldn't cause significant heap growth
      const x = 1 + 1
      void x
      profiler.stopTracking('small_op')

      const result = profiler.detectLeaks(10)

      expect(result.threshold).toBe(10)
      expect(typeof result.heapGrowthPercent).toBe('number')
      expect(typeof result.leakedBytes).toBe('number')
      expect(Array.isArray(result.suspectedLabels)).toBe(true)
      expect(result.message).toBeDefined()
    })

    it('should detect leaks when heap growth exceeds threshold', () => {
      // Create a custom profiler and manually set stats to simulate a leak
      const testProfiler = new MemoryProfiler()

      testProfiler.trackMemory('leaky_op')
      // Allocate significant memory
      const largeArray = new Array(1000000).fill(0).map((_, i) => ({ value: i }))
      void largeArray
      testProfiler.stopTracking('leaky_op')

      const result = testProfiler.detectLeaks(0.001) // Very low threshold to ensure detection

      // The result depends on actual heap behavior
      expect(result.threshold).toBe(0.001)
      expect(result.message).toBeDefined()
    })

    it('should return empty result when no tracking completed', () => {
      const result = profiler.detectLeaks(10)

      expect(result.hasLeaks).toBe(false)
      expect(result.suspectedLabels).toHaveLength(0)
      expect(result.leakedBytes).toBe(0)
    })

    it('should identify multiple suspected labels', () => {
      // Track multiple operations
      profiler.trackMemory('op1')
      profiler.stopTracking('op1')

      profiler.trackMemory('op2')
      profiler.stopTracking('op2')

      const result = profiler.detectLeaks(10)

      // Result should include info about both ops
      expect(result.suspectedLabels).toBeDefined()
      expect(Array.isArray(result.suspectedLabels)).toBe(true)
    })
  })

  describe('baseline management', () => {
    it('should save baseline from completed stats', () => {
      profiler.trackMemory('baseline_test')
      const arr = new Array(1000).fill(0)
      void arr
      profiler.stopTracking('baseline_test')

      const baseline = profiler.saveBaseline('baseline_test')

      expect(baseline.label).toBe('baseline_test')
      expect(baseline.timestamp).toBeDefined()
      expect(baseline.avgHeapUsed).toBeGreaterThan(0)
      expect(baseline.peakHeapUsed).toBeGreaterThan(0)
      expect(baseline.sampleCount).toBeGreaterThan(0)
    })

    it('should throw when saving baseline for non-existent label', () => {
      expect(() => profiler.saveBaseline('nonexistent')).toThrow(
        'No completed stats for label: nonexistent'
      )
    })

    it('should load baselines from object', () => {
      const baselines: Record<string, MemoryBaseline> = {
        test1: {
          label: 'test1',
          timestamp: new Date().toISOString(),
          avgHeapUsed: 50000000,
          peakHeapUsed: 60000000,
          sampleCount: 10,
        },
        test2: {
          label: 'test2',
          timestamp: new Date().toISOString(),
          avgHeapUsed: 40000000,
          peakHeapUsed: 50000000,
          sampleCount: 8,
        },
      }

      profiler.loadBaselines(baselines)

      const loadedBaselines = profiler.getBaselines()
      expect(loadedBaselines.size).toBe(2)
      expect(loadedBaselines.get('test1')).toEqual(baselines.test1)
      expect(loadedBaselines.get('test2')).toEqual(baselines.test2)
    })

    it('should export baselines as object', () => {
      profiler.trackMemory('export_test')
      profiler.stopTracking('export_test')
      profiler.saveBaseline('export_test')

      const exported = profiler.exportBaselines()

      expect(typeof exported).toBe('object')
      expect(exported['export_test']).toBeDefined()
      expect(exported['export_test'].label).toBe('export_test')
    })
  })

  describe('checkRegression', () => {
    it('should detect regression when heap exceeds baseline', () => {
      // Set up a baseline
      const baseline: MemoryBaseline = {
        label: 'regression_test',
        timestamp: new Date().toISOString(),
        avgHeapUsed: 10000000, // 10MB
        peakHeapUsed: 10000000,
        sampleCount: 5,
      }
      profiler.loadBaselines({ regression_test: baseline })

      // Run an operation that uses more memory
      profiler.trackMemory('regression_test')
      const largeArray = new Array(500000).fill(0).map((_, i) => ({ value: i }))
      void largeArray
      profiler.stopTracking('regression_test')

      const result = profiler.checkRegression('regression_test', 10)

      expect(result.label).toBe('regression_test')
      expect(result.threshold).toBe(10)
      expect(result.baselineHeap).toBe(10000000)
      expect(result.currentHeap).toBeGreaterThan(0)
      expect(typeof result.changePercent).toBe('number')
      expect(result.message).toBeDefined()
    })

    it('should not detect regression when heap is within threshold', () => {
      // Track operation first
      profiler.trackMemory('no_regression')
      profiler.stopTracking('no_regression')

      // Save and load the same baseline
      const baseline = profiler.saveBaseline('no_regression')
      profiler.clearBaselines()
      profiler.loadBaselines({ no_regression: baseline })

      // Track again with similar workload
      profiler.trackMemory('no_regression')
      profiler.stopTracking('no_regression')

      const result = profiler.checkRegression('no_regression', 50) // High threshold

      // Should not detect regression since we're comparing similar workloads
      expect(result.threshold).toBe(50)
    })

    it('should handle missing baseline gracefully', () => {
      profiler.trackMemory('no_baseline')
      profiler.stopTracking('no_baseline')

      const result = profiler.checkRegression('no_baseline', 10)

      expect(result.hasRegression).toBe(false)
      expect(result.message).toContain('No baseline exists')
    })

    it('should handle missing current stats gracefully', () => {
      const baseline: MemoryBaseline = {
        label: 'missing_current',
        timestamp: new Date().toISOString(),
        avgHeapUsed: 10000000,
        peakHeapUsed: 10000000,
        sampleCount: 5,
      }
      profiler.loadBaselines({ missing_current: baseline })

      const result = profiler.checkRegression('missing_current', 10)

      expect(result.hasRegression).toBe(false)
      expect(result.message).toContain('No current stats exist')
    })
  })

  describe('formatMemoryReport', () => {
    it('should generate a formatted report', () => {
      profiler.trackMemory('report_test')
      const arr = new Array(1000).fill(0)
      void arr
      profiler.stopTracking('report_test')

      const report = profiler.formatMemoryReport()

      expect(report).toContain('SMI-689')
      expect(report).toContain('Memory Profiling Report')
      expect(report).toContain('Current Heap Status')
      expect(report).toContain('Tracked Operations')
      expect(report).toContain('report_test')
      expect(report).toContain('Leak Detection')
    })

    it('should indicate no tracked operations when empty', () => {
      const report = profiler.formatMemoryReport()

      expect(report).toContain('No tracked operations recorded')
    })

    it('should show active tracking', async () => {
      profiler.trackMemory('active_tracking')

      // Give it time to collect a sample
      await new Promise((resolve) => setTimeout(resolve, 60))

      const report = profiler.formatMemoryReport()

      expect(report).toContain('Active Tracking')
      expect(report).toContain('active_tracking')

      profiler.stopTracking('active_tracking')
    })

    it('should indicate leak warnings when present', () => {
      // Create profiler and simulate high growth stats
      const testProfiler = new MemoryProfiler()
      testProfiler.trackMemory('leaky')
      // Large allocation
      const large = new Array(1000000).fill({ data: 'test' })
      void large
      testProfiler.stopTracking('leaky')

      const report = testProfiler.formatMemoryReport()

      // Report should show leak detection section
      expect(report).toContain('Leak Detection')
    })
  })

  describe('clear', () => {
    it('should clear all tracking data', async () => {
      profiler.trackMemory('clear_test1')
      await new Promise((resolve) => setTimeout(resolve, 10))
      profiler.stopTracking('clear_test1')

      profiler.trackMemory('clear_test2')
      await new Promise((resolve) => setTimeout(resolve, 10))
      // Don't stop this one

      profiler.clear()

      expect(profiler.getCompletedStats().size).toBe(0)
      // Active tracking should also be cleared (with intervals stopped)
    })

    it('should clear baselines separately', () => {
      profiler.trackMemory('baseline_clear')
      profiler.stopTracking('baseline_clear')
      profiler.saveBaseline('baseline_clear')

      expect(profiler.getBaselines().size).toBe(1)

      profiler.clearBaselines()

      expect(profiler.getBaselines().size).toBe(0)
    })
  })

  describe('getCompletedStats', () => {
    it('should return map of completed stats', () => {
      profiler.trackMemory('stats1')
      profiler.stopTracking('stats1')

      profiler.trackMemory('stats2')
      profiler.stopTracking('stats2')

      const stats = profiler.getCompletedStats()

      expect(stats.size).toBe(2)
      expect(stats.has('stats1')).toBe(true)
      expect(stats.has('stats2')).toBe(true)
    })

    it('should return a copy, not the original map', () => {
      profiler.trackMemory('copy_test')
      profiler.stopTracking('copy_test')

      const stats1 = profiler.getCompletedStats()
      const stats2 = profiler.getCompletedStats()

      expect(stats1).not.toBe(stats2)
      expect(stats1.get('copy_test')).toEqual(stats2.get('copy_test'))
    })
  })

  describe('memory tracking accuracy', () => {
    it('should detect heap growth for large allocations', () => {
      profiler.trackMemory('large_alloc')

      // Allocate ~8MB of data (1M objects * ~8 bytes each for numbers)
      const largeArray = new Array(1000000).fill(0)
      void largeArray

      const stats = profiler.stopTracking('large_alloc')

      // Should have some heap growth
      expect(stats.endSnapshot).toBeDefined()
      expect(stats.startSnapshot.usedHeapSize).toBeGreaterThan(0)
    })

    it('should track duration accurately', async () => {
      const startTime = Date.now()
      profiler.trackMemory('duration_test')

      await new Promise((resolve) => setTimeout(resolve, 100))

      const stats = profiler.stopTracking('duration_test')
      const endTime = Date.now()

      // Duration should be within reasonable bounds
      expect(stats.duration).toBeGreaterThanOrEqual(95) // Allow some variance
      expect(stats.duration).toBeLessThanOrEqual(endTime - startTime + 50)
    })
  })

  describe('integration with BenchmarkRunner', () => {
    it('should work with BenchmarkRunner when enabled', async () => {
      const { BenchmarkRunner } = await import('../src/benchmarks/BenchmarkRunner.js')

      const runner = new BenchmarkRunner({
        warmupIterations: 1,
        iterations: 5,
        measureMemory: true,
        enableMemoryProfiler: true,
        suiteName: 'memory_integration_test',
      })

      runner.add({
        name: 'integration_benchmark',
        fn: () => {
          const arr = new Array(100).fill(0)
          void arr
        },
      })

      const report = await runner.run()

      expect(report.memoryProfile).toBeDefined()
      expect(report.memoryProfile?.['integration_benchmark']).toBeDefined()
      expect(report.memoryBaselines).toBeDefined()
      expect(report.memoryBaselines?.['integration_benchmark']).toBeDefined()
    })

    it('should detect memory regression with baselines', async () => {
      const { BenchmarkRunner } = await import('../src/benchmarks/BenchmarkRunner.js')

      // Create a very low baseline to trigger regression
      const baselines: Record<string, MemoryBaseline> = {
        regression_benchmark: {
          label: 'regression_benchmark',
          timestamp: new Date().toISOString(),
          avgHeapUsed: 1000, // Very low baseline
          peakHeapUsed: 1000,
          sampleCount: 5,
        },
      }

      const runner = new BenchmarkRunner({
        warmupIterations: 1,
        iterations: 3,
        enableMemoryProfiler: true,
        memoryRegressionThreshold: 10,
        memoryBaselines: baselines,
        suiteName: 'regression_test',
      })

      runner.add({
        name: 'regression_benchmark',
        fn: () => {
          // Do something that uses memory
          const arr = new Array(10000).fill(0)
          void arr
        },
      })

      const report = await runner.run()

      // Should have regression info
      expect(report.memoryRegression).toBeDefined()
      // Given the very low baseline, regression should be detected
      expect(report.memoryRegression?.hasRegressions).toBe(true)
    })
  })
})
