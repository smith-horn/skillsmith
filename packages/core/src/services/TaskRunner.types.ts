/**
 * @fileoverview TaskRunner Type Definitions and Constants
 * @module @skillsmith/core/services/TaskRunner.types
 * @see SMI-1662: TaskRunner - Background Task Timeout Management
 * @see SMI-2741: Split from TaskRunner.ts to meet 500-line standard
 */

import type { Logger } from '../utils/logger.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Default timeout: 10 minutes (600000ms)
 */
export const DEFAULT_TASK_TIMEOUT_MS = 600000

/**
 * Grace period before SIGKILL after SIGTERM: 5 seconds
 */
export const SIGKILL_GRACE_PERIOD_MS = 5000

/**
 * Warning threshold: 80% of timeout
 */
export const WARNING_THRESHOLD_RATIO = 0.8

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration options for TaskRunner
 */
export interface TaskRunnerConfig {
  /** Timeout in milliseconds (default: 600000 = 10 minutes) */
  timeoutMs?: number
  /** Enable debug logging (default: false) */
  debug?: boolean
  /** Custom logger instance */
  logger?: Logger
  /** Callback when a task times out */
  onTimeout?: (task: TrackedTask) => void
  /** Callback when warning threshold is reached */
  onWarning?: (task: TrackedTask, remainingMs: number) => void
}

/**
 * Status of a tracked task
 */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'killed'

/**
 * A tracked background task
 */
export interface TrackedTask {
  /** Unique task identifier */
  id: string
  /** Process ID of the background task */
  pid: number
  /** Human-readable description */
  description: string
  /** When the task started */
  startedAt: number
  /** Current status */
  status: TaskStatus
  /** When the task completed/failed/timed out */
  endedAt?: number
  /** Duration in milliseconds */
  durationMs?: number
  /** Whether warning was issued */
  warningIssued: boolean
  /** Error message if failed */
  error?: string
}

/**
 * Result of a cleanup operation
 */
export interface CleanupResult {
  /** Number of tasks cleaned up */
  cleaned: number
  /** Task IDs that were cleaned */
  taskIds: string[]
  /** Any errors encountered */
  errors: Array<{ taskId: string; error: string }>
}
