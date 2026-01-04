/**
 * SMI-957: Enterprise Audit Logger
 *
 * Extends the core AuditLogger with enterprise-specific features:
 * - SSO login event tracking
 * - RBAC permission check logging
 * - License validation auditing
 * - Configurable retention (30-90 days)
 * - Exporter registration pattern for compliance
 */

import { AuditLogger as CoreAuditLogger } from '@skillsmith/core'
import type {
  AuditLogEntry,
  AuditActor,
  AuditResult,
  AuditQueryFilter,
  AuditLoggerConfig,
} from '@skillsmith/core'
import type { Database as DatabaseType } from 'better-sqlite3'

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

/**
 * Interface for audit event exporters
 */
export interface AuditExporter {
  /** Unique name for this exporter */
  name: string
  /** Export events to external system */
  export(events: AuditEvent[]): Promise<void>
}

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

/**
 * Enterprise retention constraints
 */
export const ENTERPRISE_MIN_RETENTION_DAYS = 30
export const ENTERPRISE_MAX_RETENTION_DAYS = 90

/**
 * Enterprise Audit Logger with enhanced features for compliance
 *
 * @example
 * ```typescript
 * const logger = new EnterpriseAuditLogger(db, { retentionDays: 60 })
 *
 * // Register exporters
 * logger.registerExporter({
 *   name: 'splunk',
 *   async export(events) {
 *     await splunkClient.ingest(events)
 *   }
 * })
 *
 * // Log enterprise events
 * logger.logSSOEvent({
 *   provider: 'okta',
 *   userId: 'user@example.com',
 *   result: 'success',
 *   sessionId: 'sess_123'
 * })
 *
 * // Flush to all exporters
 * await logger.flush()
 * ```
 */
