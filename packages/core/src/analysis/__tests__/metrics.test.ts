/**
 * SMI-1337: Analysis Metrics Tests
 *
 * Tests for the analysis pipeline metrics collector.
 *
 * @see packages/core/src/analysis/metrics.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  AnalysisMetrics,
  getAnalysisMetrics,
  initializeAnalysisMetrics,
  timeParseAsync,
  timeParseSync,
} from '../metrics.js'

describe('AnalysisMetrics', () => {
  let metrics: AnalysisMetrics

  beforeEach(() => {
    metrics = new AnalysisMetrics()
  })

  describe('constructor', () => {
    it('should create metrics with default config', () => {
      expect(metrics.isEnabled()).toBe(true)
    })

    it('should allow disabling metrics', () => {
      const disabled = new AnalysisMetrics({ enabled: false })
      expect(disabled.isEnabled()).toBe(false)
    })
  })

  describe('file parsing metrics', () => {
    it('should record files parsed', () => {
      metrics.recordFileParsed('typescript')
      metrics.recordFileParsed('typescript')
      metrics.recordFileParsed('python')

      const snapshot = metrics.getSnapshot()
      expect(snapshot.filesParsed.total).toBe(3)
      expect(snapshot.filesParsed.byLanguage.typescript).toBe(2)
      expect(snapshot.filesParsed.byLanguage.python).toBe(1)
    })

    it('should record parse duration', () => {
      metrics.recordParseDuration('typescript', 10)
      metrics.recordParseDuration('typescript', 20)
      metrics.recordParseDuration('typescript', 30)

      const snapshot = metrics.getSnapshot()
      expect(snapshot.parseDuration.stats.count).toBe(3)
      expect(snapshot.parseDuration.stats.mean).toBe(20)
      expect(snapshot.parseDuration.stats.sum).toBe(60)
    })

    it('should track parse duration by language', () => {
      metrics.recordParseDuration('typescript', 10)
      metrics.recordParseDuration('typescript', 20)
      metrics.recordParseDuration('python', 100)

      const tsStats = metrics.getParseDurationByLanguage('typescript')
      expect(tsStats.count).toBe(2)
      expect(tsStats.mean).toBe(15)

      const pyStats = metrics.getParseDurationByLanguage('python')
      expect(pyStats.count).toBe(1)
      expect(pyStats.mean).toBe(100)
    })
  })

  describe('cache metrics', () => {
    it('should record cache hits and misses', () => {
      metrics.recordCacheHit()
      metrics.recordCacheHit()
      metrics.recordCacheMiss()

      const snapshot = metrics.getSnapshot()
      expect(snapshot.cache.hits).toBe(2)
      expect(snapshot.cache.misses).toBe(1)
    })

    it('should calculate cache hit rate', () => {
      metrics.recordCacheHit()
      metrics.recordCacheHit()
      metrics.recordCacheHit()
      metrics.recordCacheMiss()

      expect(metrics.getCacheHitRate()).toBe(0.75)

      const snapshot = metrics.getSnapshot()
      expect(snapshot.cache.hitRate).toBe(0.75)
    })

    it('should return 0 hit rate when no cache operations', () => {
      expect(metrics.getCacheHitRate()).toBe(0)
    })

    it('should update cache size', () => {
      metrics.updateCacheSize(1024 * 1024, 100)

      const snapshot = metrics.getSnapshot()
      expect(snapshot.cache.size).toBe(1024 * 1024)
    })

    it('should track cache hits by language', () => {
      metrics.recordCacheHit('typescript')
      metrics.recordCacheHit('typescript')
      metrics.recordCacheMiss('python')

      const snapshot = metrics.getSnapshot()
      expect(snapshot.cache.hits).toBe(2)
      expect(snapshot.cache.misses).toBe(1)
    })
  })

  describe('worker pool metrics', () => {
    it('should update worker pool stats', () => {
      metrics.updateWorkerPool(4, 10, 8)

      const snapshot = metrics.getSnapshot()
      expect(snapshot.workerPool.activeWorkers).toBe(4)
      expect(snapshot.workerPool.queuedTasks).toBe(10)
      expect(snapshot.workerPool.utilization).toBe(0.5)
    })

    it('should handle zero pool size gracefully', () => {
      metrics.updateWorkerPool(0, 0, 0)

      const snapshot = metrics.getSnapshot()
      expect(snapshot.workerPool.utilization).toBe(0)
    })
  })

  describe('memory metrics', () => {
    it('should update memory usage', () => {
      metrics.updateMemoryUsage()

      const snapshot = metrics.getSnapshot()
      expect(snapshot.memory.heapUsed).toBeGreaterThan(0)
      expect(snapshot.memory.heapTotal).toBeGreaterThan(0)
      expect(snapshot.memory.rss).toBeGreaterThan(0)
    })
  })

  describe('error metrics', () => {
    it('should record errors', () => {
      metrics.recordError('parse_error')
      metrics.recordError('parse_error')
      metrics.recordError('timeout')

      const snapshot = metrics.getSnapshot()
      expect(snapshot.errors.total).toBe(3)
      expect(snapshot.errors.byType.parse_error).toBe(2)
      expect(snapshot.errors.byType.timeout).toBe(1)
    })

    it('should record errors with language context', () => {
      metrics.recordError('parse_error', 'typescript')
      metrics.recordError('parse_error', 'python')

      const snapshot = metrics.getSnapshot()
      expect(snapshot.errors.total).toBe(2)
    })
  })

  describe('aggregator metrics', () => {
    it('should update aggregator stats', () => {
      metrics.updateAggregatorStats(100, 500, 200, 300)

      const snapshot = metrics.getSnapshot()
      expect(snapshot.aggregator.filesProcessed).toBe(100)
      expect(snapshot.aggregator.totalImports).toBe(500)
      expect(snapshot.aggregator.totalExports).toBe(200)
      expect(snapshot.aggregator.totalFunctions).toBe(300)
    })
  })

  describe('snapshot', () => {
    it('should include timestamp', () => {
      const snapshot = metrics.getSnapshot()
      expect(snapshot.timestamp).toBeDefined()
      expect(new Date(snapshot.timestamp).getTime()).toBeGreaterThan(0)
    })

    it('should include all metric categories', () => {
      const snapshot = metrics.getSnapshot()

      expect(snapshot).toHaveProperty('filesParsed')
      expect(snapshot).toHaveProperty('parseDuration')
      expect(snapshot).toHaveProperty('cache')
      expect(snapshot).toHaveProperty('workerPool')
      expect(snapshot).toHaveProperty('memory')
      expect(snapshot).toHaveProperty('errors')
      expect(snapshot).toHaveProperty('aggregator')
    })
  })

  describe('reset', () => {
    it('should reset all metrics', () => {
      // Record various metrics
      metrics.recordFileParsed('typescript')
      metrics.recordParseDuration('typescript', 10)
      metrics.recordCacheHit()
      metrics.recordError('parse_error')
      metrics.updateAggregatorStats(100, 500, 200, 300)

      // Reset
      metrics.reset()

      // Verify all reset
      const snapshot = metrics.getSnapshot()
      expect(snapshot.filesParsed.total).toBe(0)
      expect(snapshot.parseDuration.stats.count).toBe(0)
      expect(snapshot.cache.hits).toBe(0)
      expect(snapshot.cache.misses).toBe(0)
      expect(snapshot.errors.total).toBe(0)
      expect(snapshot.aggregator.filesProcessed).toBe(0)
    })
  })

  describe('disabled metrics', () => {
    let disabledMetrics: AnalysisMetrics

    beforeEach(() => {
      disabledMetrics = new AnalysisMetrics({ enabled: false })
    })

    it('should not record when disabled', () => {
      disabledMetrics.recordFileParsed('typescript')
      disabledMetrics.recordCacheHit()
      disabledMetrics.recordError('parse_error')

      const snapshot = disabledMetrics.getSnapshot()
      expect(snapshot.filesParsed.total).toBe(0)
      expect(snapshot.cache.hits).toBe(0)
      expect(snapshot.errors.total).toBe(0)
    })
  })
})

describe('getAnalysisMetrics', () => {
  it('should return singleton instance', () => {
    const metrics1 = getAnalysisMetrics()
    const metrics2 = getAnalysisMetrics()
    expect(metrics1).toBe(metrics2)
  })
})

describe('initializeAnalysisMetrics', () => {
  it('should create new instance with config', () => {
    const metrics1 = initializeAnalysisMetrics()
    const metrics2 = initializeAnalysisMetrics({ enabled: true })

    // Both should be enabled
    expect(metrics1.isEnabled()).toBe(true)
    expect(metrics2.isEnabled()).toBe(true)
  })

  it('should reset previous metrics', () => {
    const metrics1 = initializeAnalysisMetrics()
    metrics1.recordFileParsed('typescript')

    const metrics2 = initializeAnalysisMetrics()
    const snapshot = metrics2.getSnapshot()

    // Should be fresh (no previous data)
    expect(snapshot.filesParsed.total).toBe(0)
  })
})

describe('timeParseSync', () => {
  let metrics: AnalysisMetrics

  beforeEach(() => {
    metrics = new AnalysisMetrics()
  })

  it('should time sync operation and record metrics', () => {
    const result = timeParseSync(
      'typescript',
      () => {
        // Simulate some work
        let sum = 0
        for (let i = 0; i < 1000; i++) sum += i
        return sum
      },
      metrics
    )

    expect(result).toBe(499500)

    const snapshot = metrics.getSnapshot()
    expect(snapshot.filesParsed.total).toBe(1)
    expect(snapshot.filesParsed.byLanguage.typescript).toBe(1)
    expect(snapshot.parseDuration.stats.count).toBe(1)
  })

  it('should record duration even on error', () => {
    try {
      timeParseSync(
        'typescript',
        () => {
          throw new Error('test error')
        },
        metrics
      )
    } catch {
      // Expected
    }

    const snapshot = metrics.getSnapshot()
    // Duration should still be recorded
    expect(snapshot.parseDuration.stats.count).toBe(1)
  })
})

describe('timeParseAsync', () => {
  let metrics: AnalysisMetrics

  beforeEach(() => {
    metrics = new AnalysisMetrics()
  })

  it('should time async operation and record metrics', async () => {
    const result = await timeParseAsync(
      'python',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return 'parsed'
      },
      metrics
    )

    expect(result).toBe('parsed')

    const snapshot = metrics.getSnapshot()
    expect(snapshot.filesParsed.total).toBe(1)
    expect(snapshot.filesParsed.byLanguage.python).toBe(1)
    expect(snapshot.parseDuration.stats.count).toBe(1)
    expect(snapshot.parseDuration.stats.mean).toBeGreaterThan(0)
  })

  it('should record duration even on async error', async () => {
    try {
      await timeParseAsync(
        'python',
        async () => {
          throw new Error('async error')
        },
        metrics
      )
    } catch {
      // Expected
    }

    const snapshot = metrics.getSnapshot()
    // Duration should still be recorded
    expect(snapshot.parseDuration.stats.count).toBe(1)
  })
})

describe('histogram statistics', () => {
  let metrics: AnalysisMetrics

  beforeEach(() => {
    metrics = new AnalysisMetrics()
  })

  it('should calculate percentiles correctly', () => {
    // Record 100 values from 1 to 100
    for (let i = 1; i <= 100; i++) {
      metrics.recordParseDuration('typescript', i)
    }

    const snapshot = metrics.getSnapshot()
    const stats = snapshot.parseDuration.stats

    expect(stats.count).toBe(100)
    expect(stats.sum).toBe(5050)
    expect(stats.mean).toBe(50.5)
    expect(stats.p50).toBe(50)
    expect(stats.p95).toBe(95)
    expect(stats.p99).toBe(99)
  })

  it('should handle empty histogram', () => {
    const snapshot = metrics.getSnapshot()
    const stats = snapshot.parseDuration.stats

    expect(stats.count).toBe(0)
    expect(stats.sum).toBe(0)
    expect(stats.mean).toBe(0)
    expect(stats.p50).toBe(0)
    expect(stats.p95).toBe(0)
    expect(stats.p99).toBe(0)
  })

  it('should handle single value', () => {
    metrics.recordParseDuration('typescript', 42)

    const snapshot = metrics.getSnapshot()
    const stats = snapshot.parseDuration.stats

    expect(stats.count).toBe(1)
    expect(stats.sum).toBe(42)
    expect(stats.mean).toBe(42)
    expect(stats.p50).toBe(42)
    expect(stats.p95).toBe(42)
    expect(stats.p99).toBe(42)
  })
})

describe('Integration with analysis components', () => {
  let metrics: AnalysisMetrics

  beforeEach(() => {
    metrics = new AnalysisMetrics()
  })

  it('should track complete analysis workflow', () => {
    // Simulate analysis workflow
    const languages = ['typescript', 'python', 'go'] as const

    // Parse files
    for (const lang of languages) {
      for (let i = 0; i < 10; i++) {
        metrics.recordFileParsed(lang)
        metrics.recordParseDuration(lang, Math.random() * 50)
      }
    }

    // Cache operations
    for (let i = 0; i < 100; i++) {
      if (Math.random() > 0.2) {
        metrics.recordCacheHit()
      } else {
        metrics.recordCacheMiss()
      }
    }

    // Worker pool
    metrics.updateWorkerPool(4, 20, 8)

    // Errors
    metrics.recordError('parse_error', 'typescript')
    metrics.recordError('timeout')

    // Aggregator
    metrics.updateAggregatorStats(30, 150, 50, 100)

    // Memory
    metrics.updateMemoryUsage()

    // Get final snapshot
    const snapshot = metrics.getSnapshot()

    // Verify comprehensive data
    expect(snapshot.filesParsed.total).toBe(30)
    expect(Object.keys(snapshot.filesParsed.byLanguage)).toHaveLength(3)
    expect(snapshot.parseDuration.stats.count).toBe(30)
    expect(snapshot.cache.hits + snapshot.cache.misses).toBe(100)
    expect(snapshot.cache.hitRate).toBeGreaterThan(0)
    expect(snapshot.workerPool.activeWorkers).toBe(4)
    expect(snapshot.errors.total).toBe(2)
    expect(snapshot.aggregator.filesProcessed).toBe(30)
    expect(snapshot.memory.heapUsed).toBeGreaterThan(0)
  })
})
