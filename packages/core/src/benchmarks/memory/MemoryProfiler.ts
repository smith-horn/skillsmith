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

import type {
  MemorySnapshot,
  MemoryStats,
  MemoryBaseline,
  LeakDetectionResult,
  MemoryRegressionResult,
  TrackingEntry,
} from './types.js'
import { BaselineManager } from './baseline-manager.js'
import { detectLeaks } from './leak-detector.js'
import { checkRegression } from './regression-detector.js'
import { formatBytes, forceGC } from './utils.js'

// Re-export types for backward compatibility
export type {
  MemorySnapshot,
  MemoryStats,
  MemoryBaseline,
  LeakDetectionResult,
  MemoryRegressionResult,
} from './types.js'

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
  private baselineManager: BaselineManager = new BaselineManager()
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
    forceGC()

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
    forceGC()

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
    return detectLeaks(this.completedStats, threshold)
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
    return this.baselineManager.saveBaseline(label, stats)
  }

  /**
   * Load baselines from a JSON object
   *
   * @param baselines - Object mapping labels to baselines
   */
  loadBaselines(baselines: Record<string, MemoryBaseline>): void {
    this.baselineManager.loadBaselines(baselines)
  }

  /**
   * Check for memory regression against baseline
   *
   * @param label - Label to check
   * @param threshold - Regression threshold percentage (default: 10%)
   * @returns Regression result
   */
  checkRegression(label: string, threshold: number = 10): MemoryRegressionResult {
    return checkRegression(
      label,
      this.baselineManager.getBaseline(label),
      this.completedStats.get(label),
      threshold
    )
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
      '===================================================================================================',
      '                        SMI-689: Memory Profiling Report                       ',
      '===================================================================================================',
    ]

    // Current heap snapshot
    const current = this.getHeapSnapshot()
    lines.push(' Current Heap Status:                                                          ')
    lines.push(
      `   Used Heap:      ${formatBytes(current.usedHeapSize).padEnd(15)} | Total Heap:  ${formatBytes(current.totalHeapSize).padEnd(15)}  `
    )
    lines.push(
      `   Heap Limit:     ${formatBytes(current.heapSizeLimit).padEnd(15)} | External:    ${formatBytes(current.externalMemory).padEnd(15)}  `
    )
    lines.push('                                                                               ')

    // Completed tracking stats
    if (this.completedStats.size > 0) {
      lines.push(
        ' Tracked Operations:                                                           '
      )
      lines.push('---------------------------------------------------------------------------------------------------')

      for (const [label, stats] of this.completedStats) {
        const growthColor =
          stats.heapGrowthPercent > 10 ? '!' : stats.heapGrowthPercent > 5 ? '~' : ' '
        lines.push(
          ` ${growthColor} ${label.substring(0, 25).padEnd(25)} | Duration: ${stats.duration.toFixed(0).padStart(6)}ms | Growth: ${stats.heapGrowthPercent.toFixed(1).padStart(6)}% `
        )
        lines.push(
          `     Start: ${formatBytes(stats.startSnapshot.usedHeapSize).padEnd(10)} | End: ${formatBytes(stats.endSnapshot?.usedHeapSize ?? 0).padEnd(10)} | Peak: ${formatBytes(stats.peakHeapUsed).padEnd(10)} `
        )
      }
    } else {
      lines.push(
        ' No tracked operations recorded.                                               '
      )
    }

    // Active tracking
    if (this.activeTracking.size > 0) {
      lines.push(
        '                                                                               '
      )
      lines.push(
        ' Active Tracking:                                                              '
      )
      for (const [label, entry] of this.activeTracking) {
        const elapsed = (performance.now() - entry.startTime).toFixed(0)
        lines.push(
          `   ${label.substring(0, 30).padEnd(30)} | Elapsed: ${elapsed.padStart(6)}ms | Samples: ${String(entry.samples.length).padStart(4)} `
        )
      }
    }

    // Leak detection summary
    const leakResult = this.detectLeaks(10)
    lines.push('                                                                               ')
    lines.push(' Leak Detection (10% threshold):                                               ')
    if (leakResult.hasLeaks) {
      lines.push(
        `   WARNING: POTENTIAL LEAKS DETECTED                                                  `
      )
      lines.push(
        `   Suspected: ${leakResult.suspectedLabels.slice(0, 3).join(', ').substring(0, 60).padEnd(60)}  `
      )
      lines.push(
        `   Total leaked: ${formatBytes(leakResult.leakedBytes).padEnd(15)} | Max growth: ${leakResult.heapGrowthPercent.toFixed(1).padStart(6)}%     `
      )
    } else {
      lines.push(
        `   OK: No memory leaks detected                                                  `
      )
    }

    lines.push('===================================================================================================')

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
    return this.baselineManager.getBaselines()
  }

  /**
   * Export baselines as JSON-serializable object
   *
   * @returns Object mapping labels to baselines
   */
  exportBaselines(): Record<string, MemoryBaseline> {
    return this.baselineManager.exportBaselines()
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
    this.baselineManager.clear()
  }
}

/**
 * Default memory profiler instance for convenience
 */
export const defaultMemoryProfiler = new MemoryProfiler()
