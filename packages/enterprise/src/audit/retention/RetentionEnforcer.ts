/**
 * SMI-961: Retention Enforcer
 *
 * Enforces retention policies on audit logs with support for:
 * - Configurable retention periods (30-90 days)
 * - Scheduled cleanup jobs
 * - Archive before delete
 * - Per-event-type retention policies
 * - Legal hold compliance
 */

import type { AuditLogger, AuditEventType, AuditLogEntry } from '@skillsmith/core'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type {
  RetentionConfig,
  RetentionResult,
  RetentionAuditEvent,
  LegalHoldConfig,
  CleanupJobConfig,
} from './RetentionPolicy.js'
import { validateRetentionConfig, getRetentionDaysForEventType } from './RetentionPolicy.js'

/**
 * Extended AuditLogger interface for enterprise features
 */
export interface EnterpriseAuditLogger extends AuditLogger {
  query(filter: {
    event_type?: AuditEventType
    since?: Date
    until?: Date
    limit?: number
  }): AuditLogEntry[]
  cleanup(olderThan: Date): number
}

/**
 * Enforces retention policies on audit logs
 *
 * @example
 * ```typescript
 * const enforcer = new RetentionEnforcer({
 *   defaultDays: 90,
 *   archiveBeforeDelete: true,
 *   archivePath: './archives',
 *   perEventType: {
 *     'security_scan': 60,
 *     'config_change': 90,
 *   }
 * }, auditLogger);
 *
 * // Run enforcement
 * const result = await enforcer.enforce();
 *
 * // Enable legal hold
 * enforcer.setLegalHold(true);
 * ```
 */
