/**
 * SMI-1189: Metrics Collector
 *
 * Metrics collection logic for session health monitoring.
 */

import { getMetrics } from '../telemetry/metrics.js'
import type { SessionHealthStatus } from './health-types.js'

/**
 * Record session count metric
 *
 * @param sessionCount - Current number of active sessions
 */
export function recordSessionCount(sessionCount: number): void {
  const metrics = getMetrics()
  metrics.activeOperations.set(sessionCount, { type: 'session' })
}

/**
 * Record successful session recovery metric
 */
export function recordRecoverySuccess(): void {
  const metrics = getMetrics()
  // SMI-770: Use request counter, not error counter for successful recoveries
  metrics.mcpRequestCount.increment({ type: 'session_recovered' })
}

/**
 * Record health status change error metric
 *
 * @param status - The new health status that triggered an error
 */
export function recordHealthStatusError(status: SessionHealthStatus): void {
  const metrics = getMetrics()

  switch (status) {
    case 'warning':
      metrics.mcpErrorCount.increment({ type: 'session_warning' })
      break
    case 'unhealthy':
      metrics.mcpErrorCount.increment({ type: 'session_unhealthy' })
      break
    case 'dead':
      metrics.mcpErrorCount.increment({ type: 'session_dead' })
      break
    // 'healthy' does not record an error
  }
}
