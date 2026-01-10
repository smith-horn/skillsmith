/**
 * SMI-1308: Memory Monitor
 *
 * Monitors memory usage and triggers cleanup when thresholds are exceeded.
 * Integrates with ParseCache for memory pressure handling.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/memory-monitor
 */

import type { ParseCache } from './cache.js'

/**
 * Memory usage statistics
 */
export interface MemoryStats {
  /** Heap used in bytes */
  heapUsed: number
  /** Total heap size in bytes */
  heapTotal: number
  /** External memory in bytes */
  external: number
  /** ArrayBuffers memory in bytes */
  arrayBuffers: number
  /** Resident set size in bytes */
  rss: number
  /** Memory threshold in bytes */
  threshold: number
  /** Whether currently over threshold */
  isOverThreshold: boolean
}

/**
 * Result of a cleanup operation
 */
export interface CleanupResult {
  /** Whether cleanup was performed */
  cleaned: boolean
  /** Bytes freed (estimated) */
  freedBytes: number
  /** Cleanup reason */
  reason?: string
}

/**
 * Options for MemoryMonitor
 */
export interface MemoryMonitorOptions {
  /** Memory threshold in MB (default: 500) */
  thresholdMB?: number
  /** ParseCache instance for cleanup */
  cache?: ParseCache
  /** Enable verbose logging */
  verbose?: boolean
}

/**
 * Monitor memory usage and trigger cleanup when needed
 *
 * Provides:
 * - Real-time memory statistics
 * - Automatic cleanup when threshold exceeded
 * - Periodic monitoring with configurable interval
 * - Integration with ParseCache
 *
 * @example
 * ```typescript
 * const cache = new ParseCache({ maxMemoryMB: 200 })
 * const monitor = new MemoryMonitor({
 *   thresholdMB: 500,
 *   cache
 * })
 *
 * // Check memory and cleanup if needed
 * const result = monitor.checkAndCleanup()
 * if (result.cleaned) {
 *   console.log(`Freed ${MemoryMonitor.formatBytes(result.freedBytes)}`)
 * }
 *
 * // Start periodic monitoring
 * const stop = monitor.startMonitoring(10000) // 10 seconds
 *
 * // Later...
 * stop()
 * ```
 */
export class MemoryMonitor {
  private readonly thresholdBytes: number
  private readonly cache: ParseCache | null
  private readonly verbose: boolean
  private monitorInterval: ReturnType<typeof setInterval> | null = null
  private cleanupCount = 0
  private totalFreedBytes = 0

  constructor(options: MemoryMonitorOptions = {}) {
    this.thresholdBytes = (options.thresholdMB ?? 500) * 1024 * 1024
    this.cache = options.cache ?? null
    this.verbose = options.verbose ?? false
  }