export class RetentionEnforcer {
  private config: RetentionConfig
  private auditLogger: EnterpriseAuditLogger
  private legalHold: LegalHoldConfig
  private cleanupJob: CleanupJobConfig
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: RetentionConfig, auditLogger: EnterpriseAuditLogger) {
    validateRetentionConfig(config)
    this.config = config
    this.auditLogger = auditLogger
    this.legalHold = {
      enabled: config.legalHoldEnabled ?? false,
    }
    this.cleanupJob = {
      enabled: true,
      schedule: '0 2 * * *',
      batchSize: 10000,
      runOnStartup: false,
    }
  }

  /**
   * Get the current retention configuration
   */
  getConfig(): RetentionConfig {
    return { ...this.config }
  }

  /**
   * Update retention configuration
   *
   * @param updates - Partial configuration updates
   */
  updateConfig(updates: Partial<RetentionConfig>): void {
    const newConfig = { ...this.config, ...updates }
    validateRetentionConfig(newConfig)
    this.config = newConfig
  }

  /**
   * Set legal hold status
   *
   * @param enabled - Whether legal hold is enabled
   * @param reason - Optional reason for the legal hold
   */
  setLegalHold(enabled: boolean, reason?: string): void {
    this.legalHold = {
      enabled,
      ...(enabled && reason ? { reason } : {}),
      ...(enabled ? { activatedAt: new Date().toISOString() } : {}),
      ...(enabled ? { activatedBy: 'system' } : {}),
    }
  }

  /**
   * Check if legal hold is currently active
   */
  isLegalHoldActive(): boolean {
    return this.legalHold.enabled
  }

  /**
   * Get legal hold configuration
   */
  getLegalHoldConfig(): LegalHoldConfig {
    return { ...this.legalHold }
  }

  /**
   * Get expired events based on retention policy
   *
   * @param eventType - Optional filter by event type
   * @returns Array of expired audit events
   */
  async getExpiredEvents(eventType?: AuditEventType): Promise<RetentionAuditEvent[]> {
    const expiredEvents: RetentionAuditEvent[] = []
    const now = Date.now()

    // Get all event types to check
    const eventTypes: AuditEventType[] = eventType
      ? [eventType]
      : [
          'url_fetch',
          'file_access',
          'skill_install',
          'skill_uninstall',
          'security_scan',
          'cache_operation',
          'source_sync',
          'config_change',
        ]

    for (const type of eventTypes) {
      const retentionDays = getRetentionDaysForEventType(this.config, type)
      const cutoffDate = new Date(now - retentionDays * 24 * 60 * 60 * 1000)

      try {
        const events = this.auditLogger.query({
          event_type: type,
          until: cutoffDate,
          ...(this.cleanupJob.batchSize !== undefined ? { limit: this.cleanupJob.batchSize } : {}),
        })

        for (const event of events) {
          expiredEvents.push({
            ...event,
            actor: event.actor,
            metadata: event.metadata,
          } as RetentionAuditEvent)
        }
      } catch (error) {
        // Continue with other event types if one fails
        console.error(`Failed to query expired events for ${type}:`, error)
      }
    }

    return expiredEvents
  }

  /**
   * Archive events to the configured archive path
   *
   * @param events - Events to archive
   */
  async archive(events: RetentionAuditEvent[]): Promise<void> {
    if (!this.config.archivePath) {
      throw new Error('Archive path not configured')
    }

    if (events.length === 0) {
      return
    }

    // Ensure archive directory exists
    const archiveDir = this.config.archivePath
    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true })
    }

    // Create archive file with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const archiveFile = join(archiveDir, `audit-archive-${timestamp}.json`)

    // Write events to archive file
    const archiveData = {
      archivedAt: new Date().toISOString(),
      eventCount: events.length,
      events: events,
    }

    writeFileSync(archiveFile, JSON.stringify(archiveData, null, 2), 'utf-8')
  }

  /**
   * Enforce retention policy
   *
   * @returns Result of the enforcement operation
   */
  async enforce(): Promise<RetentionResult> {
    const startTime = Date.now()
    const result: RetentionResult = {
      success: true,
      processedCount: 0,
      deletedCount: 0,
      archivedCount: 0,
      skippedCount: 0,
      executedAt: new Date().toISOString(),
      durationMs: 0,
    }

    try {
      // Check for legal hold
      if (this.legalHold.enabled) {
        result.success = true
        result.skippedCount = 0
        result.error = 'Legal hold is active - no events deleted'
        result.durationMs = Date.now() - startTime
        return result
      }

      // Get all expired events
      const expiredEvents = await this.getExpiredEvents()
      result.processedCount = expiredEvents.length

      if (expiredEvents.length === 0) {
        result.durationMs = Date.now() - startTime
        return result
      }

      // Archive if configured
      if (this.config.archiveBeforeDelete) {
        await this.archive(expiredEvents)
        result.archivedCount = expiredEvents.length
        result.archivedEvents = expiredEvents
      }

      // Delete expired events by event type
      const eventTypeGroups = this.groupEventsByType(expiredEvents)

      for (const [eventType, _events] of Object.entries(eventTypeGroups)) {
        const retentionDays = getRetentionDaysForEventType(this.config, eventType as AuditEventType)
        const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)

        try {
          const deleted = this.auditLogger.cleanup(cutoffDate)
          result.deletedCount += deleted
        } catch (error) {
          console.error(`Failed to cleanup events for ${eventType}:`, error)
        }
      }

      result.durationMs = Date.now() - startTime
      return result
    } catch (error) {
      result.success = false
      result.error = error instanceof Error ? error.message : 'Unknown error'
      result.durationMs = Date.now() - startTime
      return result
    }
  }

  /**
   * Group events by their event type
   */
  private groupEventsByType(events: RetentionAuditEvent[]): Record<string, RetentionAuditEvent[]> {
    return events.reduce(
      (groups, event) => {
        const type = event.event_type
        if (!groups[type]) {
          groups[type] = []
        }
        groups[type].push(event)
        return groups
      },
      {} as Record<string, RetentionAuditEvent[]>
    )
  }

  /**
   * Configure the scheduled cleanup job
   *
   * @param config - Cleanup job configuration
   */
  configureCleanupJob(config: Partial<CleanupJobConfig>): void {
    this.cleanupJob = { ...this.cleanupJob, ...config }

    // Restart the job if it's running
    if (this.cleanupInterval) {
      this.stopCleanupJob()
      if (this.cleanupJob.enabled) {
        this.startCleanupJob()
      }
    }
  }

  /**
   * Start the scheduled cleanup job
   *
   * @param intervalMs - Interval in milliseconds (default: 24 hours)
   */
  startCleanupJob(intervalMs: number = 24 * 60 * 60 * 1000): void {
    if (this.cleanupInterval) {
      return // Already running
    }

    // Run immediately if configured
    if (this.cleanupJob.runOnStartup) {
      this.enforce().catch(console.error)
    }

    // Schedule periodic cleanup
    this.cleanupInterval = setInterval(async () => {
      if (this.cleanupJob.enabled && !this.legalHold.enabled) {
        try {
          await this.enforce()
        } catch (error) {
          console.error('Scheduled cleanup failed:', error)
        }
      }
    }, intervalMs)
  }

  /**
   * Stop the scheduled cleanup job
   */
  stopCleanupJob(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }

  /**
   * Check if cleanup job is running
   */
  isCleanupJobRunning(): boolean {
    return this.cleanupInterval !== null
  }

  /**
   * Get cleanup job configuration
   */
  getCleanupJobConfig(): CleanupJobConfig {
    return { ...this.cleanupJob }
  }

  /**
   * Get retention statistics
   */
  async getRetentionStats(): Promise<{
    totalEvents: number
    expiredEventsByType: Record<string, number>
    legalHoldActive: boolean
    nextCleanupAt?: string
  }> {
    const expiredEvents = await this.getExpiredEvents()
    const expiredByType: Record<string, number> = {}

    for (const event of expiredEvents) {
      expiredByType[event.event_type] = (expiredByType[event.event_type] || 0) + 1
    }

    return {
      totalEvents: expiredEvents.length,
      expiredEventsByType: expiredByType,
      legalHoldActive: this.legalHold.enabled,
    }
  }
}
