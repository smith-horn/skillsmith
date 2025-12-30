/**
 * SMI-761: Session Health Monitoring
 *
 * Provides health monitoring for swarm sessions:
 * - Heartbeat mechanism every 30 seconds
 * - Automatic detection of stuck sessions
 * - Session state recovery capabilities
 * - Metrics for session health
 */

import { EventEmitter } from 'node:events'
import type { SessionData } from './SessionContext.js'
import { getMetrics } from '../telemetry/metrics.js'

/**
 * Health status for a session
 */
export type SessionHealthStatus = 'healthy' | 'warning' | 'unhealthy' | 'dead'

/**
 * Session health information
 */
export interface SessionHealth {
  /** Session ID */
  sessionId: string
  /** Current health status */
  status: SessionHealthStatus
  /** Last heartbeat timestamp (ISO) */
  lastHeartbeat: string
  /** Seconds since last heartbeat */
  secondsSinceHeartbeat: number
  /** Session uptime in seconds */
  uptimeSeconds: number
  /** Number of missed heartbeats */
  missedHeartbeats: number
  /** Whether the session can be recovered */
  recoverable: boolean
}

/**
 * Configuration for health monitor
 */
export interface HealthMonitorConfig {
  /** Heartbeat interval in milliseconds (default: 30000 = 30s) */
  heartbeatIntervalMs?: number
  /** Warning threshold in missed heartbeats (default: 2) */
  warningThreshold?: number
  /** Unhealthy threshold in missed heartbeats (default: 4) */
  unhealthyThreshold?: number
  /** Dead threshold in missed heartbeats (default: 6) */
  deadThreshold?: number
  /** Enable automatic recovery attempts (default: true) */
  autoRecover?: boolean
}

/**
 * Events emitted by the health monitor
 */
export interface SessionHealthEvents {
  heartbeat: (sessionId: string) => void
  warning: (health: SessionHealth) => void
  unhealthy: (health: SessionHealth) => void
  dead: (health: SessionHealth) => void
  recovered: (sessionId: string) => void
}

/**
 * Session Health Monitor
 *
 * Tracks session health through heartbeats and detects stuck sessions.
 */
export class SessionHealthMonitor extends EventEmitter {
  private config: Required<HealthMonitorConfig>
  private sessions = new Map<string, SessionHealthState>()
  private checkInterval: NodeJS.Timeout | null = null
  private started = false

  constructor(config: HealthMonitorConfig = {}) {
    super()
    this.config = {
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30000,
      warningThreshold: config.warningThreshold ?? 2,
      unhealthyThreshold: config.unhealthyThreshold ?? 4,
      deadThreshold: config.deadThreshold ?? 6,
      autoRecover: config.autoRecover ?? true,
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
    })

    // Record metric
    const metrics = getMetrics()
    metrics.activeOperations.set(this.sessions.size, { type: 'session' })
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

    // Update metric
    const metrics = getMetrics()
    metrics.activeOperations.set(this.sessions.size, { type: 'session' })
  }

  /**
   * Get health status for a session
   */
  getSessionHealth(sessionId: string): SessionHealth | null {
    const state = this.sessions.get(sessionId)
    if (!state) {
      return null
    }

    return this.calculateHealth(state)
  }

  /**
   * Get health status for all sessions
   */
  getAllSessionHealth(): SessionHealth[] {
    return Array.from(this.sessions.values()).map((state) => this.calculateHealth(state))
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
   * Calculate health for a session state
   */
  private calculateHealth(state: SessionHealthState): SessionHealth {
    const now = Date.now()
    const secondsSinceHeartbeat = Math.floor((now - state.lastHeartbeat) / 1000)
    const uptimeSeconds = Math.floor((now - state.startedAt) / 1000)

    return {
      sessionId: state.sessionId,
      status: state.status,
      lastHeartbeat: new Date(state.lastHeartbeat).toISOString(),
      secondsSinceHeartbeat,
      uptimeSeconds,
      missedHeartbeats: state.missedHeartbeats,
      recoverable: state.status !== 'dead' && state.sessionData !== undefined,
    }
  }

  /**
   * Check all sessions for health issues
   */
  private checkAllSessions(): void {
    const metrics = getMetrics()

    for (const state of this.sessions.values()) {
      const previousStatus = state.status
      state.missedHeartbeats++

      // Determine new status based on missed heartbeats
      if (state.missedHeartbeats >= this.config.deadThreshold) {
        state.status = 'dead'
      } else if (state.missedHeartbeats >= this.config.unhealthyThreshold) {
        state.status = 'unhealthy'
      } else if (state.missedHeartbeats >= this.config.warningThreshold) {
        state.status = 'warning'
      }

      // Emit events on status change
      if (state.status !== previousStatus) {
        const health = this.calculateHealth(state)

        switch (state.status) {
          case 'warning':
            this.emit('warning', health)
            metrics.mcpErrorCount.increment({ type: 'session_warning' })
            break
          case 'unhealthy':
            this.emit('unhealthy', health)
            metrics.mcpErrorCount.increment({ type: 'session_unhealthy' })
            break
          case 'dead':
            this.emit('dead', health)
            metrics.mcpErrorCount.increment({ type: 'session_dead' })
            break
        }
      }
    }
  }
}

/**
 * Internal state for tracked sessions
 */
interface SessionHealthState {
  sessionId: string
  startedAt: number
  lastHeartbeat: number
  missedHeartbeats: number
  status: SessionHealthStatus
  sessionData?: SessionData
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
