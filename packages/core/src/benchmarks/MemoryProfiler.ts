/**
 * SMI-689: MemoryProfiler - Memory profiling for benchmark infrastructure
 *
 * Features:
 * - Track memory usage for labeled operations
 * - Detect memory leaks over threshold
 * - Get heap snapshots using V8 statistics
 * - Generate human-readable memory reports
 * - Baseline comparison for memory regression detection
 */

import * as v8 from 'v8'

/**
 * Memory snapshot at a point in time
 */
export interface MemorySnapshot {
  /** Timestamp when snapshot was taken */
  timestamp: number
  /** Total heap size in bytes */
  totalHeapSize: number
  /** Used heap size in bytes */
  usedHeapSize: number
  /** External memory in bytes (ArrayBuffers, etc.) */
  externalMemory: number
  /** Heap size limit in bytes */
  heapSizeLimit: number
  /** Total physical memory allocated in bytes */
  totalPhysicalSize: number
  /** Total available memory in bytes */
  totalAvailableSize: number
  /** Malloced memory in bytes */
  mallocedMemory: number
  /** Peak malloced memory in bytes */
  peakMallocedMemory: number
}

/**
 * Statistics for a tracked memory operation
 */
export interface MemoryStats {
  /** Label for the tracked operation */
  label: string
  /** Start snapshot */
  startSnapshot: MemorySnapshot
  /** End snapshot (undefined if still tracking) */
  endSnapshot?: MemorySnapshot
  /** Duration in milliseconds */
  duration: number
  /** Heap growth in bytes */
  heapGrowth: number
  /** Heap growth as percentage */
  heapGrowthPercent: number
  /** Peak heap usage during tracking */
  peakHeapUsed: number
  /** Number of samples taken */
  sampleCount: number
}

/**
 * Memory baseline for regression comparison
 */
export interface MemoryBaseline {
  /** Label for the baseline */
  label: string
  /** Timestamp when baseline was created */
  timestamp: string
  /** Average heap usage in bytes */
  avgHeapUsed: number
  /** Peak heap usage in bytes */
  peakHeapUsed: number
  /** Number of samples in baseline */
  sampleCount: number
}

/**
 * Result of leak detection
 */
export interface LeakDetectionResult {
  /** Whether potential leaks were detected */
  hasLeaks: boolean
  /** Threshold used for detection (percentage) */
  threshold: number
  /** Actual heap growth percentage */
  heapGrowthPercent: number
  /** Bytes of suspected leak */
  leakedBytes: number
  /** Labels of operations with suspected leaks */
  suspectedLabels: string[]
  /** Detailed message */
  message: string
}

/**
 * Memory regression result
 */
export interface MemoryRegressionResult {
  /** Whether regression was detected */
  hasRegression: boolean
  /** Threshold used (percentage) */
  threshold: number
  /** Label of the operation */
  label: string
  /** Baseline heap usage */
  baselineHeap: number
  /** Current heap usage */
  currentHeap: number
  /** Change percentage */
  changePercent: number
  /** Detailed message */
  message: string
}

/**
 * Tracking entry for an operation
 */
interface TrackingEntry {
  label: string
  startSnapshot: MemorySnapshot
  startTime: number
  samples: MemorySnapshot[]
  samplingInterval?: NodeJS.Timeout
}

/**
 * MemoryProfiler provides comprehensive memory tracking and leak detection
 * for the benchmark infrastructure.
 *
 * @example
 * ```typescript
 * const profiler = new MemoryProfiler();
 *
 * profiler.trackMemory('heavy_operation');
 * await heavyOperation();
 * const stats = profiler.stopTracking('heavy_operation');
 *
 * console.log(`Heap grew by ${stats.heapGrowthPercent}%`);
 *
 * // Check for leaks
 * const leakResult = profiler.detectLeaks(10);
 * if (leakResult.hasLeaks) {
 *   console.error(leakResult.message);
 * }
 * ```
 */
export class MemoryProfiler {
  private activeTracking: Map<string, TrackingEntry> = new Map()
  private completedStats: Map<string, MemoryStats> = new Map()
  private baselines: Map<string, MemoryBaseline> = new Map()
  private samplingIntervalMs: number

  /**
   * Create a new MemoryProfiler instance
   *
   * @param samplingIntervalMs - Interval in ms for collecting memory samples (default: 100ms)
   */
  constructor(samplingIntervalMs: number = 100) {
    this.samplingIntervalMs = samplingIntervalMs
  }

