/**
 * SMI-1662: TaskRunner - Background Task Timeout Management
 * @see SMI-2741: Types split to TaskRunner.types.ts, process utils to TaskRunner.process.ts
 *
 * Provides configurable timeout enforcement for background Task agents.
 * Addresses orphaned process memory leaks identified in incident 2026-01-22.
 *
 * Features:
 * - Configurable timeout via TASK_TIMEOUT_MS environment variable
 * - Default timeout: 10 minutes (600000ms)
 * - Warning at 80% of timeout limit
 * - Graceful shutdown: SIGTERM -> wait 5s -> SIGKILL
 * - Task registry for tracking running background tasks
 *
 * @example
 * ```typescript
 * const runner = new TaskRunner({ timeoutMs: 300000 }) // 5 minute timeout
 * const taskId = runner.register(childProcess.pid, 'SMI-1660 implementation')
 *
 * // When task completes
 * runner.complete(taskId)
 *
 * // Cleanup orphaned tasks
 * await runner.cleanupOrphaned()
 * ```
 */

import { randomUUID } from 'crypto'
import { createLogger, type Logger } from '../utils/logger.js'
import {
  DEFAULT_TASK_TIMEOUT_MS,
  WARNING_THRESHOLD_RATIO,
  type TaskRunnerConfig,
  type TaskStatus,
  type TrackedTask,
  type CleanupResult,
} from './TaskRunner.types.js'
import { gracefulShutdown, killProcess } from './TaskRunner.process.js'

// Re-export types and constants for public API
export type {
  TaskRunnerConfig,
  TaskStatus,
  TrackedTask,
  CleanupResult,
} from './TaskRunner.types.js'
export {
  DEFAULT_TASK_TIMEOUT_MS,
  SIGKILL_GRACE_PERIOD_MS,
  WARNING_THRESHOLD_RATIO,
} from './TaskRunner.types.js'
export { gracefulShutdown, killProcess, sleep } from './TaskRunner.process.js'

/**
 * TaskRunner manages background task lifecycles with timeout enforcement.
 *
 * Solves the orphaned process problem by:
 * 1. Tracking all background tasks in a registry
 * 2. Enforcing configurable timeouts
 * 3. Graceful shutdown with SIGTERM -> SIGKILL escalation
 * 4. Logging all timeout events for debugging
 */
export class TaskRunner {
  private readonly config: Required<Omit<TaskRunnerConfig, 'onTimeout' | 'onWarning' | 'logger'>>
  private readonly logger: Logger
  private readonly tasks: Map<string, TrackedTask> = new Map()
  private readonly timers: Map<string, NodeJS.Timeout> = new Map()
  private readonly warningTimers: Map<string, NodeJS.Timeout> = new Map()
  private readonly onTimeout?: (task: TrackedTask) => void
  private readonly onWarning?: (task: TrackedTask, remainingMs: number) => void

  constructor(config: TaskRunnerConfig = {}) {
    const envTimeout = process.env.TASK_TIMEOUT_MS
      ? parseInt(process.env.TASK_TIMEOUT_MS, 10)
      : undefined

    this.config = {
      timeoutMs: config.timeoutMs ?? envTimeout ?? DEFAULT_TASK_TIMEOUT_MS,
      debug: config.debug ?? process.env.DEBUG === 'true',
    }
    this.logger = config.logger ?? createLogger('TaskRunner')
    this.onTimeout = config.onTimeout
    this.onWarning = config.onWarning

    if (this.config.debug) {
      this.logger.debug('TaskRunner initialized', {
        timeoutMs: this.config.timeoutMs,
        warningThresholdMs: Math.floor(this.config.timeoutMs * WARNING_THRESHOLD_RATIO),
      })
    }
  }

  /**
   * Register a new background task for monitoring
   *
   * @param pid - Process ID of the background task
   * @param description - Human-readable description
   * @returns Task ID for tracking
   */
  register(pid: number, description: string): string {
    const id = randomUUID()
    const now = Date.now()

    const task: TrackedTask = {
      id,
      pid,
      description,
      startedAt: now,
      status: 'running',
      warningIssued: false,
    }

    this.tasks.set(id, task)

    // Set warning timer at 80% of timeout
    const warningMs = Math.floor(this.config.timeoutMs * WARNING_THRESHOLD_RATIO)
    const warningTimer = setTimeout(() => {
      this.issueWarning(id)
    }, warningMs)
    this.warningTimers.set(id, warningTimer)

    // Set timeout timer
    const timeoutTimer = setTimeout(() => {
      void this.handleTimeout(id)
    }, this.config.timeoutMs)
    this.timers.set(id, timeoutTimer)

    if (this.config.debug) {
      this.logger.debug('Task registered', {
        taskId: id,
        pid,
        description,
        timeoutMs: this.config.timeoutMs,
      })
    }

    return id
  }

  /**
   * Mark a task as completed successfully
   *
   * @param taskId - Task ID to complete
   */
  complete(taskId: string): void {
    this.finishTask(taskId, 'completed')
  }

  /**
   * Mark a task as failed
   *
   * @param taskId - Task ID that failed
   * @param error - Error message or Error object
   */
  fail(taskId: string, error: string | Error): void {
    const task = this.tasks.get(taskId)
    if (task) {
      task.error = error instanceof Error ? error.message : error
    }
    this.finishTask(taskId, 'failed')
  }

  /**
   * Get a tracked task by ID
   *
   * @param taskId - Task ID to retrieve
   * @returns The tracked task or undefined
   */
  getTask(taskId: string): TrackedTask | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * Get all tasks with a specific status
   *
   * @param status - Status to filter by (optional, returns all if not specified)
   * @returns Array of matching tasks
   */
  getTasks(status?: TaskStatus): TrackedTask[] {
    const tasks = Array.from(this.tasks.values())
    return status ? tasks.filter((t) => t.status === status) : tasks
  }

