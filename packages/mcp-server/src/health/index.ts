/**
 * SMI-740: Health Check Module Exports
 *
 * Provides health and readiness check endpoints for the MCP server:
 * - /health: Quick liveness check
 * - /ready: Deep readiness check with dependency verification
 */

// Health check exports
export {
  HealthCheck,
  getHealthCheck,
  createHealthCheck,
  checkHealth,
  formatHealthResponse,
  type HealthResponse,
  type HealthCheckConfig,
} from './healthCheck.js'

// Readiness check exports
export {
  ReadinessCheck,
  getReadinessCheck,
  createReadinessCheck,
  checkReadiness,
  configureReadinessCheck,
  formatReadinessResponse,
  type ReadinessResponse,
  type ReadinessCheckConfig,
  type DependencyCheck,
} from './readinessCheck.js'

/**
 * Combined health and readiness check response
 */
export interface HealthAndReadiness {
  health: import('./healthCheck.js').HealthResponse
  readiness: import('./readinessCheck.js').ReadinessResponse
}

/**
 * Perform both health and readiness checks
 */
export async function checkAll(): Promise<HealthAndReadiness> {
  const { checkHealth } = await import('./healthCheck.js')
  const { checkReadiness } = await import('./readinessCheck.js')

  const [health, readiness] = await Promise.all([checkHealth(), checkReadiness()])

  return { health, readiness }
}
