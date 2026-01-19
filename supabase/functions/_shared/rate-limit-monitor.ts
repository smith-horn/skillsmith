/**
 * SMI-1453: Rate Limit Monitoring and Alerting
 *
 * Provides monitoring utilities for tracking rate limit usage
 * and triggering alerts when thresholds are exceeded.
 *
 * Features:
 * - Track rate limit consumption per client
 * - Alert when approaching limits
 * - Metrics collection for dashboards
 * - Support for multiple rate limit tiers
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ============================================================================
// Types
// ============================================================================

export interface RateLimitMetrics {
  clientId: string
  endpoint: string
  tier: 'community' | 'individual' | 'team' | 'enterprise'
  limit: number
  remaining: number
  reset: number
  usagePercent: number
  timestamp: string
}

export interface RateLimitAlert {
  type: 'warning' | 'critical' | 'exceeded'
  clientId: string
  endpoint: string
  usagePercent: number
  message: string
  timestamp: string
}

export interface RateLimitConfig {
  warningThreshold: number // Percentage (e.g., 80)
  criticalThreshold: number // Percentage (e.g., 95)
  alertWebhook?: string
  slackWebhook?: string
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: RateLimitConfig = {
  warningThreshold: 80,
  criticalThreshold: 95,
}

// Rate limits by tier (requests per hour)
const TIER_LIMITS: Record<string, number> = {
  community: 1000,
  individual: 10000,
  team: 100000,
  enterprise: 1000000,
}

// ============================================================================
// Rate Limit Tracker
// ============================================================================

/**
 * Valid tier names for rate limiting
 */
const VALID_TIERS = ['community', 'individual', 'team', 'enterprise'] as const
type ValidTier = (typeof VALID_TIERS)[number]

/**
 * Track rate limit metrics for a client
 */
