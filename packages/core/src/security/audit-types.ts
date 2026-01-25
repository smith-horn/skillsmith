/**
 * SMI-733: Audit Logger Types
 *
 * Type definitions for the audit logging system.
 * Extracted from AuditLogger.ts for file size compliance.
 */

/**
 * Types of security events that are audited
 */
export type AuditEventType =
  | 'url_fetch'
  | 'file_access'
  | 'skill_install'
  | 'skill_uninstall'
  | 'security_scan'
  | 'cache_operation'
  | 'source_sync'
  | 'config_change'

/**
 * Actor performing the action
 */
export type AuditActor = 'user' | 'system' | 'adapter' | 'scanner'

/**
 * Result of the audited action
 */
export type AuditResult = 'success' | 'blocked' | 'error' | 'warning'

/**
 * Database row type for audit logs
 */
export interface AuditLogRow {
  id: string
  event_type: AuditEventType
  timestamp: string
  actor: AuditActor
  resource: string
  action: string
  result: AuditResult
  metadata: string | null
  created_at: string
}

/**
 * Audit log entry structure
 */
export interface AuditLogEntry {
  id: string
  event_type: AuditEventType
  timestamp: string
  actor: AuditActor
  resource: string
  action: string
  result: AuditResult
  metadata?: Record<string, unknown>
  created_at: string
}

/**
 * Query filters for audit log retrieval
 */
export interface AuditQueryFilter {
  event_type?: AuditEventType
  actor?: AuditActor
  resource?: string
  result?: AuditResult
  since?: Date
  until?: Date
  limit?: number
  offset?: number
}

/**
 * Minimum retention period in days (security requirement)
 */
export const MIN_RETENTION_DAYS = 1

/**
 * Maximum retention period in days (storage constraint)
 */
export const MAX_RETENTION_DAYS = 3650 // 10 years

/**
 * Configuration options for AuditLogger
 */
export interface AuditLoggerConfig {
  /**
   * Enable automatic cleanup of old logs on initialization
   * @default false
   */
  autoCleanup?: boolean

  /**
   * Number of days to retain logs (used with autoCleanup)
   * Must be between MIN_RETENTION_DAYS (1) and MAX_RETENTION_DAYS (3650)
   * @default 90
   */
  retentionDays?: number
}

/**
 * Audit statistics
 */
export interface AuditStats {
  total_events: number
  events_by_type: Record<AuditEventType, number>
  events_by_result: Record<AuditResult, number>
  blocked_events: number
  error_events: number
  oldest_event: string | null
  newest_event: string | null
}
