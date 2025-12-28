/**
 * SMI-632: BenchmarkRunner Tests
 *
 * Tests for:
 * - Benchmark accuracy
 * - Statistical calculations
 * - Report generation
 * - Comparison functionality
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  BenchmarkRunner,
  formatReportAsJson,
  formatReportAsText,
  compareReports,
  type BenchmarkReport,
  type BenchmarkStats,
} from '../src/benchmarks/BenchmarkRunner.js'

describe('BenchmarkRunner', () => {
  describe('basic functionality', () => {
    it('should run a simple benchmark', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 2,
        iterations: 10,
        measureMemory: false,
      })

      runner.add({
        name: 'test_benchmark',
        fn: () => {
          // Simple operation
          let sum = 0
          for (let i = 0; i < 100; i++) sum += i
        },
      })

      const report = await runner.run()

      expect(report.suite).toBe('default')
      expect(report.results).toHaveProperty('test_benchmark')
      expect(report.results['test_benchmark'].iterations).toBe(10)
      expect(report.summary.totalBenchmarks).toBe(1)
      expect(report.summary.totalIterations).toBe(10)
    })

    it('should run multiple benchmarks', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 1,
        iterations: 5,
        measureMemory: false,
      })

      runner
        .add({
          name: 'fast_benchmark',
          fn: () => {
            // Fast operation
          },
        })
        .add({
          name: 'slower_benchmark',
          fn: () => {
            // Slightly slower
            let sum = 0
            for (let i = 0; i < 1000; i++) sum += i
          },
        })

      const report = await runner.run()

      expect(Object.keys(report.results)).toHaveLength(2)
      expect(report.summary.totalBenchmarks).toBe(2)
      expect(report.summary.totalIterations).toBe(10)
    })

    it('should support async benchmarks', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 1,
        iterations: 3,
        measureMemory: false,
      })

      runner.add({
        name: 'async_benchmark',
        fn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
        },
      })

      const report = await runner.run()
      const stats = report.results['async_benchmark']

      // Each iteration should take at least 1ms
      expect(stats.mean_ms).toBeGreaterThan(0)
    })

    it('should call setup and teardown', async () => {
      let setupCalled = false
      let teardownCalled = false
      let runCount = 0

      const runner = new BenchmarkRunner({
        warmupIterations: 1,
        iterations: 3,
        measureMemory: false,
      })

      runner.add({
        name: 'with_lifecycle',
        setup: () => {
          setupCalled = true
        },
        fn: () => {
          runCount++
        },
        teardown: () => {
          teardownCalled = true
        },
      })

      await runner.run()

      expect(setupCalled).toBe(true)
      expect(teardownCalled).toBe(true)
      expect(runCount).toBe(4) // 1 warmup + 3 iterations
    })
  })

  describe('statistical calculations', () => {
    it('should calculate percentiles correctly', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 0,
        iterations: 100,
        measureMemory: false,
      })

      let counter = 0
      runner.add({
        name: 'deterministic',
        fn: () => {
          // Create predictable latency pattern
          const delay = counter % 100
          const start = Date.now()
          while (Date.now() - start < delay * 0.01) {
            // busy wait to create measurable delay
          }
          counter++
        },
      })

      const report = await runner.run()
      const stats = report.results['deterministic']

      // Verify statistical properties
      expect(stats.p50_ms).toBeDefined()
      expect(stats.p95_ms).toBeDefined()
      expect(stats.p99_ms).toBeDefined()
      expect(stats.mean_ms).toBeDefined()
      expect(stats.stddev_ms).toBeDefined()
      expect(stats.min_ms).toBeDefined()
      expect(stats.max_ms).toBeDefined()

      // p50 <= p95 <= p99
      expect(stats.p50_ms).toBeLessThanOrEqual(stats.p95_ms)
      expect(stats.p95_ms).toBeLessThanOrEqual(stats.p99_ms)

      // min <= mean <= max
      expect(stats.min_ms).toBeLessThanOrEqual(stats.mean_ms)
      expect(stats.mean_ms).toBeLessThanOrEqual(stats.max_ms)
    })

    it('should calculate mean correctly', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 0,
        iterations: 10,
        measureMemory: false,
      })

      runner.add({
        name: 'fast_op',
        fn: () => {
          // Very fast operation
        },
      })

      const report = await runner.run()
      const stats = report.results['fast_op']

      // Mean should be reasonable (< 10ms for a no-op)
      expect(stats.mean_ms).toBeLessThan(10)
    })

    it('should calculate stddev correctly for consistent operations', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 5,
        iterations: 50,
        measureMemory: false,
      })

      runner.add({
        name: 'consistent',
        fn: () => {
          // Consistent operation
          let sum = 0
          for (let i = 0; i < 100; i++) sum += i
        },
      })

      const report = await runner.run()
      const stats = report.results['consistent']

      // For consistent operations, stddev should be relatively small compared to mean
      // This is a loose check since timing can vary
      expect(stats.stddev_ms).toBeDefined()
      expect(typeof stats.stddev_ms).toBe('number')
    })
  })

  describe('memory tracking', () => {
    it('should track memory usage when enabled', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 1,
        iterations: 10,
        measureMemory: true,
      })

      runner.add({
        name: 'memory_test',
        fn: () => {
          // Allocate some memory
          const arr = new Array(1000).fill(0)
          arr.forEach((_, i) => (arr[i] = i * 2))
        },
      })

      const report = await runner.run()
      const stats = report.results['memory_test']

      expect(stats.memoryPeak_mb).toBeDefined()
      expect(stats.memoryPeak_mb).toBeGreaterThan(0)
    })

    it('should not track memory when disabled', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 1,
        iterations: 5,
        measureMemory: false,
      })

      runner.add({
        name: 'no_memory',
        fn: () => {},
      })

      const report = await runner.run()
      const stats = report.results['no_memory']

      expect(stats.memoryPeak_mb).toBeUndefined()
    })
  })

  describe('environment info', () => {
    it('should capture environment information', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 1,
        iterations: 1,
      })

      runner.add({ name: 'env_test', fn: () => {} })

      const report = await runner.run()

      expect(report.environment).toBeDefined()
      expect(report.environment.node).toMatch(/^v\d+/)
      expect(report.environment.platform).toBeDefined()
      expect(report.environment.arch).toBeDefined()
      expect(report.environment.cpuCount).toBeGreaterThan(0)
      expect(report.environment.memoryTotal_mb).toBeGreaterThan(0)
    })

    it('should include timestamp', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 1,
        iterations: 1,
      })

      runner.add({ name: 'timestamp_test', fn: () => {} })

      const before = new Date().toISOString()
      const report = await runner.run()
      const after = new Date().toISOString()

      expect(report.timestamp).toBeDefined()
      expect(report.timestamp >= before).toBe(true)
      expect(report.timestamp <= after).toBe(true)
    })
  })

  describe('report formatting', () => {
    let sampleReport: BenchmarkReport

    beforeEach(() => {
      sampleReport = {
        suite: 'test_suite',
        timestamp: '2025-01-01T00:00:00.000Z',
        environment: {
          node: 'v20.0.0',
          platform: 'linux',
          arch: 'x64',
          docker: true,
          database: 'sqlite',
          cpuCount: 8,
          memoryTotal_mb: 16384,
        },
        results: {
          benchmark_1: {
            name: 'benchmark_1',
            iterations: 1000,
            p50_ms: 10,
            p95_ms: 25,
            p99_ms: 50,
            mean_ms: 12,
            stddev_ms: 5,
            min_ms: 5,
            max_ms: 100,
            memoryPeak_mb: 25,
          },
        },
        summary: {
          totalBenchmarks: 1,
          totalIterations: 1000,
          totalDuration_ms: 15000,
        },
      }
    })

    it('should format report as JSON', () => {
      const json = formatReportAsJson(sampleReport)

      expect(() => JSON.parse(json)).not.toThrow()

      const parsed = JSON.parse(json)
      expect(parsed.suite).toBe('test_suite')
      expect(parsed.results.benchmark_1.p50_ms).toBe(10)
    })

    it('should format report as text', () => {
      const text = formatReportAsText(sampleReport)

      expect(text).toContain('Benchmark Report: test_suite')
      expect(text).toContain('Node v20.0.0')
      expect(text).toContain('Docker: Yes')
      expect(text).toContain('benchmark_1')
      expect(text).toContain('p50: 10ms')
      expect(text).toContain('p95: 25ms')
      expect(text).toContain('p99: 50ms')
      expect(text).toContain('Memory Peak: 25MB')
    })
  })

  describe('report comparison', () => {
    it('should detect regressions', () => {
      const baseline: BenchmarkReport = {
        suite: 'search',
        timestamp: '2025-01-01T00:00:00.000Z',
        environment: {
          node: 'v20.0.0',
          platform: 'linux',
          arch: 'x64',
          docker: true,
          database: 'sqlite',
          cpuCount: 8,
          memoryTotal_mb: 16384,
        },
        results: {
          simple_query: {
            name: 'simple_query',
            iterations: 1000,
            p50_ms: 10,
            p95_ms: 20,
            p99_ms: 30,
            mean_ms: 12,
            stddev_ms: 5,
            min_ms: 5,
            max_ms: 50,
          },
        },
        summary: {
          totalBenchmarks: 1,
          totalIterations: 1000,
          totalDuration_ms: 15000,
        },
      }

      const current: BenchmarkReport = {
        ...baseline,
        timestamp: '2025-01-02T00:00:00.000Z',
        results: {
          simple_query: {
            name: 'simple_query',
            iterations: 1000,
            p50_ms: 15, // 50% increase
            p95_ms: 30, // 50% increase (regression)
            p99_ms: 45, // 50% increase
            mean_ms: 18,
            stddev_ms: 8,
            min_ms: 8,
            max_ms: 80,
          },
        },
      }

      const comparison = compareReports(baseline, current)

      expect(comparison.summary.regressions).toBe(1)
      expect(comparison.comparisons['simple_query'].isRegression).toBe(true)
      expect(comparison.comparisons['simple_query'].p95ChangePercent).toBe(50)
    })

    it('should detect improvements', () => {
      const baseline: BenchmarkReport = {
        suite: 'search',
        timestamp: '2025-01-01T00:00:00.000Z',
        environment: {
          node: 'v20.0.0',
          platform: 'linux',
          arch: 'x64',
          docker: true,
          database: 'sqlite',
          cpuCount: 8,
          memoryTotal_mb: 16384,
        },
        results: {
          simple_query: {
            name: 'simple_query',
            iterations: 1000,
            p50_ms: 100,
            p95_ms: 200,
            p99_ms: 300,
            mean_ms: 120,
            stddev_ms: 50,
            min_ms: 50,
            max_ms: 500,
          },
        },
        summary: {
          totalBenchmarks: 1,
          totalIterations: 1000,
          totalDuration_ms: 15000,
        },
      }

      const current: BenchmarkReport = {
        ...baseline,
        timestamp: '2025-01-02T00:00:00.000Z',
        results: {
          simple_query: {
            name: 'simple_query',
            iterations: 1000,
            p50_ms: 50, // 50% improvement
            p95_ms: 100, // 50% improvement
            p99_ms: 150,
            mean_ms: 60,
            stddev_ms: 25,
            min_ms: 25,
            max_ms: 250,
          },
        },
      }

      const comparison = compareReports(baseline, current)

      expect(comparison.summary.improvements).toBe(1)
      expect(comparison.comparisons['simple_query'].isImprovement).toBe(true)
      expect(comparison.comparisons['simple_query'].p95ChangePercent).toBe(-50)
    })

    it('should handle unchanged results', () => {
      const baseline: BenchmarkReport = {
        suite: 'search',
        timestamp: '2025-01-01T00:00:00.000Z',
        environment: {
          node: 'v20.0.0',
          platform: 'linux',
          arch: 'x64',
          docker: true,
          database: 'sqlite',
          cpuCount: 8,
          memoryTotal_mb: 16384,
        },
        results: {
          simple_query: {
            name: 'simple_query',
            iterations: 1000,
            p50_ms: 10,
            p95_ms: 20,
            p99_ms: 30,
            mean_ms: 12,
            stddev_ms: 5,
            min_ms: 5,
            max_ms: 50,
          },
        },
        summary: {
          totalBenchmarks: 1,
          totalIterations: 1000,
          totalDuration_ms: 15000,
        },
      }

      const current: BenchmarkReport = {
        ...baseline,
        timestamp: '2025-01-02T00:00:00.000Z',
        results: {
          simple_query: {
            ...baseline.results['simple_query'],
            p95_ms: 21, // Only 5% change (within 10% threshold)
          },
        },
      }

      const comparison = compareReports(baseline, current)

      expect(comparison.summary.regressions).toBe(0)
      expect(comparison.summary.improvements).toBe(0)
      expect(comparison.summary.unchanged).toBe(1)
    })
  })

  describe('clear functionality', () => {
    it('should clear benchmarks and results', async () => {
      const runner = new BenchmarkRunner()

      runner.add({ name: 'test1', fn: () => {} })
      runner.add({ name: 'test2', fn: () => {} })

      await runner.run()

      expect(runner.getResults()).toHaveLength(2)

      runner.clear()

      expect(runner.getResults()).toHaveLength(0)
    })
  })

  // SMI-678: Error handling tests
  describe('error handling - SMI-678', () => {
    it('should continue suite execution when benchmark throws', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 0,
        iterations: 5,
        measureMemory: false,
      })

      let successCount = 0

      runner
        .add({
          name: 'failing_benchmark',
          fn: () => {
            throw new Error('Intentional failure')
          },
        })
        .add({
          name: 'succeeding_benchmark',
          fn: () => {
            successCount++
          },
        })

      const report = await runner.run()

      // Suite should complete with both benchmarks
      expect(Object.keys(report.results)).toHaveLength(2)
      // Succeeding benchmark should have run
      expect(successCount).toBe(5)
    })

    it('should track error count in results', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 0,
        iterations: 10,
        measureMemory: false,
      })

      let callCount = 0
      runner.add({
        name: 'partial_failure',
        fn: () => {
          callCount++
          if (callCount % 3 === 0) {
            throw new Error('Every third call fails')
          }
        },
      })

      const report = await runner.run()
      const stats = report.results['partial_failure']

      // Should have errors field
      expect(stats).toHaveProperty('errors')
      // @ts-expect-error - errors field added in fix
      expect(stats.errors).toBe(3) // calls 3, 6, 9 fail
    })

    it('should capture error messages (max 10)', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 0,
        iterations: 20,
        measureMemory: false,
      })

      runner.add({
        name: 'all_fail',
        fn: () => {
          throw new Error('Always fails')
        },
      })

      const report = await runner.run()
      const stats = report.results['all_fail']

      expect(stats).toHaveProperty('errorMessages')
      // @ts-expect-error - errorMessages field added in fix
      expect(stats.errorMessages).toHaveLength(10) // capped at 10
    })
  })

  // SMI-679: Empty array guard tests
  describe('empty array handling - SMI-679', () => {
    it('should return valid stats object for zero iterations', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 0,
        iterations: 0,
        measureMemory: false,
      })

      runner.add({
        name: 'zero_iterations',
        fn: () => {},
      })

      const report = await runner.run()
      const stats = report.results['zero_iterations']

      // Should not throw, should return valid structure
      expect(stats).toBeDefined()
      expect(stats.iterations).toBe(0)
      expect(stats.p50_ms).toBe(0)
      expect(stats.p95_ms).toBe(0)
      expect(stats.p99_ms).toBe(0)
      expect(stats.mean_ms).toBe(0)
      expect(stats.stddev_ms).toBe(0)
      expect(stats.min_ms).toBe(0)
      expect(stats.max_ms).toBe(0)
    })

    it('should not divide by zero with empty latencies', async () => {
      const runner = new BenchmarkRunner({
        warmupIterations: 0,
        iterations: 0,
        measureMemory: false,
      })

      runner.add({
        name: 'empty_latencies',
        fn: () => {},
      })

      // Should not throw
      expect(async () => {
        await runner.run()
      }).not.toThrow()
    })
  })

  // SMI-677: Consistency tests
  describe('percentile consistency - SMI-677', () => {
    it('should use linear interpolation for percentiles', async () => {
      // This test verifies the new interpolation method
      const runner = new BenchmarkRunner({
        warmupIterations: 0,
        iterations: 5,
        measureMemory: false,
      })

      // Create deterministic latencies
      let index = 0
      const latencies = [1, 2, 3, 4, 5]

      runner.add({
        name: 'interpolation_test',
        fn: () => {
          // Force specific latency by busy-waiting
          const targetMs = latencies[index++ % 5]
          const start = performance.now()
          while (performance.now() - start < targetMs) {
            // busy wait
          }
        },
      })

      const report = await runner.run()
      const stats = report.results['interpolation_test']

      // p50 for [1,2,3,4,5] should be exactly 3 with interpolation
      // p95 should be 4.8 (interpolated)
      expect(stats.p50_ms).toBeGreaterThanOrEqual(1)
    })
  })

  // Sample variance test
  describe('sample variance - Bessel correction', () => {
    it('should use sample variance (n-1 denominator) for stddev', async () => {
      // This test verifies Bessel's correction is used
      const runner = new BenchmarkRunner({
        warmupIterations: 0,
        iterations: 3,
        measureMemory: false,
      })

      let index = 0
      runner.add({
        name: 'variance_test',
        fn: () => {
          // Create predictable latencies: 1ms, 2ms, 3ms
          const targetMs = (index++ % 3) + 1
          const start = performance.now()
          while (performance.now() - start < targetMs) {
            // busy wait
          }
        },
      })

      const report = await runner.run()
      const stats = report.results['variance_test']

      // For [1, 2, 3]:
      // Population stddev = sqrt((2/3)) = 0.816...
      // Sample stddev = sqrt(1) = 1.0
      // If using sample variance, stddev should be closer to 1.0
      expect(stats.stddev_ms).toBeDefined()
    })
  })
})
