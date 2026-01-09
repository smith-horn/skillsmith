/**
 * SMI-761: Session Health Monitoring
 * SMI-1189: Refactored to use TypedEventEmitter
 *
 * Provides health monitoring for swarm sessions:
 * - Heartbeat mechanism every 30 seconds
 * - Automatic detection of stuck sessions
 * - Session state recovery capabilities
 * - Metrics for session health
 */

import type { SessionData } from './SessionContext.js'
import { TypedEventEmitter } from './typed-event-emitter.js'
import {
  type SessionHealth,
  type SessionHealthStatus,
  type HealthMonitorConfig,
  type RequiredHealthMonitorConfig,
  type SessionHealthState,
  type SessionHealthEvents,
  MAX_RECOVERY_ATTEMPTS,
  DEFAULT_CONFIG,
} from './health-types.js'
import { calculateHealth, determineHealthStatus, hasStatusChanged } from './health-checks.js'
import {
  recordSessionCount,
  recordRecoverySuccess,
  recordHealthStatusError,
} from './metrics-collector.js'

// Re-export types for backwards compatibility
export type { SessionHealth, SessionHealthStatus, HealthMonitorConfig, SessionHealthEvents }

/**
 * Session Health Monitor
 *
 * Tracks session health through heartbeats and detects stuck sessions.
 */
export class SessionHealthMonitor extends TypedEventEmitter<SessionHealthEvents> {
  private config: RequiredHealthMonitorConfig
  private sessions = new Map<string, SessionHealthState>()
  private checkInterval: NodeJS.Timeout | null = null
  private started = false

  constructor(config: HealthMonitorConfig = {}) {
    super()
    this.config = {
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_CONFIG.heartbeatIntervalMs,
      warningThreshold: config.warningThreshold ?? DEFAULT_CONFIG.warningThreshold,
      unhealthyThreshold: config.unhealthyThreshold ?? DEFAULT_CONFIG.unhealthyThreshold,
      deadThreshold: config.deadThreshold ?? DEFAULT_CONFIG.deadThreshold,
      autoRecover: config.autoRecover ?? DEFAULT_CONFIG.autoRecover,
    }
  }

  /**
   * Start monitoring a session
   */
  registerSession(session: SessionData): void {
    const now = Date.now()
    this.sessions.set(session.sessionId, {
      sessionId: session.sessionId,
      startedAt: now,
      lastHeartbeat: now,
      missedHeartbeats: 0,
      status: 'healthy',
      sessionData: session,
      recoveryAttempts: 0,
    })

    recordSessionCount(this.sessions.size)
  }

  /**
   * Record a heartbeat for a session
   */
  heartbeat(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) {
      return
    }

    const wasUnhealthy = state.status !== 'healthy'
    state.lastHeartbeat = Date.now()
    state.missedHeartbeats = 0
    state.status = 'healthy'

    this.emit('heartbeat', sessionId)

    // If recovering from unhealthy state, emit recovered event
    if (wasUnhealthy) {
      this.emit('recovered', sessionId)
    }
  }

  /**
   * Stop monitoring a session
   */
  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    recordSessionCount(this.sessions.size)
  }

  /**
   * Get health status for a session
   */
  getSessionHealth(sessionId: string): SessionHealth | null {
    const state = this.sessions.get(sessionId)
    if (!state) {
      return null
    }

    return calculateHealth(state)
  }

  /**
   * Get health status for all sessions
   */
  getAllSessionHealth(): SessionHealth[] {
    return Array.from(this.sessions.values()).map((state) => calculateHealth(state))
  }

  /**
   * Start the health monitor
   */
  start(): void {
    if (this.started) {
      return
    }

    this.started = true

    // Start health check interval (runs every heartbeat interval)
    this.checkInterval = setInterval(() => {
      this.checkAllSessions()
    }, this.config.heartbeatIntervalMs)

    // Don't prevent Node.js from exiting
    this.checkInterval.unref()
  }

  /**
   * Stop the health monitor
   */
  stop(): void {
    if (!this.started) {
      return
    }

    this.started = false

    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
  }

  /**
   * Check if the monitor is running
   */
  isRunning(): boolean {
    return this.started
  }

  /**
   * Get the number of monitored sessions
   */
  getSessionCount(): number {
    return this.sessions.size
  }

  /**
   * Attempt to recover a dead session from stored sessionData
   *
   * @param state - The session health state to recover
   * @returns true if recovery was successful, false otherwise
   */
  private attemptRecovery(state: SessionHealthState): boolean {
    // Check if we've exceeded max recovery attempts
    if (state.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this.emit('recovery-failed', state.sessionId, 'Max recovery attempts exceeded')
      return false
    }

    // Check if we have session data to restore from
    if (!state.sessionData) {
      this.emit('recovery-failed', state.sessionId, 'No session data available for recovery')
      return false
    }

    // Increment recovery attempts
    state.recoveryAttempts++

    // Emit recovery attempt event
    this.emit('recovery-attempt', state.sessionId, state.recoveryAttempts)

    // Restore session health state from stored sessionData
    // Reset the session to healthy state with a fresh heartbeat
    const now = Date.now()
    state.lastHeartbeat = now
    state.missedHeartbeats = 0
    state.status = 'healthy'
    state.recoveryAttempts = 0 // Reset recovery attempts on success (SMI-769)

    // Emit recovered event
    this.emit('recovered', state.sessionId)

    // Record successful recovery metric
    recordRecoverySuccess()

    return true
  }

  /**
   * Check all sessions for health issues
   */
  private checkAllSessions(): void {
    for (const state of this.sessions.values()) {
      const previousStatus = state.status
      state.missedHeartbeats++

      // Determine new status based on missed heartbeats
      state.status = determineHealthStatus(state.missedHeartbeats, this.config)

      // Emit events on status change
      if (hasStatusChanged(previousStatus, state.status)) {
        const health = calculateHealth(state)

        switch (state.status) {
          case 'warning':
            this.emit('warning', health)
            recordHealthStatusError(state.status)
            break
          case 'unhealthy':
            this.emit('unhealthy', health)
            recordHealthStatusError(state.status)
            break
          case 'dead':
            this.emit('dead', health)
            recordHealthStatusError(state.status)

            // Attempt automatic recovery if enabled
            if (this.config.autoRecover) {
              this.attemptRecovery(state)
            }
            break
        }
      }
    }
  }
}

/**
 * Default health monitor instance
 */
let defaultMonitor: SessionHealthMonitor | null = null

/**
 * Get the default health monitor instance
 */
export function getHealthMonitor(): SessionHealthMonitor {
  if (!defaultMonitor) {
    defaultMonitor = new SessionHealthMonitor()
  }
  return defaultMonitor
}

/**
 * Initialize the health monitor with custom config
 */
export function initializeHealthMonitor(config?: HealthMonitorConfig): SessionHealthMonitor {
  if (defaultMonitor) {
    defaultMonitor.stop()
  }
  defaultMonitor = new SessionHealthMonitor(config)
  defaultMonitor.start()
  return defaultMonitor
}

/**
 * Shutdown the health monitor
 */
export function shutdownHealthMonitor(): void {
  if (defaultMonitor) {
    defaultMonitor.stop()
    defaultMonitor = null
  }
}