  /**
   * Start tracking memory for a labeled operation
   *
   * @param label - Unique label to identify this tracking session
   * @throws Error if label is already being tracked
   *
   * @example
   * ```typescript
   * profiler.trackMemory('database_query');
   * ```
   */
  trackMemory(label: string): void {
    if (this.activeTracking.has(label)) {
      throw new Error(`Memory tracking already active for label: ${label}`)
    }

    // Force GC if available for more accurate starting point
    this.forceGC()

    const startSnapshot = this.getHeapSnapshot()
    const entry: TrackingEntry = {
      label,
      startSnapshot,
      startTime: performance.now(),
      samples: [startSnapshot],
    }

    // Start periodic sampling
    entry.samplingInterval = setInterval(() => {
      const snapshot = this.getHeapSnapshot()
      entry.samples.push(snapshot)
    }, this.samplingIntervalMs)

    this.activeTracking.set(label, entry)
  }

  /**
   * Stop tracking memory for a labeled operation and return statistics
   *
   * @param label - Label of the tracking session to stop
   * @returns Memory statistics for the tracked operation
   * @throws Error if label is not being tracked
   *
   * @example
   * ```typescript
   * const stats = profiler.stopTracking('database_query');
   * console.log(`Heap growth: ${stats.heapGrowthPercent}%`);
   * ```
   */
  stopTracking(label: string): MemoryStats {
    const entry = this.activeTracking.get(label)
    if (!entry) {
      throw new Error(`No active memory tracking for label: ${label}`)
    }

    // Stop sampling
    if (entry.samplingInterval) {
      clearInterval(entry.samplingInterval)
    }

    // Force GC for accurate end measurement
    this.forceGC()

    const endSnapshot = this.getHeapSnapshot()
    const duration = performance.now() - entry.startTime

    // Calculate peak from samples
    const peakHeapUsed = Math.max(
      entry.startSnapshot.usedHeapSize,
      ...entry.samples.map((s) => s.usedHeapSize),
      endSnapshot.usedHeapSize
    )

    const heapGrowth = endSnapshot.usedHeapSize - entry.startSnapshot.usedHeapSize
    const heapGrowthPercent =
      entry.startSnapshot.usedHeapSize > 0
        ? (heapGrowth / entry.startSnapshot.usedHeapSize) * 100
        : 0

    const stats: MemoryStats = {
      label,
      startSnapshot: entry.startSnapshot,
      endSnapshot,
      duration,
      heapGrowth,
      heapGrowthPercent: Math.round(heapGrowthPercent * 100) / 100,
      peakHeapUsed,
      sampleCount: entry.samples.length + 1,
    }

    this.completedStats.set(label, stats)
    this.activeTracking.delete(label)

    return stats
  }

  /**
   * Get current heap statistics using V8
   *
   * @returns Current memory snapshot
   *
   * @example
   * ```typescript
   * const snapshot = profiler.getHeapSnapshot();
   * console.log(`Used heap: ${snapshot.usedHeapSize / 1024 / 1024} MB`);
   * ```
   */
  getHeapSnapshot(): MemorySnapshot {
    const heapStats = v8.getHeapStatistics()
    const memUsage = process.memoryUsage()

    return {
      timestamp: Date.now(),
      totalHeapSize: heapStats.total_heap_size,
      usedHeapSize: heapStats.used_heap_size,
      externalMemory: memUsage.external,
      heapSizeLimit: heapStats.heap_size_limit,
      totalPhysicalSize: heapStats.total_physical_size,
      totalAvailableSize: heapStats.total_available_size,
      mallocedMemory: heapStats.malloced_memory,
      peakMallocedMemory: heapStats.peak_malloced_memory,
    }
  }

  /**
   * Detect potential memory leaks across all completed tracking sessions
   *
   * @param threshold - Heap growth percentage threshold to consider a leak (default: 10%)
   * @returns Leak detection result
   *
   * @example
   * ```typescript
   * const result = profiler.detectLeaks(15); // 15% threshold
   * if (result.hasLeaks) {
   *   console.error(`Potential leak detected: ${result.message}`);
   * }
   * ```
   */
  detectLeaks(threshold: number = 10): LeakDetectionResult {
    const suspectedLabels: string[] = []
    let totalLeakedBytes = 0
    let maxGrowthPercent = 0

    for (const [label, stats] of this.completedStats) {
      if (stats.heapGrowthPercent > threshold) {
        suspectedLabels.push(label)
        totalLeakedBytes += stats.heapGrowth
        maxGrowthPercent = Math.max(maxGrowthPercent, stats.heapGrowthPercent)
      }
    }

    const hasLeaks = suspectedLabels.length > 0

    return {
      hasLeaks,
      threshold,
      heapGrowthPercent: Math.round(maxGrowthPercent * 100) / 100,
      leakedBytes: totalLeakedBytes,
      suspectedLabels,
      message: hasLeaks
        ? `Potential memory leak detected in ${suspectedLabels.length} operation(s): ${suspectedLabels.join(', ')}. ` +
          `Total leaked: ${this.formatBytes(totalLeakedBytes)}, max growth: ${maxGrowthPercent.toFixed(2)}%`
        : `No memory leaks detected (threshold: ${threshold}%)`,
    }
  }

