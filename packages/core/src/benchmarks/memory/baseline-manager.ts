/**
 * SMI-689: Memory Baseline Manager
 *
 * Manages memory baselines for regression comparison.
 */

import type { MemoryStats, MemoryBaseline } from './types.js'

/**
 * Manages baseline storage and comparison for memory profiling.
 */
export class BaselineManager {
  private baselines: Map<string, MemoryBaseline> = new Map()

  /**
   * Save a baseline from completed stats
   *
   * @param label - Label to save as baseline
   * @param stats - Memory stats to create baseline from
   * @returns Created baseline
   */
  saveBaseline(label: string, stats: MemoryStats): MemoryBaseline {
    const baseline: MemoryBaseline = {
      label,
      timestamp: new Date().toISOString(),
      avgHeapUsed:
        (stats.startSnapshot.usedHeapSize +
          (stats.endSnapshot?.usedHeapSize ?? stats.startSnapshot.usedHeapSize)) /
        2,
      peakHeapUsed: stats.peakHeapUsed,
      sampleCount: stats.sampleCount,
    }

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
   * Get a baseline by label
   *
   * @param label - Label to look up
   * @returns Baseline or undefined
   */
  getBaseline(label: string): MemoryBaseline | undefined {
    return this.baselines.get(label)
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
   * Clear all baselines
   */
  clear(): void {
    this.baselines.clear()
  }

  /**
   * Check if a baseline exists
   *
   * @param label - Label to check
   * @returns True if baseline exists
   */
  hasBaseline(label: string): boolean {
    return this.baselines.has(label)
  }

  /**
   * Delete a specific baseline
   *
   * @param label - Label to delete
   * @returns True if baseline was deleted
   */
  deleteBaseline(label: string): boolean {
    return this.baselines.delete(label)
  }
}
