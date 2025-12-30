/**
 * SMI-761: Session Health Monitor Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SessionHealthMonitor,
  getHealthMonitor,
  initializeHealthMonitor,
  shutdownHealthMonitor,
  type SessionHealth,
} from '../src/session/SessionHealthMonitor.js'
import type { SessionData } from '../src/session/SessionContext.js'

describe('SessionHealthMonitor', () => {
  let monitor: SessionHealthMonitor

  const createMockSession = (id: string): SessionData => ({
    sessionId: id,
    startedAt: new Date().toISOString(),
    checkpoints: [],
    filesModified: [],
    lastActivity: new Date().toISOString(),
  })

  beforeEach(() => {
    monitor = new SessionHealthMonitor({
      heartbeatIntervalMs: 100, // Fast for testing
      warningThreshold: 2,
      unhealthyThreshold: 4,
      deadThreshold: 6,
    })
  })

  afterEach(() => {
    monitor.stop()
    shutdownHealthMonitor()
  })

  describe('constructor', () => {
    it('creates monitor with default config', () => {
      const defaultMonitor = new SessionHealthMonitor()
      expect(defaultMonitor).toBeInstanceOf(SessionHealthMonitor)
      expect(defaultMonitor.isRunning()).toBe(false)
    })

    it('accepts custom config', () => {
      const customMonitor = new SessionHealthMonitor({
        heartbeatIntervalMs: 60000,
        warningThreshold: 3,
      })
      expect(customMonitor).toBeInstanceOf(SessionHealthMonitor)
    })
  })

  describe('registerSession', () => {
    it('registers a session for monitoring', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      expect(monitor.getSessionCount()).toBe(1)
    })

    it('tracks session health as healthy initially', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      const health = monitor.getSessionHealth('test-session-1')
      expect(health).not.toBeNull()
      expect(health!.status).toBe('healthy')
      expect(health!.missedHeartbeats).toBe(0)
    })

    it('registers multiple sessions', () => {
      monitor.registerSession(createMockSession('session-1'))
      monitor.registerSession(createMockSession('session-2'))
      monitor.registerSession(createMockSession('session-3'))

      expect(monitor.getSessionCount()).toBe(3)
    })
  })

  describe('heartbeat', () => {
    it('records heartbeat for registered session', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      monitor.heartbeat('test-session-1')

      const health = monitor.getSessionHealth('test-session-1')
      expect(health!.status).toBe('healthy')
    })

    it('emits heartbeat event', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      const heartbeatHandler = vi.fn()
      monitor.on('heartbeat', heartbeatHandler)

      monitor.heartbeat('test-session-1')

      expect(heartbeatHandler).toHaveBeenCalledWith('test-session-1')
    })

    it('ignores heartbeat for unknown session', () => {
      // Should not throw
      monitor.heartbeat('unknown-session')
      expect(monitor.getSessionHealth('unknown-session')).toBeNull()
    })

    it('resets missed heartbeats counter', async () => {
      vi.useFakeTimers()
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)
      monitor.start()

      // Simulate some missed heartbeats
      vi.advanceTimersByTime(300) // 3 intervals

      // Now send heartbeat
      monitor.heartbeat('test-session-1')

      const health = monitor.getSessionHealth('test-session-1')
      expect(health!.missedHeartbeats).toBe(0)
      expect(health!.status).toBe('healthy')
      vi.useRealTimers()
    })
  })

  describe('unregisterSession', () => {
    it('removes session from monitoring', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)
      expect(monitor.getSessionCount()).toBe(1)

      monitor.unregisterSession('test-session-1')
      expect(monitor.getSessionCount()).toBe(0)
    })

    it('returns null health for unregistered session', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)
      monitor.unregisterSession('test-session-1')

      expect(monitor.getSessionHealth('test-session-1')).toBeNull()
    })
  })

  describe('getSessionHealth', () => {
    it('returns null for unknown session', () => {
      expect(monitor.getSessionHealth('unknown')).toBeNull()
    })

    it('calculates uptime correctly', async () => {
      vi.useFakeTimers()
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      vi.advanceTimersByTime(5000) // 5 seconds

      const health = monitor.getSessionHealth('test-session-1')
      expect(health!.uptimeSeconds).toBeGreaterThanOrEqual(5)
      vi.useRealTimers()
    })

    it('indicates recoverability', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      const health = monitor.getSessionHealth('test-session-1')
      expect(health!.recoverable).toBe(true)
    })
  })

  describe('getAllSessionHealth', () => {
    it('returns empty array when no sessions', () => {
      const health = monitor.getAllSessionHealth()
      expect(health).toEqual([])
    })

    it('returns health for all sessions', () => {
      monitor.registerSession(createMockSession('session-1'))
      monitor.registerSession(createMockSession('session-2'))

      const health = monitor.getAllSessionHealth()
      expect(health).toHaveLength(2)
      expect(health.map((h) => h.sessionId)).toContain('session-1')
      expect(health.map((h) => h.sessionId)).toContain('session-2')
    })
  })

  describe('health status transitions', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('transitions to warning after threshold', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)
      monitor.start()

      const warningHandler = vi.fn()
      monitor.on('warning', warningHandler)

      // Advance past warning threshold (2 missed heartbeats = 2 * 100ms = 200ms)
      vi.advanceTimersByTime(200)

      expect(warningHandler).toHaveBeenCalled()
      const health = warningHandler.mock.calls[0][0] as SessionHealth
      expect(health.status).toBe('warning')
    })

    it('transitions to unhealthy after threshold', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)
      monitor.start()

      const unhealthyHandler = vi.fn()
      monitor.on('unhealthy', unhealthyHandler)

      // Advance past unhealthy threshold (4 * 100ms = 400ms)
      vi.advanceTimersByTime(400)

      expect(unhealthyHandler).toHaveBeenCalled()
    })

    it('transitions to dead after threshold', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)
      monitor.start()

      const deadHandler = vi.fn()
      monitor.on('dead', deadHandler)

      // Advance past dead threshold (6 * 100ms = 600ms)
      vi.advanceTimersByTime(600)

      expect(deadHandler).toHaveBeenCalled()
      const health = deadHandler.mock.calls[0][0] as SessionHealth
      expect(health.status).toBe('dead')
      expect(health.recoverable).toBe(false)
    })

    it('emits recovered when healthy again', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)
      monitor.start()

      const recoveredHandler = vi.fn()
      monitor.on('recovered', recoveredHandler)

      // Let it become unhealthy
      vi.advanceTimersByTime(400)

      // Send heartbeat to recover
      monitor.heartbeat('test-session-1')

      expect(recoveredHandler).toHaveBeenCalledWith('test-session-1')
    })
  })

  describe('start/stop', () => {
    it('starts monitoring', () => {
      monitor.start()
      expect(monitor.isRunning()).toBe(true)
    })

    it('stops monitoring', () => {
      monitor.start()
      monitor.stop()
      expect(monitor.isRunning()).toBe(false)
    })

    it('is idempotent for start', () => {
      monitor.start()
      monitor.start()
      expect(monitor.isRunning()).toBe(true)
    })

    it('is idempotent for stop', () => {
      monitor.start()
      monitor.stop()
      monitor.stop()
      expect(monitor.isRunning()).toBe(false)
    })
  })

  describe('global functions', () => {
    it('getHealthMonitor returns singleton', () => {
      const monitor1 = getHealthMonitor()
      const monitor2 = getHealthMonitor()
      expect(monitor1).toBe(monitor2)
    })

    it('initializeHealthMonitor creates and starts monitor', () => {
      const monitor = initializeHealthMonitor({ heartbeatIntervalMs: 50000 })
      expect(monitor).toBeInstanceOf(SessionHealthMonitor)
      expect(monitor.isRunning()).toBe(true)
    })

    it('shutdownHealthMonitor stops and clears monitor', () => {
      initializeHealthMonitor()
      shutdownHealthMonitor()
      // Getting a new monitor should create a fresh instance
      const newMonitor = getHealthMonitor()
      expect(newMonitor.isRunning()).toBe(false)
    })
  })

  describe('typed EventEmitter methods (SMI-772, SMI-773)', () => {
    it('supports addListener with type inference', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      const handler = vi.fn()
      monitor.addListener('heartbeat', handler)

      monitor.heartbeat('test-session-1')

      expect(handler).toHaveBeenCalledWith('test-session-1')
    })

    it('supports removeListener to unsubscribe', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      const handler = vi.fn()
      monitor.addListener('heartbeat', handler)
      monitor.removeListener('heartbeat', handler)

      monitor.heartbeat('test-session-1')

      expect(handler).not.toHaveBeenCalled()
    })

    it('supports prependListener to add listener at beginning', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      const order: number[] = []
      monitor.on('heartbeat', () => order.push(1))
      monitor.prependListener('heartbeat', () => order.push(0))

      monitor.heartbeat('test-session-1')

      expect(order).toEqual([0, 1]) // Prepended listener runs first
    })

    it('supports prependOnceListener for one-time prepended listener', () => {
      const session = createMockSession('test-session-1')
      monitor.registerSession(session)

      const handler = vi.fn()
      monitor.prependOnceListener('heartbeat', handler)

      monitor.heartbeat('test-session-1')
      monitor.heartbeat('test-session-1')

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('autoRecover (SMI-767)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('attempts recovery when session becomes dead and autoRecover is true', () => {
      const autoRecoverMonitor = new SessionHealthMonitor({
        heartbeatIntervalMs: 100,
        warningThreshold: 2,
        unhealthyThreshold: 4,
        deadThreshold: 6,
        autoRecover: true,
      })
      const session = createMockSession('test-session-1')
      autoRecoverMonitor.registerSession(session)
      autoRecoverMonitor.start()

      const recoveryAttemptHandler = vi.fn()
      const recoveredHandler = vi.fn()
      autoRecoverMonitor.on('recovery-attempt', recoveryAttemptHandler)
      autoRecoverMonitor.on('recovered', recoveredHandler)

      // Advance past dead threshold (6 * 100ms = 600ms)
      vi.advanceTimersByTime(600)

      expect(recoveryAttemptHandler).toHaveBeenCalledWith('test-session-1', 1)
      expect(recoveredHandler).toHaveBeenCalledWith('test-session-1')

      autoRecoverMonitor.stop()
    })

    it('does not attempt recovery when autoRecover is false', () => {
      const noRecoverMonitor = new SessionHealthMonitor({
        heartbeatIntervalMs: 100,
        warningThreshold: 2,
        unhealthyThreshold: 4,
        deadThreshold: 6,
        autoRecover: false,
      })
      const session = createMockSession('test-session-1')
      noRecoverMonitor.registerSession(session)
      noRecoverMonitor.start()

      const recoveryAttemptHandler = vi.fn()
      const deadHandler = vi.fn()
      noRecoverMonitor.on('recovery-attempt', recoveryAttemptHandler)
      noRecoverMonitor.on('dead', deadHandler)

      // Advance past dead threshold (6 * 100ms = 600ms)
      vi.advanceTimersByTime(600)

      expect(deadHandler).toHaveBeenCalled()
      expect(recoveryAttemptHandler).not.toHaveBeenCalled()

      noRecoverMonitor.stop()
    })

    it('emits recovery-failed when no session data available', () => {
      const autoRecoverMonitor = new SessionHealthMonitor({
        heartbeatIntervalMs: 100,
        warningThreshold: 2,
        unhealthyThreshold: 4,
        deadThreshold: 6,
        autoRecover: true,
      })

      // Register session without sessionData by manipulating internal state
      // This simulates a corrupted/cleared session
      const session = createMockSession('test-session-1')
      autoRecoverMonitor.registerSession(session)

      // Access internal state to clear sessionData (simulating corruption)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessions = (autoRecoverMonitor as any).sessions as Map<string, any>
      const state = sessions.get('test-session-1')
      state.sessionData = undefined

      autoRecoverMonitor.start()

      const recoveryFailedHandler = vi.fn()
      autoRecoverMonitor.on('recovery-failed', recoveryFailedHandler)

      // Advance past dead threshold
      vi.advanceTimersByTime(600)

      expect(recoveryFailedHandler).toHaveBeenCalledWith(
        'test-session-1',
        'No session data available for recovery'
      )

      autoRecoverMonitor.stop()
    })

    it('resets to healthy status after successful recovery', () => {
      const autoRecoverMonitor = new SessionHealthMonitor({
        heartbeatIntervalMs: 100,
        warningThreshold: 2,
        unhealthyThreshold: 4,
        deadThreshold: 6,
        autoRecover: true,
      })
      const session = createMockSession('test-session-1')
      autoRecoverMonitor.registerSession(session)
      autoRecoverMonitor.start()

      // Advance past dead threshold
      vi.advanceTimersByTime(600)

      // After recovery, session should be healthy
      const health = autoRecoverMonitor.getSessionHealth('test-session-1')
      expect(health).not.toBeNull()
      expect(health!.status).toBe('healthy')
      expect(health!.missedHeartbeats).toBe(0)

      autoRecoverMonitor.stop()
    })

    it('defaults autoRecover to true when not specified', () => {
      const defaultMonitor = new SessionHealthMonitor({
        heartbeatIntervalMs: 100,
        warningThreshold: 2,
        unhealthyThreshold: 4,
        deadThreshold: 6,
        // autoRecover not specified, should default to true
      })
      const session = createMockSession('test-session-1')
      defaultMonitor.registerSession(session)
      defaultMonitor.start()

      const recoveryAttemptHandler = vi.fn()
      defaultMonitor.on('recovery-attempt', recoveryAttemptHandler)

      // Advance past dead threshold
      vi.advanceTimersByTime(600)

      // Should attempt recovery because autoRecover defaults to true
      expect(recoveryAttemptHandler).toHaveBeenCalledWith('test-session-1', 1)

      defaultMonitor.stop()
    })

    it('tracks recovery attempts correctly across multiple dead events', () => {
      const autoRecoverMonitor = new SessionHealthMonitor({
        heartbeatIntervalMs: 100,
        warningThreshold: 2,
        unhealthyThreshold: 4,
        deadThreshold: 6,
        autoRecover: true,
      })
      const session = createMockSession('test-session-1')
      autoRecoverMonitor.registerSession(session)
      autoRecoverMonitor.start()

      const recoveryAttemptHandler = vi.fn()
      autoRecoverMonitor.on('recovery-attempt', recoveryAttemptHandler)

      // First recovery - attempt 1
      vi.advanceTimersByTime(600)
      expect(recoveryAttemptHandler).toHaveBeenLastCalledWith('test-session-1', 1)

      // Second recovery - attempt 1 again (reset after success)
      vi.advanceTimersByTime(600)
      expect(recoveryAttemptHandler).toHaveBeenLastCalledWith('test-session-1', 1)

      // Third recovery - attempt 1 again (reset after success)
      vi.advanceTimersByTime(600)
      expect(recoveryAttemptHandler).toHaveBeenLastCalledWith('test-session-1', 1)

      // Can recover infinitely because attempts reset on success
      expect(recoveryAttemptHandler).toHaveBeenCalledTimes(3)

      autoRecoverMonitor.stop()
    })

    it('resets recovery attempts after successful recovery (SMI-769)', () => {
      const autoRecoverMonitor = new SessionHealthMonitor({
        heartbeatIntervalMs: 100,
        warningThreshold: 2,
        unhealthyThreshold: 4,
        deadThreshold: 6,
        autoRecover: true,
      })
      const session = createMockSession('test-session-1')
      autoRecoverMonitor.registerSession(session)
      autoRecoverMonitor.start()

      const recoveryAttemptHandler = vi.fn()
      const recoveryFailedHandler = vi.fn()
      autoRecoverMonitor.on('recovery-attempt', recoveryAttemptHandler)
      autoRecoverMonitor.on('recovery-failed', recoveryFailedHandler)

      // Trigger 10 recovery cycles - all should succeed with attempt=1
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(600)
      }

      // All 10 recoveries should have been attempt #1 (because counter resets)
      expect(recoveryAttemptHandler).toHaveBeenCalledTimes(10)
      recoveryAttemptHandler.mock.calls.forEach((call) => {
        expect(call[1]).toBe(1) // All should be attempt 1
      })

      // Should never fail because attempts reset after each success
      expect(recoveryFailedHandler).not.toHaveBeenCalled()

      autoRecoverMonitor.stop()
    })
  })
})
