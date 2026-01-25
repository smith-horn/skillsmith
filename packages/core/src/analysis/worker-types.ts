/**
 * SMI-1308: Worker Pool Type Definitions
 *
 * Type definitions for the worker thread pool.
 * Extracted from worker-pool.ts for better modularity.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/worker-types
 */

import type { ParseResult } from './types.js'
import type { AnalysisMetrics } from './metrics.js'

/**
 * Task to be parsed by a worker
 */
export interface ParseTask {
  /** Path to the file */
  filePath: string
  /** File content to parse */
  content: string
  /** Programming language */
  language: string
}

/**
 * Result from a worker parse operation
 */
export interface WorkerResult {
  /** Path to the file */
  filePath: string
  /** Parse result */
  result: ParseResult
  /** Time taken to parse in milliseconds */
  durationMs: number
  /** Error message if parsing failed */
  error?: string
}

/**
 * Options for ParserWorkerPool
 */
export interface WorkerPoolOptions {
  /** Number of workers in pool (default: CPU cores - 1) */
  poolSize?: number
  /** Minimum batch size to use workers (default: 10) */
  minBatchForWorkers?: number
  /** Custom metrics instance (uses default if not provided) */
  metrics?: AnalysisMetrics
}

/**
 * Worker pool statistics
 */
export interface WorkerPoolStats {
  poolSize: number
  activeWorkers: number
  queuedTasks: number
  utilization: number
}

/**
 * Internal task queue item
 */
export interface QueuedTask {
  task: ParseTask
  resolve: (r: WorkerResult) => void
  reject: (e: Error) => void
}
