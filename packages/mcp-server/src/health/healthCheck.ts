/**
 * SMI-740: Health Check Endpoint Handler
 *
 * Provides a simple health check endpoint that returns:
 * - status: "ok" | "degraded" | "unhealthy"
 * - uptime: number (seconds)
 * - version: string
 *
 * This endpoint should always return quickly and not perform
 * expensive operations like database queries.
 */

/**
 * Health check response
 */
export interface HealthResponse {
  /** Current health status */
  status: 'ok' | 'degraded' | 'unhealthy'
  /** Process uptime in seconds */
  uptime: number
  /** Application version */
  version: string
  /** Timestamp of the health check */
  timestamp: string
  /** Optional additional info */
  info?: Record<string, unknown>
}

/**
 * Health check configuration
 */
export interface HealthCheckConfig {
  /** Application version (default: from package.json or '0.0.0') */
  version?: string
  /** Custom health check function */
  customCheck?: () => Promise<{ healthy: boolean; info?: Record<string, unknown> }>
}

/**
 * Process start time for uptime calculation
 */
const processStartTime = Date.now()

/**
 * Health Check Handler
 *
 * Provides lightweight health check functionality that can be used
 * with any HTTP framework or MCP tool.
 */
export class HealthCheck {
  private readonly version: string
  private readonly customCheck?: () => Promise<{ healthy: boolean; info?: Record<string, unknown> }>

  constructor(config: HealthCheckConfig = {}) {
    this.version = config.version ?? process.env.npm_package_version ?? '0.1.0'
    this.customCheck = config.customCheck
  }

  /**
   * Perform health check
   *
   * This is a lightweight check that should return quickly.
   * For deep health checks including dependencies, use ReadinessCheck.
   */
  async check(): Promise<HealthResponse> {
    const uptimeMs = Date.now() - processStartTime
    const uptimeSeconds = Math.floor(uptimeMs / 1000)

    const response: HealthResponse = {
      status: 'ok',
      uptime: uptimeSeconds,
      version: this.version,
      timestamp: new Date().toISOString(),
    }

    // Run custom check if provided
    if (this.customCheck) {
      try {
        const result = await this.customCheck()
        if (!result.healthy) {
          response.status = 'degraded'
        }
        if (result.info) {
          response.info = result.info
        }
      } catch (error) {
        response.status = 'degraded'
        response.info = {
          customCheckError: error instanceof Error ? error.message : 'Unknown error',
        }
      }
    }

    return response
  }

  /**
   * Get uptime in seconds
   */
  getUptime(): number {
    return Math.floor((Date.now() - processStartTime) / 1000)
  }

  /**
   * Get version
   */
  getVersion(): string {
    return this.version
  }

  /**
   * Check if the service is healthy (for simple boolean checks)
   */
  async isHealthy(): Promise<boolean> {
    const result = await this.check()
    return result.status === 'ok'
  }
}

// Default health check instance
let defaultHealthCheck: HealthCheck | null = null

/**
 * Get the default health check instance
 */
export function getHealthCheck(): HealthCheck {
  if (!defaultHealthCheck) {
    defaultHealthCheck = new HealthCheck()
  }
  return defaultHealthCheck
}

/**
 * Create a new health check instance with custom configuration
 */
export function createHealthCheck(config: HealthCheckConfig): HealthCheck {
  return new HealthCheck(config)
}

/**
 * Perform a quick health check using the default instance
 */
export async function checkHealth(): Promise<HealthResponse> {
  return getHealthCheck().check()
}

/**
 * Format health response for HTTP (includes status code)
 */
export function formatHealthResponse(response: HealthResponse): {
  statusCode: number
  body: HealthResponse
} {
  const statusCode = response.status === 'ok' ? 200 : response.status === 'degraded' ? 200 : 503

  return {
    statusCode,
    body: response,
  }
}