  /**
   * Save a baseline for memory regression comparison
   *
   * @param label - Label to save as baseline
   * @throws Error if no completed stats exist for the label
   */
  saveBaseline(label: string): MemoryBaseline {
    const stats = this.completedStats.get(label)
    if (!stats) {
      throw new Error(`No completed stats for label: ${label}`)
    }

    const baseline: MemoryBaseline = {
      label,
      timestamp: new Date().toISOString(),
      avgHeapUsed:
        stats.startSnapshot.usedHeapSize +
        (stats.endSnapshot?.usedHeapSize ?? stats.startSnapshot.usedHeapSize),
      peakHeapUsed: stats.peakHeapUsed,
      sampleCount: stats.sampleCount,
    }
    baseline.avgHeapUsed = baseline.avgHeapUsed / 2

    this.baselines.set(label, baseline)
    return baseline
  }

  /**
   * Load baselines from a JSON object
   *
   * @param baselines - Object mapping labels to baselines
   */
  loadBaselines(baselines: Record<string, MemoryBaseline>): void {
    for (const [label, baseline] of Object.entries(baselines)) {
      this.baselines.set(label, baseline)
    }
  }

  /**
   * Check for memory regression against baseline
   *
   * @param label - Label to check
   * @param threshold - Regression threshold percentage (default: 10%)
   * @returns Regression result
   */
  checkRegression(label: string, threshold: number = 10): MemoryRegressionResult {
    const baseline = this.baselines.get(label)
    const current = this.completedStats.get(label)

    if (!baseline) {
      return {
        hasRegression: false,
        threshold,
        label,
        baselineHeap: 0,
        currentHeap: current?.peakHeapUsed ?? 0,
        changePercent: 0,
        message: `No baseline exists for label: ${label}`,
      }
    }

    if (!current) {
      return {
        hasRegression: false,
        threshold,
        label,
        baselineHeap: baseline.peakHeapUsed,
        currentHeap: 0,
        changePercent: 0,
        message: `No current stats exist for label: ${label}`,
      }
    }

    const changePercent =
      baseline.peakHeapUsed > 0
        ? ((current.peakHeapUsed - baseline.peakHeapUsed) / baseline.peakHeapUsed) * 100
        : 0

    const hasRegression = changePercent > threshold

    return {
      hasRegression,
      threshold,
      label,
      baselineHeap: baseline.peakHeapUsed,
      currentHeap: current.peakHeapUsed,
      changePercent: Math.round(changePercent * 100) / 100,
      message: hasRegression
        ? `Memory regression detected for ${label}: heap grew by ${changePercent.toFixed(2)}% ` +
          `(${this.formatBytes(baseline.peakHeapUsed)} -> ${this.formatBytes(current.peakHeapUsed)})`
        : `No memory regression for ${label} (change: ${changePercent.toFixed(2)}%)`,
    }
  }

  /**
   * Generate a human-readable memory report
   *
   * @returns Formatted memory report string
   *
   * @example
   * ```typescript
   * profiler.trackMemory('op1');
   * await operation1();
   * profiler.stopTracking('op1');
   *
   * console.log(profiler.formatMemoryReport());
   * ```
   */
  formatMemoryReport(): string {
    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════════════════╗',
      '║                        SMI-689: Memory Profiling Report                       ║',
      '╠══════════════════════════════════════════════════════════════════════════════╣',
    ]

    // Current heap snapshot
    const current = this.getHeapSnapshot()
    lines.push('║ Current Heap Status:                                                          ║')
    lines.push(
      `║   Used Heap:      ${this.formatBytes(current.usedHeapSize).padEnd(15)} │ Total Heap:  ${this.formatBytes(current.totalHeapSize).padEnd(15)}  ║`
    )
    lines.push(
      `║   Heap Limit:     ${this.formatBytes(current.heapSizeLimit).padEnd(15)} │ External:    ${this.formatBytes(current.externalMemory).padEnd(15)}  ║`
    )
    lines.push('║                                                                               ║')

