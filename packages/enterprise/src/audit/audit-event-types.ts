/**
 * SMI-957: Enterprise Audit Event Types
 *
 * Type definitions for enterprise-specific audit events
 * including SSO, RBAC, and license validation.
 */

import type { AuditLogEntry, AuditActor, AuditResult, AuditLoggerConfig } from '@skillsmith/core'

// ============================================================================
// Event Types
// ============================================================================

/**
 * Enterprise-specific audit event types
 */
export type EnterpriseAuditEventType =
  | 'sso_login'
  | 'rbac_check'
  | 'license_validation'
  | 'exporter_registered'
  | 'exporter_unregistered'
  | 'export_completed'
  | 'export_failed'

/**
 * Combined audit event types (core + enterprise)
 */
export type ExtendedAuditEventType =
  | 'url_fetch'
  | 'file_access'
  | 'skill_install'
  | 'skill_uninstall'
  | 'security_scan'
  | 'cache_operation'
  | 'source_sync'
  | 'config_change'
  | EnterpriseAuditEventType

// ============================================================================
// Input Types
// ============================================================================

/**
 * SSO Login audit event input (for logSSOEvent method)
 */
export interface SSOLoginInput {
  /** SSO provider (e.g., 'okta', 'azure_ad', 'google') */
  provider: string
  /** User identifier (email or username) */
  userId: string
  /** Result of the SSO operation */
  result: AuditResult
  /** Session ID if login was successful */
  sessionId?: string
  /** IP address of the client */
  clientIp?: string
  /** User agent string */
  userAgent?: string
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * RBAC permission check audit event input (for logRBACEvent method)
 */
export interface RBACCheckInput {
  /** User or service account performing the action */
  principal: string
  /** Principal type */
  principalType: 'user' | 'service_account' | 'api_key'
  /** Resource being accessed */
  resource: string
  /** Permission being checked */
  permission: string
  /** Roles that were evaluated */
  roles?: string[]
  /** Result of the permission check */
  result: AuditResult
  /** Denial reason if blocked */
  denialReason?: string
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * License validation audit event input (for logLicenseEvent method)
 */
export interface LicenseCheckInput {
  /** License key identifier (last 4 chars only for security) */
  licenseKeyHint: string
  /** License tier being validated */
  tier: 'starter' | 'professional' | 'enterprise' | 'unlimited'
  /** Feature being checked */
  feature?: string
  /** Result of the validation */
  result: AuditResult
  /** Expiration date of the license */
  expiresAt?: string
  /** Seats used vs total */
  seatsUsed?: number
  seatsTotal?: number
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

// ============================================================================
// Entry Types
// ============================================================================

/**
 * Extended audit log entry with enterprise event types
 */
export interface EnterpriseAuditLogEntry extends Omit<AuditLogEntry, 'event_type'> {
  event_type: ExtendedAuditEventType
}

/**
 * Audit event data for export (read-only representation)
 */
export interface AuditEvent {
  id: string
  event_type: ExtendedAuditEventType
  timestamp: string
  actor: AuditActor
  resource: string
  action: string
  result: AuditResult
  metadata?: Record<string, unknown>
  created_at: string
}

// ============================================================================
// Exporter Types
// ============================================================================

/**
 * Interface for audit event exporters
 */
export interface AuditExporter {
  /** Unique name for this exporter */
  name: string
  /** Export events to external system */
  export(events: AuditEvent[]): Promise<void>
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Enterprise audit logger configuration
 */
export interface EnterpriseAuditLoggerConfig extends AuditLoggerConfig {
  /**
   * Minimum retention period in days
   * @default 30
   */
  minRetentionDays?: number

  /**
   * Maximum retention period in days
   * @default 90
   */
  maxRetentionDays?: number

  /**
   * Buffer size for batch exports
   * @default 100
   */
  exportBufferSize?: number

  /**
   * Auto-flush interval in milliseconds (0 to disable)
   * @default 0
   */
  autoFlushInterval?: number
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Enterprise minimum retention days
 */
export const ENTERPRISE_MIN_RETENTION_DAYS = 30

/**
 * Enterprise maximum retention days
 */
export const ENTERPRISE_MAX_RETENTION_DAYS = 90
