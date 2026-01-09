/**
 * SMI-1246: PostHog Telemetry Integration
 *
 * Provides product analytics and event tracking via PostHog:
 * - Skill searches and views
 * - Installation events
 * - User engagement metrics
 * - Feature usage tracking
 *
 * Privacy-first: All user IDs are anonymized, no PII collected.
 */

import { PostHog } from 'posthog-node'

/**
 * PostHog configuration options
 */
export interface PostHogConfig {
  /** PostHog API key (starts with phc_) */
  apiKey: string
  /** PostHog host URL (default: https://app.posthog.com) */
  host?: string
  /** Flush interval in milliseconds (default: 10000) */
  flushInterval?: number
  /** Enable debug logging (default: false) */
  debug?: boolean
  /** Disable telemetry entirely (default: false) */
  disabled?: boolean
}

/**
 * Event types for Skillsmith analytics
 */
export type SkillsmithEventType =
  | 'skill_search'
  | 'skill_view'
  | 'skill_install'
  | 'skill_uninstall'
  | 'skill_compare'
  | 'skill_recommend'
  | 'api_error'
  | 'feature_flag_evaluated'

/**
 * Event properties for skill-related events
 */
export interface SkillEventProperties {
  /** Skill ID (author/name format) */
  skill_id?: string
  /** Search query */
  query?: string
  /** Number of results returned */
  result_count?: number
  /** Trust tier filter applied */
  trust_tier?: string
  /** Category filter applied */
  category?: string
  /** Response time in milliseconds */
  duration_ms?: number
  /** Error code if applicable */
  error_code?: string
  /** Source of the event (cli, mcp, api) */
  source?: 'cli' | 'mcp' | 'api'
  /** Additional custom properties */
  [key: string]: unknown
}

// Singleton instance
let posthogInstance: PostHog | null = null
let isDisabled = false

/**
 * Initialize PostHog client
 * Call this at application startup
 *
 * @param config - PostHog configuration
 */
export function initializePostHog(config: PostHogConfig): void {
  if (config.disabled) {
    isDisabled = true
    return
  }

  if (!config.apiKey) {
    console.warn('[PostHog] No API key provided, telemetry disabled')
    isDisabled = true
    return
  }

  posthogInstance = new PostHog(config.apiKey, {
    host: config.host || 'https://app.posthog.com',
    flushInterval: config.flushInterval || 10000,
  })

  if (config.debug) {
    posthogInstance.debug()
  }
}

/**
 * Get the PostHog client instance
 * Returns null if not initialized or disabled
 */
export function getPostHog(): PostHog | null {
  return posthogInstance
}

/**
 * Check if PostHog is enabled and initialized
 */
export function isPostHogEnabled(): boolean {
  return !isDisabled && posthogInstance !== null
}

/**
 * Track an event with PostHog
 * Silently no-ops if PostHog is disabled or not initialized
 *
 * @param distinctId - Anonymous user identifier
 * @param event - Event name
 * @param properties - Event properties
 */
export function trackEvent(
  distinctId: string,
  event: SkillsmithEventType | string,
  properties?: SkillEventProperties
): void {
  if (!isPostHogEnabled() || !posthogInstance) {
    return
  }

  try {
    posthogInstance.capture({
      distinctId,
      event,
      properties: {
        ...properties,
        $lib: 'skillsmith',
        $lib_version: process.env.npm_package_version || 'unknown',
      },
    })
  } catch (error) {
    // Silently fail - telemetry should never break the app
    console.debug('[PostHog] Failed to track event:', error)
  }
}

/**
 * Allowed trait keys for user identification.
 * Only non-PII properties are permitted to prevent data leakage.
 */
export const ALLOWED_TRAITS = ['tier', 'version', 'platform', 'sdk_version'] as const

/**
 * Type for allowed user traits - restricted to prevent PII leakage.
 * Only safe, non-identifying properties are permitted.
 */
