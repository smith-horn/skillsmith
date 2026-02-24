/**
 * @fileoverview TaskRunner Process Management Utilities
 * @module @skillsmith/core/services/TaskRunner.process
 * @see SMI-1662: TaskRunner - Background Task Timeout Management
 * @see SMI-2741: Split from TaskRunner.ts to meet 500-line standard
 *
 * Low-level process lifecycle management for background task cleanup:
 * - Graceful shutdown with SIGTERM → SIGKILL escalation
 * - Immediate kill with SIGKILL
 * - Sleep utility for grace period waiting
 */

import { SIGKILL_GRACE_PERIOD_MS } from './TaskRunner.types.js'

/**
 * Gracefully shutdown a process: SIGTERM -> wait -> SIGKILL
 *
 * Sends SIGTERM first to allow graceful shutdown, waits for the
 * grace period, then escalates to SIGKILL if the process is still running.
 *
 * @param pid - Process ID to shutdown
 */
export async function gracefulShutdown(pid: number): Promise<void> {
  // First, send SIGTERM for graceful shutdown
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    // Process might already be dead
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return
    }
    throw error
  }

  // Wait for grace period
  await sleep(SIGKILL_GRACE_PERIOD_MS)

  // Check if still running and send SIGKILL
  try {
    // process.kill(pid, 0) checks if process exists
    process.kill(pid, 0)
    // Process still running, send SIGKILL
    process.kill(pid, 'SIGKILL')
  } catch {
    // Process is already dead, which is fine
  }
}

/**
 * Kill a process immediately with SIGKILL
 *
 * @param pid - Process ID to kill
 */
export async function killProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    // ESRCH means process doesn't exist, which is fine
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error
    }
  }
}

/**
 * Sleep for a specified duration
 *
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
