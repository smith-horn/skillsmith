/**
 * SMI-1189: Health Types
 *
 * Type definitions for session health monitoring.
 */

import type { SessionData } from './SessionContext.js'

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
 * Required configuration (with defaults applied)
 */
export type RequiredHealthMonitorConfig = Required<HealthMonitorConfig>

/**
 * Events emitted by the health monitor
 */
export type SessionHealthEvents = {
  heartbeat: [sessionId: string]
  warning: [health: SessionHealth]
  unhealthy: [health: SessionHealth]
  dead: [health: SessionHealth]
  recovered: [sessionId: string]
  'recovery-attempt': [sessionId: string, attempt: number]
  'recovery-failed': [sessionId: string, reason: string]
}

/**
 * Internal state for tracked sessions
 */
export interface SessionHealthState {
  sessionId: string
  startedAt: number
  lastHeartbeat: number
  missedHeartbeats: number
  status: SessionHealthStatus
  sessionData?: SessionData
  /** Number of recovery attempts made for this session */
  recoveryAttempts: number
}

/** Maximum number of recovery attempts before giving up */
export const MAX_RECOVERY_ATTEMPTS = 3

/** Default health monitor configuration */
export const DEFAULT_CONFIG: RequiredHealthMonitorConfig = {
  heartbeatIntervalMs: 30000,
  warningThreshold: 2,
  unhealthyThreshold: 4,
  deadThreshold: 6,
  autoRecover: true,
}
