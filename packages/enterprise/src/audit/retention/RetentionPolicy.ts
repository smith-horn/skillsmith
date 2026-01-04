/**
 * SMI-961: 90-Day Configurable Retention Policy
 *
 * Defines retention policy configuration and types for enterprise audit log management.
 * Supports configurable retention periods, per-event-type policies, and compliance features.
 */

import type { AuditEventType } from '@skillsmith/core'

/**
 * Minimum retention period in days (compliance requirement)
 */
export const ENTERPRISE_MIN_RETENTION_DAYS = 30

/**
 * Maximum retention period in days
 */
export const ENTERPRISE_MAX_RETENTION_DAYS = 90

/**
 * Default retention period in days
 */
export const DEFAULT_RETENTION_DAYS = 90

/**
 * Configuration for enterprise audit log retention
 */
export interface RetentionConfig {
  /**
   * Default retention period in days (30-90)
   * @default 90
   */
  defaultDays: number

  /**
   * Per-event-type retention overrides
   * Keys are AuditEventType values, values are retention days
   */
  perEventType?: Record<string, number>

  /**
   * Whether to archive events before deletion
   * @default false
   */
  archiveBeforeDelete: boolean

  /**
   * Path for archived events (required if archiveBeforeDelete is true)
   */
  archivePath?: string

  /**
   * Whether legal hold is enabled (prevents all deletions)
   * @default false
   */
  legalHoldEnabled?: boolean
}

/**
 * Result of a retention enforcement operation
 */
export interface RetentionResult {
  /**
   * Whether the operation was successful
   */
  success: boolean

  /**
   * Number of events processed
   */
  processedCount: number

  /**
   * Number of events deleted
   */
  deletedCount: number

  /**
   * Number of events archived
   */
  archivedCount: number

  /**
   * Number of events skipped (e.g., due to legal hold)
   */
  skippedCount: number

  /**
   * Events that were archived (if archiveBeforeDelete is enabled)
   */
  archivedEvents?: RetentionAuditEvent[]

  /**
   * Error message if operation failed
   */
  error?: string

  /**
   * Timestamp of when enforcement was executed
   */
  executedAt: string

  /**
   * Duration of the enforcement operation in milliseconds
   */
  durationMs: number
}

/**
 * Represents an audit event for retention purposes
 * Named RetentionAuditEvent to avoid conflict with enterprise AuditEvent
 */
export interface RetentionAuditEvent {
  id: string
  event_type: AuditEventType
  timestamp: string
  actor: string
  resource: string
  action: string
  result: string
  metadata?: Record<string, unknown>
  created_at: string
}

/**
 * Legal hold configuration
 */
export interface LegalHoldConfig {
  /**
   * Whether legal hold is currently active
   */
  enabled: boolean

  /**
   * Reason for the legal hold
   */
  reason?: string

  /**
   * Date when legal hold was activated
   */
  activatedAt?: string

  /**
   * User or system that activated the hold
   */
  activatedBy?: string
}

/**
 * Scheduled cleanup job configuration
 */
export interface CleanupJobConfig {
  /**
   * Whether the cleanup job is enabled
   * @default true
   */
  enabled: boolean

  /**
   * Cron expression for scheduling (default: daily at 2 AM)
   * @default '0 2 * * *'
   */
  schedule?: string

  /**
   * Maximum number of events to process per run
   * @default 10000
   */
  batchSize?: number

  /**
   * Whether to run cleanup on startup
   * @default false
   */
  runOnStartup?: boolean
}

/**
 * Validates retention configuration
 *
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateRetentionConfig(config: RetentionConfig): void {
  // Validate defaultDays
  if (config.defaultDays < ENTERPRISE_MIN_RETENTION_DAYS) {
    throw new Error(
      `Invalid defaultDays: minimum is ${ENTERPRISE_MIN_RETENTION_DAYS} days, got ${config.defaultDays}`
    )
  }
  if (config.defaultDays > ENTERPRISE_MAX_RETENTION_DAYS) {
    throw new Error(
      `Invalid defaultDays: maximum is ${ENTERPRISE_MAX_RETENTION_DAYS} days, got ${config.defaultDays}`
    )
  }
  if (!Number.isInteger(config.defaultDays)) {
    throw new Error(`Invalid defaultDays: must be an integer, got ${config.defaultDays}`)
  }

  // Validate perEventType if provided
  if (config.perEventType) {
    for (const [eventType, days] of Object.entries(config.perEventType)) {
      if (days < ENTERPRISE_MIN_RETENTION_DAYS) {
        throw new Error(
          `Invalid retention for ${eventType}: minimum is ${ENTERPRISE_MIN_RETENTION_DAYS} days, got ${days}`
        )
      }
      if (days > ENTERPRISE_MAX_RETENTION_DAYS) {
        throw new Error(
          `Invalid retention for ${eventType}: maximum is ${ENTERPRISE_MAX_RETENTION_DAYS} days, got ${days}`
        )
      }
      if (!Number.isInteger(days)) {
        throw new Error(`Invalid retention for ${eventType}: must be an integer, got ${days}`)
      }
    }
  }

  // Validate archivePath if archiveBeforeDelete is enabled
  if (config.archiveBeforeDelete && !config.archivePath) {
    throw new Error('archivePath is required when archiveBeforeDelete is enabled')
  }
}

/**
 * Creates a default retention configuration
 *
 * @returns Default RetentionConfig
 */
export function createDefaultRetentionConfig(): RetentionConfig {
  return {
    defaultDays: DEFAULT_RETENTION_DAYS,
    archiveBeforeDelete: false,
    legalHoldEnabled: false,
  }
}

/**
 * Gets the retention days for a specific event type
 *
 * @param config - Retention configuration
 * @param eventType - Event type to get retention for
 * @returns Retention days for the event type
 */
export function getRetentionDaysForEventType(
  config: RetentionConfig,
  eventType: AuditEventType
): number {
  if (config.perEventType && config.perEventType[eventType] !== undefined) {
    return config.perEventType[eventType]
  }
  return config.defaultDays
}