export class EnterpriseAuditLogger extends CoreAuditLogger {
  private exporters: AuditExporter[] = []
  private eventBuffer: AuditEvent[] = []
  private readonly enterpriseConfig: EnterpriseAuditLoggerConfig
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(db: DatabaseType, config: EnterpriseAuditLoggerConfig = {}) {
    // Validate and constrain retention to enterprise limits
    const constrainedRetention = EnterpriseAuditLogger.constrainRetention(
      config.retentionDays,
      config.minRetentionDays ?? ENTERPRISE_MIN_RETENTION_DAYS,
      config.maxRetentionDays ?? ENTERPRISE_MAX_RETENTION_DAYS
    )

    super(db, {
      ...config,
      retentionDays: constrainedRetention,
    })

    this.enterpriseConfig = {
      minRetentionDays: config.minRetentionDays ?? ENTERPRISE_MIN_RETENTION_DAYS,
      maxRetentionDays: config.maxRetentionDays ?? ENTERPRISE_MAX_RETENTION_DAYS,
      exportBufferSize: config.exportBufferSize ?? 100,
      autoFlushInterval: config.autoFlushInterval ?? 0,
      ...config,
      retentionDays: constrainedRetention,
    }

    // Setup auto-flush if configured
    if (this.enterpriseConfig.autoFlushInterval && this.enterpriseConfig.autoFlushInterval > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(console.error)
      }, this.enterpriseConfig.autoFlushInterval)
    }
  }

  /**
   * Constrain retention days to enterprise limits
   */
  private static constrainRetention(
    requested: number | undefined,
    min: number,
    max: number
  ): number {
    const retention = requested ?? 90
    return Math.max(min, Math.min(max, retention))
  }

  /**
   * Register an exporter to receive audit events
   *
   * @param exporter - The exporter to register
   * @throws Error if an exporter with the same name is already registered
   */
  registerExporter(exporter: AuditExporter): void {
    if (this.exporters.some((e) => e.name === exporter.name)) {
      throw new Error(`Exporter '${exporter.name}' is already registered`)
    }

    this.exporters.push(exporter)

    // Log the registration
    this.log({
      event_type: 'config_change' as const,
      actor: 'system',
      resource: `exporter:${exporter.name}`,
      action: 'exporter_registered',
      result: 'success',
      metadata: {
        exporterName: exporter.name,
        totalExporters: this.exporters.length,
      },
    })
  }

  /**
   * Unregister an exporter by name
   *
   * @param name - The name of the exporter to unregister
   * @returns true if the exporter was found and removed, false otherwise
   */
  unregisterExporter(name: string): boolean {
    const index = this.exporters.findIndex((e) => e.name === name)
    if (index === -1) {
      return false
    }

    this.exporters.splice(index, 1)

    // Log the unregistration
    this.log({
      event_type: 'config_change' as const,
      actor: 'system',
      resource: `exporter:${name}`,
      action: 'exporter_unregistered',
      result: 'success',
      metadata: {
        exporterName: name,
        totalExporters: this.exporters.length,
      },
    })

    return true
  }

  /**
   * Get list of registered exporter names
   */
  getRegisteredExporters(): string[] {
    return this.exporters.map((e) => e.name)
  }

  /**
   * Log an SSO login event
   *
   * @param event - SSO event details
   */
  logSSOEvent(event: SSOLoginInput): void {
    this.logEnterpriseEvent({
      event_type: 'sso_login',
      actor: 'system',
      resource: `sso:${event.provider}`,
      action: event.result === 'success' ? 'login' : 'login_attempt',
      result: event.result,
      metadata: {
        provider: event.provider,
        userId: event.userId,
        sessionId: event.sessionId,
        clientIp: event.clientIp,
        userAgent: event.userAgent,
        ...event.metadata,
      },
    })
  }

  /**
   * Log an RBAC permission check event
   *
   * @param event - RBAC check event details
   */
  logRBACEvent(event: RBACCheckInput): void {
    this.logEnterpriseEvent({
      event_type: 'rbac_check',
      actor: event.principalType === 'user' ? 'user' : 'system',
      resource: event.resource,
      action: `check:${event.permission}`,
      result: event.result,
      metadata: {
        principal: event.principal,
        principalType: event.principalType,
        permission: event.permission,
        roles: event.roles,
        denialReason: event.denialReason,
        ...event.metadata,
      },
    })
  }

  /**
   * Log a license validation event
   *
   * @param event - License validation event details
   */
  logLicenseEvent(event: LicenseCheckInput): void {
    this.logEnterpriseEvent({
      event_type: 'license_validation',
      actor: 'system',
      resource: `license:${event.tier}`,
      action: event.feature ? `validate:${event.feature}` : 'validate',
      result: event.result,
      metadata: {
        licenseKeyHint: event.licenseKeyHint,
        tier: event.tier,
        feature: event.feature,
        expiresAt: event.expiresAt,
        seatsUsed: event.seatsUsed,
        seatsTotal: event.seatsTotal,
        ...event.metadata,
      },
    })
  }

  /**
   * Internal method to log enterprise events and buffer for export
   */
  private logEnterpriseEvent(
    entry: Omit<EnterpriseAuditLogEntry, 'id' | 'timestamp' | 'created_at'>
  ): void {
    // Use parent class log method for core event types
    // For enterprise types, we still store them but they'll be typed as 'config_change' in the DB
    const coreEventType = this.mapToCorEventType(entry.event_type)

    this.log({
      event_type: coreEventType,
      actor: entry.actor,
      resource: entry.resource,
      action: entry.action,
      result: entry.result,
      metadata: {
        ...entry.metadata,
        _enterpriseEventType: entry.event_type,
      },
    })

    // Add to buffer for export
    const timestamp = new Date().toISOString()
    this.eventBuffer.push({
      id: crypto.randomUUID(),
      event_type: entry.event_type,
      timestamp,
      actor: entry.actor,
      resource: entry.resource,
      action: entry.action,
      result: entry.result,
      metadata: entry.metadata ?? {},
      created_at: timestamp,
    })

    // Auto-flush if buffer is full
    if (this.eventBuffer.length >= (this.enterpriseConfig.exportBufferSize ?? 100)) {
      this.flush().catch(console.error)
    }
  }

  /**
   * Map enterprise event types to core event types for storage
   */
  private mapToCorEventType(
    eventType: ExtendedAuditEventType
  ): 'config_change' | 'security_scan' | 'url_fetch' | 'file_access' {
    switch (eventType) {
      case 'sso_login':
      case 'rbac_check':
        return 'security_scan'
      case 'license_validation':
      case 'exporter_registered':
      case 'exporter_unregistered':
      case 'export_completed':
      case 'export_failed':
        return 'config_change'
      default:
        return 'config_change'
    }
  }

  /**
   * Flush buffered events to all registered exporters
   *
   * @returns Promise that resolves when all exporters have completed
   */
  async flush(): Promise<void> {
    if (this.eventBuffer.length === 0 || this.exporters.length === 0) {
      return
    }

    const eventsToExport = [...this.eventBuffer]
    this.eventBuffer = []

    const results = await Promise.allSettled(
      this.exporters.map(async (exporter) => {
        try {
          await exporter.export(eventsToExport)
          return { exporter: exporter.name, success: true }
        } catch (error) {
          return { exporter: exporter.name, success: false, error }
        }
      })
    )

    // Log export results
    const successCount = results.filter((r) => r.status === 'fulfilled' && r.value.success).length
    const failCount = results.length - successCount

    if (failCount > 0) {
      this.log({
        event_type: 'config_change',
        actor: 'system',
        resource: 'audit_exporters',
        action: 'export_batch',
        result: 'warning',
        metadata: {
          eventsExported: eventsToExport.length,
          exportersSucceeded: successCount,
          exportersFailed: failCount,
        },
      })
    }
  }

  /**
   * Query enterprise audit logs with optional event type filter
   *
   * @param filter - Query filters
   * @returns Array of matching enterprise audit log entries
   */
  queryEnterprise(
    filter: AuditQueryFilter & { enterpriseEventType?: EnterpriseAuditEventType } = {}
  ): EnterpriseAuditLogEntry[] {
    const coreResults = this.query(filter)

    // Filter by enterprise event type if specified
    if (filter.enterpriseEventType) {
      return coreResults
        .filter((entry) => {
          const metadata = entry.metadata as Record<string, unknown> | undefined
          return metadata?.['_enterpriseEventType'] === filter.enterpriseEventType
        })
        .map((entry) => ({
          ...entry,
          event_type: ((entry.metadata as Record<string, unknown>)?.['_enterpriseEventType'] ??
            entry.event_type) as ExtendedAuditEventType,
        }))
    }

    return coreResults.map((entry) => ({
      ...entry,
      event_type: ((entry.metadata as Record<string, unknown>)?.['_enterpriseEventType'] ??
        entry.event_type) as ExtendedAuditEventType,
    }))
  }

  /**
   * Get retention configuration
   */
  getRetentionConfig(): {
    current: number
    min: number
    max: number
  } {
    return {
      current: this.enterpriseConfig.retentionDays ?? 90,
      min: this.enterpriseConfig.minRetentionDays ?? ENTERPRISE_MIN_RETENTION_DAYS,
      max: this.enterpriseConfig.maxRetentionDays ?? ENTERPRISE_MAX_RETENTION_DAYS,
    }
  }

  /**
   * Clean up resources (call when done with the logger)
   */
  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  /**
   * Get buffered events count (for testing/monitoring)
   */
  getBufferSize(): number {
    return this.eventBuffer.length
  }
}

// Re-export types from core for convenience
export type { AuditLogEntry, AuditActor, AuditResult, AuditQueryFilter, AuditLoggerConfig }
