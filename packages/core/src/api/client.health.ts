/**
 * @fileoverview API Client Health Check Implementation
 * @module @skillsmith/core/api/client.health
 * @see SMI-1244: API client for fetching skills from live Supabase endpoints
 * @see SMI-2741: Split from client.ts to meet 500-line standard
 *
 * Health check utility extracted from SkillsmithApiClient to keep
 * client.ts under the 500-line standard.
 */

import { buildRequestHeaders } from './utils.js'

/**
 * Check API health status
 *
 * Standalone implementation used by SkillsmithApiClient.checkHealth().
 * Returns a synthetic healthy response in offline mode.
 *
 * @param baseUrl - API base URL
 * @param anonKey - Supabase anon key
 * @param offlineMode - Whether client is in offline mode
 * @returns Health status object
 */
export async function checkApiHealth(
  baseUrl: string,
  anonKey: string | undefined,
  offlineMode: boolean
): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  version: string
}> {
  // In offline mode, return synthetic healthy status
  if (offlineMode) {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: 'offline',
    }
  }

  try {
    // Simple health check - try to reach the API
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000) // 5s timeout for health

    const response = await fetch(`${baseUrl}/health`, {
      headers: buildRequestHeaders(anonKey),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (response.ok) {
      // Try to parse JSON response, fall back to basic healthy status
      try {
        const data = (await response.json()) as { status?: string; version?: string }
        return {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: data.version || '1.0.0',
        }
      } catch {
        return {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        }
      }
    }

    // Non-OK response indicates degraded service
    return {
      status: response.status >= 500 ? 'unhealthy' : 'degraded',
      timestamp: new Date().toISOString(),
      version: 'unknown',
    }
  } catch {
    // Network errors indicate unhealthy service
    return {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      version: 'unknown',
    }
  }
}