export type AllowedUserTraits = {
  /** User tier (e.g., 'free', 'pro', 'enterprise') */
  tier?: string
  /** Application version */
  version?: string
  /** Platform identifier (e.g., 'darwin', 'linux', 'win32') */
  platform?: string
  /** SDK version used */
  sdk_version?: string
}

/**
 * Identify a user with restricted traits.
 *
 * @warning DO NOT pass PII (email, name, IP, etc.) to this function.
 * Only the following safe traits are allowed: tier, version, platform, sdk_version.
 * Any other properties will be silently filtered out to prevent data leakage.
 *
 * @param distinctId - Anonymous user identifier (should be a hash, not an email)
 * @param traits - User properties (restricted to AllowedUserTraits)
 */
export function identifyUser(distinctId: string, traits: AllowedUserTraits): void {
  if (!isPostHogEnabled() || !posthogInstance) {
    return
  }

  // Filter traits to only include allowed keys (defense in depth)
  const safeTraits: Record<string, unknown> = {}
  for (const key of ALLOWED_TRAITS) {
    if (traits[key] !== undefined) {
      safeTraits[key] = traits[key]
    }
  }

  try {
    posthogInstance.identify({
      distinctId,
      properties: safeTraits,
    })
  } catch (error) {
    console.debug('[PostHog] Failed to identify user:', error)
  }
}

/**
 * Check if a feature flag is enabled for a user
 *
 * @param distinctId - Anonymous user identifier
 * @param flagKey - Feature flag key
 * @returns true if enabled, false otherwise
 */
export async function isFeatureFlagEnabled(distinctId: string, flagKey: string): Promise<boolean> {
  if (!isPostHogEnabled() || !posthogInstance) {
    return false
  }

  try {
    const result = await posthogInstance.isFeatureEnabled(flagKey, distinctId)
    trackEvent(distinctId, 'feature_flag_evaluated', {
      flag_key: flagKey,
      flag_value: result,
    })
    return result ?? false
  } catch (error) {
    console.debug('[PostHog] Failed to check feature flag:', error)
    return false
  }
}

/**
 * Flush all pending events immediately
 * Call this before application shutdown
 */
export async function flushPostHog(): Promise<void> {
  if (!posthogInstance) {
    return
  }

  try {
    await posthogInstance.flush()
  } catch (error) {
    console.debug('[PostHog] Failed to flush events:', error)
  }
}

/**
 * Shutdown PostHog client
 * Call this at application shutdown
 */
export async function shutdownPostHog(): Promise<void> {
  if (!posthogInstance) {
    return
  }

  try {
    await posthogInstance.shutdown()
    posthogInstance = null
    isDisabled = false
  } catch (error) {
    console.debug('[PostHog] Failed to shutdown:', error)
  }
}

/**
 * Convenience function to track skill search events
 */
export function trackSkillSearch(
  distinctId: string,
  query: string,
  resultCount: number,
  durationMs: number,
  filters?: { trustTier?: string; category?: string }
): void {
  trackEvent(distinctId, 'skill_search', {
    query,
    result_count: resultCount,
    duration_ms: durationMs,
    trust_tier: filters?.trustTier,
    category: filters?.category,
  })
}

/**
 * Convenience function to track skill view events
 */
export function trackSkillView(
  distinctId: string,
  skillId: string,
  source: 'cli' | 'mcp' | 'api'
): void {
  trackEvent(distinctId, 'skill_view', {
    skill_id: skillId,
    source,
  })
}

/**
 * Convenience function to track skill install events
 */
export function trackSkillInstall(
  distinctId: string,
  skillId: string,
  source: 'cli' | 'mcp' | 'api'
): void {
  trackEvent(distinctId, 'skill_install', {
    skill_id: skillId,
    source,
  })
}

/**
 * Convenience function to track API errors
 */
export function trackApiError(
  distinctId: string,
  errorCode: string,
  endpoint: string,
  durationMs?: number
): void {
  trackEvent(distinctId, 'api_error', {
    error_code: errorCode,
    endpoint,
    duration_ms: durationMs,
  })
}