    // Completed tracking stats
    if (this.completedStats.size > 0) {
      lines.push(
        '║ Tracked Operations:                                                           ║'
      )
      lines.push('║ ─────────────────────────────────────────────────────────────────────────────║')

      for (const [label, stats] of this.completedStats) {
        const growthColor =
          stats.heapGrowthPercent > 10 ? '!' : stats.heapGrowthPercent > 5 ? '~' : ' '
        lines.push(
          `║ ${growthColor} ${label.substring(0, 25).padEnd(25)} │ Duration: ${stats.duration.toFixed(0).padStart(6)}ms │ Growth: ${stats.heapGrowthPercent.toFixed(1).padStart(6)}% ║`
        )
        lines.push(
          `║     Start: ${this.formatBytes(stats.startSnapshot.usedHeapSize).padEnd(10)} │ End: ${this.formatBytes(stats.endSnapshot?.usedHeapSize ?? 0).padEnd(10)} │ Peak: ${this.formatBytes(stats.peakHeapUsed).padEnd(10)} ║`
        )
      }
    } else {
      lines.push(
        '║ No tracked operations recorded.                                               ║'
      )
    }

    // Active tracking
    if (this.activeTracking.size > 0) {
      lines.push(
        '║                                                                               ║'
      )
      lines.push(
        '║ Active Tracking:                                                              ║'
      )
      for (const [label, entry] of this.activeTracking) {
        const elapsed = (performance.now() - entry.startTime).toFixed(0)
        lines.push(
          `║   ${label.substring(0, 30).padEnd(30)} │ Elapsed: ${elapsed.padStart(6)}ms │ Samples: ${String(entry.samples.length).padStart(4)} ║`
        )
      }
    }

    // Leak detection summary
    const leakResult = this.detectLeaks(10)
    lines.push('║                                                                               ║')
    lines.push('║ Leak Detection (10% threshold):                                               ║')
    if (leakResult.hasLeaks) {
      lines.push(
        `║   ⚠ POTENTIAL LEAKS DETECTED                                                  ║`
      )
      lines.push(
        `║   Suspected: ${leakResult.suspectedLabels.slice(0, 3).join(', ').substring(0, 60).padEnd(60)}  ║`
      )
      lines.push(
        `║   Total leaked: ${this.formatBytes(leakResult.leakedBytes).padEnd(15)} │ Max growth: ${leakResult.heapGrowthPercent.toFixed(1).padStart(6)}%     ║`
      )
    } else {
      lines.push(
        `║   ✓ No memory leaks detected                                                  ║`
      )
    }

    lines.push('╚══════════════════════════════════════════════════════════════════════════════╝')

    return lines.join('\n')
  }

  /**
   * Get all completed statistics
   *
   * @returns Map of label to MemoryStats
   */
  getCompletedStats(): Map<string, MemoryStats> {
    return new Map(this.completedStats)
  }

  /**
   * Get all baselines
   *
   * @returns Map of label to MemoryBaseline
   */
  getBaselines(): Map<string, MemoryBaseline> {
    return new Map(this.baselines)
  }

  /**
   * Export baselines as JSON-serializable object
   *
   * @returns Object mapping labels to baselines
   */
  exportBaselines(): Record<string, MemoryBaseline> {
    const result: Record<string, MemoryBaseline> = {}
    for (const [label, baseline] of this.baselines) {
      result[label] = baseline
    }
    return result
  }

  /**
   * Clear all tracking data
   */
  clear(): void {
    // Stop any active tracking
    for (const entry of this.activeTracking.values()) {
      if (entry.samplingInterval) {
        clearInterval(entry.samplingInterval)
      }
    }
    this.activeTracking.clear()
    this.completedStats.clear()
  }

  /**
   * Clear baselines
   */
  clearBaselines(): void {
    this.baselines.clear()
  }

  /**
   * Force garbage collection if available
   */
  private forceGC(): void {
    if (typeof global.gc === 'function') {
      global.gc()
    }
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k))
    const value = bytes / Math.pow(k, i)
    return `${value.toFixed(1)} ${sizes[i]}`
  }
}

/**
 * Default memory profiler instance for convenience
 */
export const defaultMemoryProfiler = new MemoryProfiler()
