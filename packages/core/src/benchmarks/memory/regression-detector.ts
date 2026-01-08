/**
 * SMI-689: Memory Regression Detector
 *
 * Detects memory regressions by comparing current stats to baselines.
 */

import type { MemoryStats, MemoryBaseline, MemoryRegressionResult } from './types.js'
import { formatBytes } from './utils.js'

/**
 * Check for memory regression against a baseline
 *
 * @param label - Label to check
 * @param baseline - Baseline to compare against (optional)
 * @param currentStats - Current memory stats (optional)
 * @param threshold - Regression threshold percentage (default: 10%)
 * @returns Regression result
 */
export function checkRegression(
  label: string,
  baseline: MemoryBaseline | undefined,
  currentStats: MemoryStats | undefined,
  threshold: number = 10
): MemoryRegressionResult {
  if (!baseline) {
    return {
      hasRegression: false,
      threshold,
      label,
      baselineHeap: 0,
      currentHeap: currentStats?.peakHeapUsed ?? 0,
      changePercent: 0,
      message: `No baseline exists for label: ${label}`,
    }
  }

  if (!currentStats) {
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
      ? ((currentStats.peakHeapUsed - baseline.peakHeapUsed) / baseline.peakHeapUsed) * 100
      : 0

  const hasRegression = changePercent > threshold

  return {
    hasRegression,
    threshold,
    label,
    baselineHeap: baseline.peakHeapUsed,
    currentHeap: currentStats.peakHeapUsed,
    changePercent: Math.round(changePercent * 100) / 100,
    message: hasRegression
      ? `Memory regression detected for ${label}: heap grew by ${changePercent.toFixed(2)}% ` +
        `(${formatBytes(baseline.peakHeapUsed)} -> ${formatBytes(currentStats.peakHeapUsed)})`
      : `No memory regression for ${label} (change: ${changePercent.toFixed(2)}%)`,
  }
}
