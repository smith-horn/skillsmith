/**
 * SMI-1189: Health Checks
 *
 * Health check and status calculation functions.
 */

import type {
  SessionHealth,
  SessionHealthState,
  SessionHealthStatus,
  RequiredHealthMonitorConfig,
} from './health-types.js'

/**
 * Calculate health information for a session state
 *
 * @param state - The session health state
 * @returns SessionHealth object with calculated fields
 */
export function calculateHealth(state: SessionHealthState): SessionHealth {
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
 * Determine new health status based on missed heartbeats
 *
 * @param missedHeartbeats - Number of missed heartbeats
 * @param config - Health monitor configuration
 * @returns New health status
 */
export function determineHealthStatus(
  missedHeartbeats: number,
  config: RequiredHealthMonitorConfig
): SessionHealthStatus {
  if (missedHeartbeats >= config.deadThreshold) {
    return 'dead'
  }
  if (missedHeartbeats >= config.unhealthyThreshold) {
    return 'unhealthy'
  }
  if (missedHeartbeats >= config.warningThreshold) {
    return 'warning'
  }
  return 'healthy'
}

/**
 * Check if a session has transitioned to a new status
 *
 * @param previousStatus - Previous health status
 * @param currentStatus - Current health status
 * @returns true if status has changed
 */
export function hasStatusChanged(
  previousStatus: SessionHealthStatus,
  currentStatus: SessionHealthStatus
): boolean {
  return previousStatus !== currentStatus
}

/**
 * Check if status requires an event emission
 *
 * @param status - Current health status
 * @returns true if status is warning, unhealthy, or dead
 */
export function isAlertableStatus(status: SessionHealthStatus): boolean {
  return status === 'warning' || status === 'unhealthy' || status === 'dead'
}
