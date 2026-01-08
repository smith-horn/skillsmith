/**
 * SMI-689: Memory Profiler Types
 *
 * Type definitions for memory profiling and leak detection.
 */

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
export interface TrackingEntry {
  label: string
  startSnapshot: MemorySnapshot
  startTime: number
  samples: MemorySnapshot[]
  samplingInterval?: NodeJS.Timeout
}
