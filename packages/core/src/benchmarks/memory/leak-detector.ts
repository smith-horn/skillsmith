/**
 * SMI-689: Memory Leak Detector
 *
 * Detects potential memory leaks from completed tracking sessions.
 */

import type { MemoryStats, LeakDetectionResult } from './types.js'
import { formatBytes } from './utils.js'

/**
 * Detect potential memory leaks across completed tracking sessions
 *
 * @param completedStats - Map of label to completed MemoryStats
 * @param threshold - Heap growth percentage threshold to consider a leak (default: 10%)
 * @returns Leak detection result
 *
 * @example
 * ```typescript
 * const result = detectLeaks(completedStats, 15); // 15% threshold
 * if (result.hasLeaks) {
 *   console.error(`Potential leak detected: ${result.message}`);
 * }
 * ```
 */
export function detectLeaks(
  completedStats: Map<string, MemoryStats>,
  threshold: number = 10
): LeakDetectionResult {
  const suspectedLabels: string[] = []
  let totalLeakedBytes = 0
  let maxGrowthPercent = 0

  for (const [label, stats] of completedStats) {
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
        `Total leaked: ${formatBytes(totalLeakedBytes)}, max growth: ${maxGrowthPercent.toFixed(2)}%`
      : `No memory leaks detected (threshold: ${threshold}%)`,
  }
}
