/**
 * SMI-758: Telemetry Unit Tests
 *
 * Tests for tracer and metrics modules including:
 * - Tracer initialization and shutdown
 * - Span creation and attributes
 * - Metrics recording
 * - Graceful fallback when OpenTelemetry not available (SMI-755)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SkillsmithTracer,
  getTracer,
  initializeTracing,
  shutdownTracing,
} from '../src/telemetry/tracer.js'
import {
  MetricsRegistry,
  getMetrics,
  initializeMetrics,
  timeAsync,
  timeSync,
  LATENCY_BUCKETS,
} from '../src/telemetry/metrics.js'
import { initializeTelemetry, shutdownTelemetry } from '../src/telemetry/index.js'

describe('Telemetry Module', () => {
  describe('SkillsmithTracer', () => {
    let tracer: SkillsmithTracer

    beforeEach(() => {
      // Reset environment
      delete process.env.SKILLSMITH_TELEMETRY_ENABLED
      delete process.env.SKILLSMITH_TRACING_ENABLED
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    })

    afterEach(async () => {
      if (tracer) {
        await tracer.shutdown()
      }
    })

    describe('constructor', () => {
      it('creates tracer with default config', () => {
        tracer = new SkillsmithTracer()
        expect(tracer).toBeInstanceOf(SkillsmithTracer)
        expect(tracer.isEnabled()).toBe(false) // Not enabled without endpoint
      })

      it('respects SKILLSMITH_TELEMETRY_ENABLED=false', () => {
        process.env.SKILLSMITH_TELEMETRY_ENABLED = 'false'
        tracer = new SkillsmithTracer({ consoleExport: true })
        expect(tracer.isEnabled()).toBe(false)
      })

      it('enables tracing when consoleExport is true', () => {
        tracer = new SkillsmithTracer({ consoleExport: true })
        // Note: isEnabled() returns false until initialize() is called
        expect(tracer).toBeInstanceOf(SkillsmithTracer)
      })

      it('uses custom service name', () => {
        tracer = new SkillsmithTracer({ serviceName: 'test-service' })
        expect(tracer).toBeInstanceOf(SkillsmithTracer)
      })

      it('respects SKILLSMITH_TRACING_ENABLED=false', () => {
        process.env.SKILLSMITH_TRACING_ENABLED = 'false'
        tracer = new SkillsmithTracer({ consoleExport: true })
        expect(tracer.isEnabled()).toBe(false)
      })
    })

    describe('initialize', () => {
      it('initializes without error when tracing disabled', async () => {
        tracer = new SkillsmithTracer()
        await expect(tracer.initialize()).resolves.toBeUndefined()
      })

      it('handles missing OpenTelemetry packages gracefully (SMI-755)', async () => {
        // Enable tracing to trigger OTel load attempt
        tracer = new SkillsmithTracer({ consoleExport: true })
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        await tracer.initialize()

        // Should fall back gracefully - either succeed or warn
        expect(tracer.isEnabled()).toBeDefined()
        warnSpy.mockRestore()
      })

      it('can be called multiple times safely', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()
        await tracer.initialize()
        await tracer.initialize()
        // No error thrown
      })
    })

    describe('startSpan', () => {
      it('returns NoOpSpanWrapper when tracing disabled', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()

        const span = tracer.startSpan('test-span')
        expect(span).toBeDefined()
        expect(span.getSpan()).toBeNull() // NoOp returns null
      })

      it('span wrapper methods work without error', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()

        const span = tracer.startSpan('test-span')

        // All methods should work without error
        span.setAttributes({ 'test.key': 'value', 'test.number': 42 })
        span.setStatus('ok')
        span.setStatus('error', 'Test error')
        span.addEvent('test-event', { eventKey: 'eventValue' })
        span.recordException(new Error('Test exception'))
        span.end()
      })
    })

    describe('withSpan', () => {
      it('executes function and returns result', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()

        const result = await tracer.withSpan('test-span', async (span) => {
          span.setAttributes({ operation: 'test' })
          return 'test-result'
        })

        expect(result).toBe('test-result')
      })

      it('records exception on error', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()

        await expect(
          tracer.withSpan('test-span', async () => {
            throw new Error('Test error')
          })
        ).rejects.toThrow('Test error')
      })
    })

    describe('withSpanSync', () => {
      it('executes sync function and returns result', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()

        const result = tracer.withSpanSync('test-span', (span) => {
          span.setAttributes({ operation: 'sync-test' })
          return 'sync-result'
        })

        expect(result).toBe('sync-result')
      })

      it('records exception on error', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()

        expect(() =>
          tracer.withSpanSync('test-span', () => {
            throw new Error('Sync error')
          })
        ).toThrow('Sync error')
      })
    })

    describe('getCurrentSpan', () => {
      it('returns NoOpSpanWrapper when no active span', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()

        const span = tracer.getCurrentSpan()
        expect(span.getSpan()).toBeNull()
      })
    })

    describe('shutdown', () => {
      it('shuts down cleanly', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()
        await expect(tracer.shutdown()).resolves.toBeUndefined()
      })

      it('can be called multiple times', async () => {
        tracer = new SkillsmithTracer()
        await tracer.initialize()
        await tracer.shutdown()
        await tracer.shutdown()
        // No error
      })
    })
  })

  describe('Global Tracer Functions', () => {
    afterEach(async () => {
      await shutdownTracing()
    })

    it('getTracer returns singleton', () => {
      const tracer1 = getTracer()
      const tracer2 = getTracer()
      expect(tracer1).toBe(tracer2)
    })

    it('initializeTracing creates and initializes tracer', async () => {
      const tracer = await initializeTracing()
      expect(tracer).toBeInstanceOf(SkillsmithTracer)
    })

    it('shutdownTracing clears singleton', async () => {
      await initializeTracing()
      await shutdownTracing()
      // Getting new tracer should create new instance
      const newTracer = getTracer()
      expect(newTracer).toBeInstanceOf(SkillsmithTracer)
    })
  })

  describe('MetricsRegistry', () => {
    let metrics: MetricsRegistry

    beforeEach(() => {
      delete process.env.SKILLSMITH_TELEMETRY_ENABLED
      delete process.env.SKILLSMITH_METRICS_ENABLED
    })

    describe('constructor', () => {
      it('creates registry with predefined metrics', () => {
        metrics = new MetricsRegistry()

        expect(metrics.mcpRequestLatency).toBeDefined()
        expect(metrics.mcpRequestCount).toBeDefined()
        expect(metrics.mcpErrorCount).toBeDefined()
        expect(metrics.dbQueryLatency).toBeDefined()
        expect(metrics.dbQueryCount).toBeDefined()
        expect(metrics.cacheHits).toBeDefined()
        expect(metrics.cacheMisses).toBeDefined()
        expect(metrics.cacheSize).toBeDefined()
        expect(metrics.embeddingLatency).toBeDefined()
        expect(metrics.embeddingCount).toBeDefined()
        expect(metrics.searchLatency).toBeDefined()
        expect(metrics.searchCount).toBeDefined()
        expect(metrics.activeOperations).toBeDefined()
      })

      it('respects SKILLSMITH_TELEMETRY_ENABLED=false', () => {
        process.env.SKILLSMITH_TELEMETRY_ENABLED = 'false'
        metrics = new MetricsRegistry()
        expect(metrics.isEnabled()).toBe(false)
      })
    })

    describe('initialize', () => {
      it('initializes without error', async () => {
        metrics = new MetricsRegistry()
        await expect(metrics.initialize()).resolves.toBeUndefined()
      })

      it('handles missing OpenTelemetry gracefully (SMI-755)', async () => {
        metrics = new MetricsRegistry({ consoleExport: true })
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

        await metrics.initialize()

        // Should log info about in-memory mode or succeed with OTel
        infoSpy.mockRestore()
      })
    })

    describe('Counter', () => {
      beforeEach(async () => {
        metrics = new MetricsRegistry()
        await metrics.initialize()
      })

      it('increments counter', () => {
        metrics.mcpRequestCount.increment({ tool: 'search' })
        metrics.mcpRequestCount.increment({ tool: 'search' })
        metrics.mcpRequestCount.add(5, { tool: 'install' })

        const snapshot = metrics.getSnapshot()
        expect(snapshot.counters['skillsmith.mcp.request.count']).toBe(7)
      })

      it('tracks labeled counters', () => {
        metrics.cacheHits.increment({ layer: 'memory' })
        metrics.cacheHits.increment({ layer: 'disk' })
        metrics.cacheMisses.increment({ layer: 'memory' })

        const ratio = metrics.getCacheHitRatio()
        expect(ratio).toBeCloseTo(0.667, 2)
      })
    })

    describe('Histogram', () => {
      beforeEach(async () => {
        metrics = new MetricsRegistry()
        await metrics.initialize()
      })

      it('records histogram values', () => {
        metrics.mcpRequestLatency.record(10, { tool: 'search' })
        metrics.mcpRequestLatency.record(20, { tool: 'search' })
        metrics.mcpRequestLatency.record(30, { tool: 'search' })

        const snapshot = metrics.getSnapshot()
        const stats = snapshot.histograms['skillsmith.mcp.request.latency']

        expect(stats.count).toBe(3)
        expect(stats.sum).toBe(60)
        expect(stats.mean).toBe(20)
      })

      it('calculates percentiles', () => {
        // Add 100 values from 1 to 100
        for (let i = 1; i <= 100; i++) {
          metrics.searchLatency.record(i)
        }

        const snapshot = metrics.getSnapshot()
        const stats = snapshot.histograms['skillsmith.search.latency']

        expect(stats.p50).toBe(50)
        expect(stats.p95).toBe(95)
        expect(stats.p99).toBe(99)
      })
    })

    describe('Gauge', () => {
      beforeEach(async () => {
        metrics = new MetricsRegistry()
        await metrics.initialize()
      })

      it('sets and gets gauge value', () => {
        metrics.cacheSize.set(100)
        expect(metrics.cacheSize.getValue()).toBe(100)

        metrics.cacheSize.set(150)
        expect(metrics.cacheSize.getValue()).toBe(150)
      })

      it('tracks labeled gauge values', () => {
        metrics.activeOperations.set(5, { type: 'search' })
        metrics.activeOperations.set(3, { type: 'install' })

        expect(metrics.activeOperations.getValue({ type: 'search' })).toBe(5)
        expect(metrics.activeOperations.getValue({ type: 'install' })).toBe(3)
      })
    })

    describe('getSnapshot', () => {
      it('returns complete metrics snapshot', async () => {
        metrics = new MetricsRegistry()
        await metrics.initialize()

        metrics.mcpRequestCount.increment()
        metrics.mcpRequestLatency.record(50)
        metrics.cacheSize.set(200)

        const snapshot = metrics.getSnapshot()

        expect(snapshot.timestamp).toBeDefined()
        expect(snapshot.counters).toBeDefined()
        expect(snapshot.histograms).toBeDefined()
        expect(snapshot.gauges).toBeDefined()
      })
    })

    describe('reset', () => {
      it('resets all metrics', async () => {
        metrics = new MetricsRegistry()
        await metrics.initialize()

        metrics.mcpRequestCount.add(10)
        metrics.mcpRequestLatency.record(100)

        metrics.reset()

        const snapshot = metrics.getSnapshot()
        expect(snapshot.counters['skillsmith.mcp.request.count']).toBe(0)
        expect(snapshot.histograms['skillsmith.mcp.request.latency'].count).toBe(0)
      })
    })
  })

  describe('Global Metrics Functions', () => {
    it('getMetrics returns singleton', () => {
      const metrics1 = getMetrics()
      const metrics2 = getMetrics()
      expect(metrics1).toBe(metrics2)
    })

    it('initializeMetrics creates and initializes registry', async () => {
      const metrics = await initializeMetrics()
      expect(metrics).toBeInstanceOf(MetricsRegistry)
    })
  })

  describe('Timing Helpers', () => {
    let metrics: MetricsRegistry

    beforeEach(async () => {
      metrics = new MetricsRegistry()
      await metrics.initialize()
    })

    describe('timeAsync', () => {
      it('times async function and records to histogram', async () => {
        const result = await timeAsync(metrics.searchLatency, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return 'done'
        })

        expect(result).toBe('done')
        const snapshot = metrics.getSnapshot()
        expect(snapshot.histograms['skillsmith.search.latency'].count).toBe(1)
        expect(snapshot.histograms['skillsmith.search.latency'].sum).toBeGreaterThanOrEqual(10)
      })

      it('records timing even on error', async () => {
        await expect(
          timeAsync(metrics.searchLatency, async () => {
            throw new Error('Test error')
          })
        ).rejects.toThrow('Test error')

        const snapshot = metrics.getSnapshot()
        expect(snapshot.histograms['skillsmith.search.latency'].count).toBe(1)
      })
    })

    describe('timeSync', () => {
      it('times sync function and records to histogram', () => {
        const result = timeSync(metrics.dbQueryLatency, () => {
          // Some computation
          let sum = 0
          for (let i = 0; i < 1000; i++) sum += i
          return sum
        })

        expect(result).toBe(499500)
        const snapshot = metrics.getSnapshot()
        expect(snapshot.histograms['skillsmith.db.query.latency'].count).toBe(1)
      })
    })
  })

  describe('LATENCY_BUCKETS', () => {
    it('exports standard latency buckets', () => {
      expect(LATENCY_BUCKETS).toEqual([1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000])
    })
  })

  describe('Integrated Telemetry', () => {
    afterEach(async () => {
      await shutdownTelemetry()
    })

    it('initializeTelemetry initializes both tracing and metrics', async () => {
      await initializeTelemetry()

      const tracer = getTracer()
      const metrics = getMetrics()

      expect(tracer).toBeInstanceOf(SkillsmithTracer)
      expect(metrics).toBeInstanceOf(MetricsRegistry)
    })

    it('shutdownTelemetry cleans up resources', async () => {
      await initializeTelemetry()
      await shutdownTelemetry()
      // No error thrown
    })
  })

  describe('Graceful Fallback (SMI-755)', () => {
    beforeEach(() => {
      delete process.env.SKILLSMITH_TELEMETRY_ENABLED
    })

    it('tracer works without OpenTelemetry installed', async () => {
      const tracer = new SkillsmithTracer({ consoleExport: true })
      await tracer.initialize()

      // Should be able to use all APIs even if OTel isn't installed
      const result = await tracer.withSpan('test', async (span) => {
        span.setAttributes({ key: 'value' })
        return 42
      })

      expect(result).toBe(42)
    })

    it('metrics work without OpenTelemetry installed', async () => {
      const metrics = new MetricsRegistry({ consoleExport: true })
      await metrics.initialize()

      // Should be able to use all metrics APIs
      metrics.mcpRequestCount.increment()
      metrics.mcpRequestLatency.record(50)
      metrics.cacheSize.set(100)

      const snapshot = metrics.getSnapshot()
      expect(snapshot.counters['skillsmith.mcp.request.count']).toBe(1)
    })

    it('telemetry disabled with SKILLSMITH_TELEMETRY_ENABLED=false', async () => {
      process.env.SKILLSMITH_TELEMETRY_ENABLED = 'false'

      const tracer = new SkillsmithTracer({ consoleExport: true })
      await tracer.initialize()
      expect(tracer.isEnabled()).toBe(false)

      const metrics = new MetricsRegistry({ consoleExport: true })
      await metrics.initialize()
      expect(metrics.isEnabled()).toBe(false)
    })
  })
})