  /**
   * Get current memory statistics
   *
   * @returns Current memory usage statistics
   *
   * @example
   * ```typescript
   * const stats = monitor.getStats()
   * console.log(`Heap: ${MemoryMonitor.formatBytes(stats.heapUsed)}`)
   * console.log(`Over threshold: ${stats.isOverThreshold}`)
   * ```
   */
  getStats(): MemoryStats {
    const usage = process.memoryUsage()
    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      rss: usage.rss,
      threshold: this.thresholdBytes,
      isOverThreshold: usage.heapUsed > this.thresholdBytes,
    }
  }

  /**
   * Check memory and cleanup if needed
   *
   * Triggers cleanup when heap usage exceeds threshold.
   * Clears cache and requests garbage collection.
   *
   * @returns Cleanup result with bytes freed
   *
   * @example
   * ```typescript
   * const result = monitor.checkAndCleanup()
   * if (result.cleaned) {
   *   console.log(`Cleaned up ${MemoryMonitor.formatBytes(result.freedBytes)}`)
   * }
   * ```
   */
  checkAndCleanup(): CleanupResult {
    const stats = this.getStats()

    if (!stats.isOverThreshold) {
      return { cleaned: false, freedBytes: 0 }
    }

    const beforeHeap = stats.heapUsed

    if (this.verbose) {
      console.warn(
        `[MemoryMonitor] Memory pressure: ${MemoryMonitor.formatBytes(stats.heapUsed)} ` +
          `(threshold: ${MemoryMonitor.formatBytes(this.thresholdBytes)})`
      )
    }

    // Clear cache if available
    if (this.cache) {
      const cacheStats = this.cache.getStats()
      this.cache.clear()
      if (this.verbose) {
        console.warn(`[MemoryMonitor] Cleared cache (${cacheStats.entries} entries)`)
      }
    }

    // Request garbage collection if available
    if (typeof global.gc === 'function') {
      global.gc()
      if (this.verbose) {
        console.warn('[MemoryMonitor] Triggered garbage collection')
      }
    }

    this.cleanupCount++

    const afterUsage = process.memoryUsage()
    const freedBytes = Math.max(0, beforeHeap - afterUsage.heapUsed)
    this.totalFreedBytes += freedBytes

    return {
      cleaned: true,
      freedBytes,
      reason: `Heap exceeded threshold (${MemoryMonitor.formatBytes(beforeHeap)})`,
    }
  }

  /**
   * Force cleanup regardless of threshold
   *
   * Useful for explicit memory management before large operations.
   *
   * @returns Cleanup result with bytes freed
   */
  forceCleanup(): CleanupResult {
    const beforeHeap = process.memoryUsage().heapUsed

    // Clear cache if available
    if (this.cache) {
      this.cache.clear()
    }

    // Request garbage collection if available
    if (typeof global.gc === 'function') {
      global.gc()
    }

    this.cleanupCount++

    const afterUsage = process.memoryUsage()
    const freedBytes = Math.max(0, beforeHeap - afterUsage.heapUsed)
    this.totalFreedBytes += freedBytes

    return {
      cleaned: true,
      freedBytes,
      reason: 'Forced cleanup',
    }
  }

  /**
   * Start periodic monitoring
   *
   * Checks memory at the specified interval and performs
   * cleanup when threshold is exceeded.
   *
   * @param intervalMs - Monitoring interval in milliseconds (default: 10000)
   * @returns Stop function to cancel monitoring
   *
   * @example
   * ```typescript
   * const stop = monitor.startMonitoring(5000)
   *
   * // Later, when done...
   * stop()
   * ```
   */
  startMonitoring(intervalMs = 10000): () => void {
    if (this.monitorInterval) {
      return () => this.stopMonitoring()
    }

    this.monitorInterval = setInterval(() => {
      this.checkAndCleanup()
    }, intervalMs)

    // Prevent interval from keeping process alive
    this.monitorInterval.unref()

    return () => this.stopMonitoring()
  }

  /**
   * Stop periodic monitoring
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval)
      this.monitorInterval = null
    }
  }

  /**
   * Get cleanup count
   *
   * @returns Number of cleanups performed
   */
  getCleanupCount(): number {
    return this.cleanupCount
  }

  /**
   * Get total bytes freed across all cleanups
   *
   * @returns Total bytes freed (estimated)
   */
  getTotalFreedBytes(): number {
    return this.totalFreedBytes
  }

  /**
   * Get monitoring status
   *
   * @returns Whether periodic monitoring is active
   */
  isMonitoring(): boolean {
    return this.monitorInterval !== null
  }

  /**
   * Get memory threshold
   *
   * @returns Threshold in bytes
   */
  getThreshold(): number {
    return this.thresholdBytes
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.cleanupCount = 0
    this.totalFreedBytes = 0
  }

  /**
   * Format bytes for display
   *
   * @param bytes - Number of bytes
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * MemoryMonitor.formatBytes(1024)        // "1.00 KB"
   * MemoryMonitor.formatBytes(1048576)     // "1.00 MB"
   * MemoryMonitor.formatBytes(1073741824)  // "1.00 GB"
   * ```
   */
  static formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB']
    let size = Math.abs(bytes)
    let unitIndex = 0

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex++
    }

    const prefix = bytes < 0 ? '-' : ''
    return `${prefix}${size.toFixed(2)} ${units[unitIndex]}`
  }

  /**
   * Get memory usage summary string
   *
   * @returns Formatted summary of current memory usage
   */
  getSummary(): string {
    const stats = this.getStats()
    return [
      `Heap: ${MemoryMonitor.formatBytes(stats.heapUsed)} / ${MemoryMonitor.formatBytes(stats.heapTotal)}`,
      `RSS: ${MemoryMonitor.formatBytes(stats.rss)}`,
      `Threshold: ${MemoryMonitor.formatBytes(stats.threshold)}`,
      `Status: ${stats.isOverThreshold ? 'OVER THRESHOLD' : 'OK'}`,
      `Cleanups: ${this.cleanupCount}`,
      `Total freed: ${MemoryMonitor.formatBytes(this.totalFreedBytes)}`,
    ].join(', ')
  }
}