export function trackRateLimitUsage(
  clientId: string,
  endpoint: string,
  tier: string,
  remaining: number,
  reset: number
): RateLimitMetrics {
  // Validate tier, default to community if invalid
  const validTier: ValidTier = VALID_TIERS.includes(tier as ValidTier)
    ? (tier as ValidTier)
    : 'community'
  const limit = TIER_LIMITS[validTier]
  const used = limit - remaining
  // Clamp usagePercent between 0 and 100
  const usagePercent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)))

  return {
    clientId,
    endpoint,
    tier: validTier,
    limit,
    remaining,
    reset,
    usagePercent,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Check if rate limit usage triggers an alert
 */
export function checkRateLimitAlert(
  metrics: RateLimitMetrics,
  config: RateLimitConfig = DEFAULT_CONFIG
): RateLimitAlert | null {
  if (metrics.remaining <= 0) {
    return {
      type: 'exceeded',
      clientId: metrics.clientId,
      endpoint: metrics.endpoint,
      usagePercent: 100,
      message: `Rate limit exceeded for ${metrics.clientId} on ${metrics.endpoint}`,
      timestamp: new Date().toISOString(),
    }
  }

  if (metrics.usagePercent >= config.criticalThreshold) {
    return {
      type: 'critical',
      clientId: metrics.clientId,
      endpoint: metrics.endpoint,
      usagePercent: metrics.usagePercent,
      message: `Critical: ${metrics.usagePercent}% of rate limit used for ${metrics.clientId} on ${metrics.endpoint}`,
      timestamp: new Date().toISOString(),
    }
  }

  if (metrics.usagePercent >= config.warningThreshold) {
    return {
      type: 'warning',
      clientId: metrics.clientId,
      endpoint: metrics.endpoint,
      usagePercent: metrics.usagePercent,
      message: `Warning: ${metrics.usagePercent}% of rate limit used for ${metrics.clientId} on ${metrics.endpoint}`,
      timestamp: new Date().toISOString(),
    }
  }

  return null
}

// ============================================================================
// Metrics Storage
// ============================================================================

/**
 * Store rate limit metrics in database
 */
export async function storeRateLimitMetrics(
  supabase: SupabaseClient,
  metrics: RateLimitMetrics
): Promise<void> {
  try {
    // Store in rate_limit_metrics table (if exists)
    await supabase.from('rate_limit_metrics').insert({
      client_id: metrics.clientId,
      endpoint: metrics.endpoint,
      tier: metrics.tier,
      limit_value: metrics.limit,
      remaining: metrics.remaining,
      reset_at: new Date(metrics.reset).toISOString(),
      usage_percent: metrics.usagePercent,
      recorded_at: metrics.timestamp,
    })
  } catch {
    // Table might not exist - that's ok for now
    console.warn('Rate limit metrics storage not available')
  }
}

/**
 * Store rate limit alert in database
 */
export async function storeRateLimitAlert(
  supabase: SupabaseClient,
  alert: RateLimitAlert
): Promise<void> {
  try {
    await supabase.from('rate_limit_alerts').insert({
      alert_type: alert.type,
      client_id: alert.clientId,
      endpoint: alert.endpoint,
      usage_percent: alert.usagePercent,
      message: alert.message,
      created_at: alert.timestamp,
    })
  } catch {
    console.warn('Rate limit alerts storage not available')
  }
}

// ============================================================================
// Alert Notifications
// ============================================================================

/**
 * Send alert to configured webhooks
 */
export async function sendRateLimitAlert(
  alert: RateLimitAlert,
  config: RateLimitConfig
): Promise<void> {
  // Send to generic webhook
  if (config.alertWebhook) {
    try {
      await fetch(config.alertWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
      })
    } catch (error) {
      console.error('Failed to send webhook alert:', error)
    }
  }

  // Send to Slack
  if (config.slackWebhook) {
    try {
      const color =
        alert.type === 'exceeded' ? '#FF0000' : alert.type === 'critical' ? '#FF8C00' : '#FFD700'
      await fetch(config.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachments: [
            {
              color,
              title: `Rate Limit ${alert.type.toUpperCase()}`,
              text: alert.message,
              fields: [
                { title: 'Client', value: alert.clientId, short: true },
                { title: 'Endpoint', value: alert.endpoint, short: true },
                { title: 'Usage', value: `${alert.usagePercent}%`, short: true },
              ],
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      })
    } catch (error) {
      console.error('Failed to send Slack alert:', error)
    }
  }
}

// ============================================================================
// Summary Statistics
// ============================================================================

/**
 * Get rate limit usage summary for monitoring dashboard
 */
export async function getRateLimitSummary(
  supabase: SupabaseClient,
  timeRange: '1h' | '24h' | '7d' = '24h'
): Promise<{
  totalRequests: number
  uniqueClients: number
  alertsTriggered: number
  topClients: Array<{ clientId: string; requests: number }>
}> {
  try {
    // Get metrics summary
    const { data: metricsData } = await supabase
      .from('rate_limit_metrics')
      .select('client_id, usage_percent')
      .gte('recorded_at', new Date(Date.now() - getTimeRangeMs(timeRange)).toISOString())

    // Get alerts count
    const { count: alertsCount } = await supabase
      .from('rate_limit_alerts')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - getTimeRangeMs(timeRange)).toISOString())

    const metrics = metricsData || []
    const uniqueClients = new Set(metrics.map((m) => m.client_id))

    // Calculate top clients
    const clientCounts: Record<string, number> = {}
    metrics.forEach((m) => {
      clientCounts[m.client_id] = (clientCounts[m.client_id] || 0) + 1
    })
    const topClients = Object.entries(clientCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([clientId, requests]) => ({ clientId, requests }))

    return {
      totalRequests: metrics.length,
      uniqueClients: uniqueClients.size,
      alertsTriggered: alertsCount || 0,
      topClients,
    }
  } catch {
    return {
      totalRequests: 0,
      uniqueClients: 0,
      alertsTriggered: 0,
      topClients: [],
    }
  }
}

function getTimeRangeMs(range: '1h' | '24h' | '7d'): number {
  switch (range) {
    case '1h':
      return 60 * 60 * 1000
    case '24h':
      return 24 * 60 * 60 * 1000
    case '7d':
      return 7 * 24 * 60 * 60 * 1000
  }
}

// ============================================================================
// Export convenience functions
// ============================================================================

export const RateLimitMonitor = {
  track: trackRateLimitUsage,
  checkAlert: checkRateLimitAlert,
  storeMetrics: storeRateLimitMetrics,
  storeAlert: storeRateLimitAlert,
  sendAlert: sendRateLimitAlert,
  getSummary: getRateLimitSummary,
  TIER_LIMITS,
}

export default RateLimitMonitor
