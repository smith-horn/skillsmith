/**
 * SMI-1662: TaskRunner Tests
 *
 * Tests for background task timeout management functionality.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  TaskRunner,
  createTaskRunner,
  getGlobalTaskRunner,
  setGlobalTaskRunner,
  disposeGlobalTaskRunner,
  DEFAULT_TASK_TIMEOUT_MS,
  SIGKILL_GRACE_PERIOD_MS,
  WARNING_THRESHOLD_RATIO,
} from '../TaskRunner.js'
import { silentLogger } from '../../utils/logger.js'

describe('TaskRunner', () => {
  let runner: TaskRunner

  beforeEach(() => {
    vi.useFakeTimers()
    runner = new TaskRunner({
      timeoutMs: 10000, // 10 seconds for faster tests
      logger: silentLogger,
    })
  })

  afterEach(() => {
    runner.dispose()
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('should use default timeout if not specified', () => {
      const defaultRunner = new TaskRunner({ logger: silentLogger })
      expect(defaultRunner.getTimeoutMs()).toBe(DEFAULT_TASK_TIMEOUT_MS)
      defaultRunner.dispose()
    })

    it('should use custom timeout when provided', () => {
      const customRunner = new TaskRunner({ timeoutMs: 5000, logger: silentLogger })
      expect(customRunner.getTimeoutMs()).toBe(5000)
      customRunner.dispose()
    })

    it('should read timeout from environment variable', () => {
      const originalEnv = process.env.TASK_TIMEOUT_MS
      process.env.TASK_TIMEOUT_MS = '120000'

      const envRunner = new TaskRunner({ logger: silentLogger })
      expect(envRunner.getTimeoutMs()).toBe(120000)
      envRunner.dispose()

      if (originalEnv !== undefined) {
        process.env.TASK_TIMEOUT_MS = originalEnv
      } else {
        delete process.env.TASK_TIMEOUT_MS
      }
    })

    it('should prefer explicit config over environment variable', () => {
      const originalEnv = process.env.TASK_TIMEOUT_MS
      process.env.TASK_TIMEOUT_MS = '120000'

      const configRunner = new TaskRunner({ timeoutMs: 5000, logger: silentLogger })
      expect(configRunner.getTimeoutMs()).toBe(5000)
      configRunner.dispose()

      if (originalEnv !== undefined) {
        process.env.TASK_TIMEOUT_MS = originalEnv
      } else {
        delete process.env.TASK_TIMEOUT_MS
      }
    })
  })

  describe('register', () => {
    it('should register a task and return an ID', () => {
      const taskId = runner.register(12345, 'Test task')

      expect(taskId).toBeDefined()
      expect(typeof taskId).toBe('string')
      expect(taskId.length).toBeGreaterThan(0)
    })

    it('should track the registered task', () => {
      const taskId = runner.register(12345, 'Test task')
      const task = runner.getTask(taskId)

      expect(task).toBeDefined()
      expect(task?.pid).toBe(12345)
      expect(task?.description).toBe('Test task')
      expect(task?.status).toBe('running')
      expect(task?.warningIssued).toBe(false)
    })

    it('should set correct start time', () => {
      const now = Date.now()
      const taskId = runner.register(12345, 'Test task')
      const task = runner.getTask(taskId)

      expect(task?.startedAt).toBeGreaterThanOrEqual(now)
      expect(task?.startedAt).toBeLessThanOrEqual(now + 100)
    })
  })

  describe('complete', () => {
    it('should mark task as completed', () => {
      const taskId = runner.register(12345, 'Test task')
      runner.complete(taskId)
      const task = runner.getTask(taskId)

      expect(task?.status).toBe('completed')
      expect(task?.endedAt).toBeDefined()
      expect(task?.durationMs).toBeDefined()
    })

    it('should calculate duration correctly', () => {
      const taskId = runner.register(12345, 'Test task')

      // Advance time by 1 second
      vi.advanceTimersByTime(1000)

      runner.complete(taskId)
      const task = runner.getTask(taskId)

      expect(task?.durationMs).toBeGreaterThanOrEqual(1000)
    })
  })

  describe('fail', () => {
    it('should mark task as failed with error message', () => {
      const taskId = runner.register(12345, 'Test task')
      runner.fail(taskId, 'Something went wrong')
      const task = runner.getTask(taskId)

      expect(task?.status).toBe('failed')
      expect(task?.error).toBe('Something went wrong')
    })

    it('should extract message from Error object', () => {
      const taskId = runner.register(12345, 'Test task')
      runner.fail(taskId, new Error('Error object message'))
      const task = runner.getTask(taskId)

      expect(task?.error).toBe('Error object message')
    })
  })

  describe('getTasks', () => {
    it('should return all tasks when no filter specified', () => {
      runner.register(1, 'Task 1')
      runner.register(2, 'Task 2')
      runner.register(3, 'Task 3')

      const tasks = runner.getTasks()
      expect(tasks).toHaveLength(3)
    })

    it('should filter tasks by status', () => {
      const task1 = runner.register(1, 'Task 1')
      runner.register(2, 'Task 2')
      const task3 = runner.register(3, 'Task 3')

      runner.complete(task1)
      runner.fail(task3, 'error')

      const runningTasks = runner.getTasks('running')
      expect(runningTasks).toHaveLength(1)

      const completedTasks = runner.getTasks('completed')
      expect(completedTasks).toHaveLength(1)

      const failedTasks = runner.getTasks('failed')
      expect(failedTasks).toHaveLength(1)
    })
  })

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const task1 = runner.register(1, 'Task 1')
      runner.register(2, 'Task 2')
      const task3 = runner.register(3, 'Task 3')
      runner.register(4, 'Task 4')

      runner.complete(task1)
      runner.fail(task3, 'error')

      const stats = runner.getStats()

      expect(stats.total).toBe(4)
      expect(stats.running).toBe(2)
      expect(stats.completed).toBe(1)
      expect(stats.failed).toBe(1)
      expect(stats.timeout).toBe(0)
      expect(stats.killed).toBe(0)
    })
  })

  describe('warning callback', () => {
    it('should issue warning at 80% of timeout', () => {
      const warningCallback = vi.fn()
      const testRunner = new TaskRunner({
        timeoutMs: 10000,
        logger: silentLogger,
        onWarning: warningCallback,
      })

      testRunner.register(12345, 'Test task')

      // Advance to just before warning threshold (80%)
      vi.advanceTimersByTime(7900)
      expect(warningCallback).not.toHaveBeenCalled()

      // Advance past warning threshold
      vi.advanceTimersByTime(200)
      expect(warningCallback).toHaveBeenCalled()

      const call = warningCallback.mock.calls[0]
      expect(call[0].pid).toBe(12345)
      expect(call[1]).toBeGreaterThan(0) // remaining time

      testRunner.dispose()
    })

    it('should set warningIssued flag', () => {
      const taskId = runner.register(12345, 'Test task')

      // Advance past warning threshold (80% of 10s = 8s)
      vi.advanceTimersByTime(8100)

      const task = runner.getTask(taskId)
      expect(task?.warningIssued).toBe(true)
    })
  })

  describe('timeout handling', () => {
    it('should call onTimeout callback when task times out', async () => {
      const timeoutCallback = vi.fn()
      const testRunner = new TaskRunner({
        timeoutMs: 10000,
        logger: silentLogger,
        onTimeout: timeoutCallback,
      })

      // Mock process.kill to prevent actual signals
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

      testRunner.register(12345, 'Test task')

      // Advance past timeout and allow async operations to complete
      vi.advanceTimersByTime(10100)
      await vi.runAllTimersAsync()

      expect(timeoutCallback).toHaveBeenCalled()
      expect(timeoutCallback.mock.calls[0][0].pid).toBe(12345)

      killSpy.mockRestore()
      testRunner.dispose()
    })

    it('should mark task as timeout after timeout', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

      const taskId = runner.register(12345, 'Test task')

      // Advance past timeout + grace period and allow async operations to complete
      vi.advanceTimersByTime(10000 + SIGKILL_GRACE_PERIOD_MS + 100)
      await vi.runAllTimersAsync()

      const task = runner.getTask(taskId)
      expect(task?.status).toBe('timeout')

      killSpy.mockRestore()
    })

    it('should send SIGTERM first during graceful shutdown', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

      runner.register(12345, 'Test task')

      // Advance to timeout
      vi.advanceTimersByTime(10100)

      // First call should be SIGTERM
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')

      killSpy.mockRestore()
    })
  })

  describe('cleanup', () => {
    it('should clean up old completed tasks', () => {
      const task1 = runner.register(1, 'Task 1')
      runner.register(2, 'Task 2')

      runner.complete(task1)

      // Advance time past max age
      vi.advanceTimersByTime(3700000) // > 1 hour

      const cleaned = runner.cleanup()
      expect(cleaned).toBe(1)
    })

    it('should not clean up running tasks', () => {
      runner.register(1, 'Task 1')

      // Advance time
      vi.advanceTimersByTime(3700000)

      // Need to prevent timeout from firing
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

      const cleaned = runner.cleanup()
      expect(cleaned).toBe(0)

      killSpy.mockRestore()
    })

    it('should respect custom maxAgeMs', () => {
      const task1 = runner.register(1, 'Task 1')
      runner.complete(task1)

      // Advance time by 30 minutes
      vi.advanceTimersByTime(1800000)

      // Clean with 1 hour max age - should not clean
      const cleaned1 = runner.cleanup(3600000)
      expect(cleaned1).toBe(0)

      // Clean with 15 minute max age - should clean
      const cleaned2 = runner.cleanup(900000)
      expect(cleaned2).toBe(1)
    })
  })

  describe('dispose', () => {
    it('should clear all timers', () => {
      runner.register(1, 'Task 1')
      runner.register(2, 'Task 2')

      runner.dispose()

      // Advance time - no callbacks should fire
      const killSpy = vi.spyOn(process, 'kill')
      vi.advanceTimersByTime(20000)

      expect(killSpy).not.toHaveBeenCalled()
      killSpy.mockRestore()
    })
  })

  describe('constants', () => {
    it('should have correct default timeout', () => {
      expect(DEFAULT_TASK_TIMEOUT_MS).toBe(600000) // 10 minutes
    })

    it('should have correct grace period', () => {
      expect(SIGKILL_GRACE_PERIOD_MS).toBe(5000) // 5 seconds
    })

    it('should have correct warning threshold', () => {
      expect(WARNING_THRESHOLD_RATIO).toBe(0.8) // 80%
    })
  })
})

describe('Global TaskRunner', () => {
  afterEach(() => {
    disposeGlobalTaskRunner()
  })

  it('should create singleton on first access', () => {
    const runner1 = getGlobalTaskRunner()
    const runner2 = getGlobalTaskRunner()

    expect(runner1).toBe(runner2)
  })

  it('should allow setting custom global runner', () => {
    const customRunner = new TaskRunner({ timeoutMs: 5000, logger: silentLogger })
    setGlobalTaskRunner(customRunner)

    const retrieved = getGlobalTaskRunner()
    expect(retrieved).toBe(customRunner)
    expect(retrieved.getTimeoutMs()).toBe(5000)
  })

  it('should dispose global runner', () => {
    const runner = getGlobalTaskRunner()
    disposeGlobalTaskRunner()

    // Next call should create new instance
    const newRunner = getGlobalTaskRunner()
    expect(newRunner).not.toBe(runner)
  })
})

describe('createTaskRunner', () => {
  it('should create new TaskRunner instance', () => {
    const runner = createTaskRunner({ logger: silentLogger })
    expect(runner).toBeInstanceOf(TaskRunner)
    runner.dispose()
  })

  it('should pass config to TaskRunner', () => {
    const runner = createTaskRunner({ timeoutMs: 5000, logger: silentLogger })
    expect(runner.getTimeoutMs()).toBe(5000)
    runner.dispose()
  })
})