  /**
   * Get statistics about tracked tasks
   */
  getStats(): {
    total: number
    running: number
    completed: number
    failed: number
    timeout: number
    killed: number
  } {
    const tasks = Array.from(this.tasks.values())
    return {
      total: tasks.length,
      running: tasks.filter((t) => t.status === 'running').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      timeout: tasks.filter((t) => t.status === 'timeout').length,
      killed: tasks.filter((t) => t.status === 'killed').length,
    }
  }

  /**
   * Clean up completed/failed/timeout tasks older than specified age
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
   * @returns Number of tasks cleaned up
   */
  cleanup(maxAgeMs: number = 3600000): number {
    const now = Date.now()
    let cleaned = 0

    for (const [id, task] of this.tasks.entries()) {
      if (task.status !== 'running' && task.endedAt && now - task.endedAt > maxAgeMs) {
        this.tasks.delete(id)
        cleaned++
      }
    }

    if (this.config.debug && cleaned > 0) {
      this.logger.debug('Cleaned up old tasks', { count: cleaned, maxAgeMs })
    }

    return cleaned
  }

  /**
   * Clean up all orphaned running tasks that have exceeded timeout
   * This can be called externally to force cleanup
   *
   * @returns Cleanup result with details
   */
  async cleanupOrphaned(): Promise<CleanupResult> {
    const now = Date.now()
    const result: CleanupResult = {
      cleaned: 0,
      taskIds: [],
      errors: [],
    }

    for (const [id, task] of this.tasks.entries()) {
      if (task.status === 'running' && now - task.startedAt > this.config.timeoutMs) {
        try {
          await killProcess(task.pid)
          this.finishTask(id, 'killed')
          result.cleaned++
          result.taskIds.push(id)
        } catch (error) {
          result.errors.push({
            taskId: id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    if (result.cleaned > 0) {
      this.logger.warn('Cleaned up orphaned tasks', {
        count: result.cleaned,
        taskIds: result.taskIds,
        errors: result.errors.length,
      })
    }

    return result
  }

  /**
   * Dispose of the TaskRunner and clean up all timers
   */
  dispose(): void {
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()

    for (const timer of this.warningTimers.values()) {
      clearTimeout(timer)
    }
    this.warningTimers.clear()

    if (this.config.debug) {
      this.logger.debug('TaskRunner disposed', { taskCount: this.tasks.size })
    }
  }

  /**
   * Get the configured timeout in milliseconds
   */
  getTimeoutMs(): number {
    return this.config.timeoutMs
  }

  /**
   * Issue a warning that task is approaching timeout
   */
  private issueWarning(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') {
      return
    }

    const remainingMs = this.config.timeoutMs - (Date.now() - task.startedAt)
    task.warningIssued = true

    this.logger.warn('Task approaching timeout', {
      taskId,
      pid: task.pid,
      description: task.description,
      elapsedMs: Date.now() - task.startedAt,
      remainingMs,
      timeoutMs: this.config.timeoutMs,
    })

    this.onWarning?.(task, remainingMs)
  }

  /**
   * Handle a task timeout
   */
  private async handleTimeout(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') {
      return
    }

    const durationMs = Date.now() - task.startedAt

    this.logger.error('Task timed out', undefined, {
      taskId,
      pid: task.pid,
      description: task.description,
      durationMs,
      timeoutMs: this.config.timeoutMs,
    })

    // Attempt graceful shutdown
    try {
      await gracefulShutdown(task.pid)
      this.finishTask(taskId, 'timeout')
    } catch (error) {
      this.logger.error(
        'Failed to terminate timed out task',
        error instanceof Error ? error : new Error(String(error)),
        { taskId, pid: task.pid }
      )
      this.finishTask(taskId, 'timeout')
    }

    this.onTimeout?.(task)
  }

  /**
   * Finish a task and clean up timers
   */
  private finishTask(taskId: string, status: TaskStatus): void {
    const task = this.tasks.get(taskId)
    if (!task) {
      return
    }

    const now = Date.now()
    task.status = status
    task.endedAt = now
    task.durationMs = now - task.startedAt

    // Clear timers
    const timer = this.timers.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(taskId)
    }

    const warningTimer = this.warningTimers.get(taskId)
    if (warningTimer) {
      clearTimeout(warningTimer)
      this.warningTimers.delete(taskId)
    }

    if (this.config.debug) {
      this.logger.debug('Task finished', {
        taskId,
        status,
        durationMs: task.durationMs,
        description: task.description,
      })
    }
  }
}

/**
 * Create a TaskRunner with environment-based configuration
 *
 * Environment variables:
 * - TASK_TIMEOUT_MS: Timeout in milliseconds (default: 600000)
 * - DEBUG: Enable debug logging (default: false)
 */
export function createTaskRunner(config?: TaskRunnerConfig): TaskRunner {
  return new TaskRunner(config)
}

/**
 * Global TaskRunner instance for singleton usage
 */
let globalTaskRunner: TaskRunner | null = null

/**
 * Get or create the global TaskRunner instance
 */
export function getGlobalTaskRunner(): TaskRunner {
  if (!globalTaskRunner) {
    globalTaskRunner = createTaskRunner()
  }
  return globalTaskRunner
}

/**
 * Set a custom global TaskRunner instance
 */
export function setGlobalTaskRunner(runner: TaskRunner): void {
  globalTaskRunner = runner
}

/**
 * Dispose of the global TaskRunner instance
 */
export function disposeGlobalTaskRunner(): void {
  if (globalTaskRunner) {
    globalTaskRunner.dispose()
    globalTaskRunner = null
  }
}

export default TaskRunner
