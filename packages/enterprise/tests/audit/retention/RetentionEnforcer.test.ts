/**
 * SMI-961: Retention Enforcer Tests
 *
 * Tests for configurable retention policies including:
 * - Configurable retention period (30-90 days)
 * - Scheduled cleanup job
 * - Archive before delete option
 * - Retention policy per event type
 * - Compliance-aware (no delete during legal hold)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { AuditEventType, AuditLogEntry } from '@skillsmith/core'
import {
  RetentionEnforcer,
  validateRetentionConfig,
  createDefaultRetentionConfig,
  getRetentionDaysForEventType,
  ENTERPRISE_MIN_RETENTION_DAYS,
  ENTERPRISE_MAX_RETENTION_DAYS,
  DEFAULT_RETENTION_DAYS,
} from '../../../src/audit/retention/index.js'
import type {
  RetentionConfig,
  RetentionAuditEvent,
  EnterpriseAuditLogger,
} from '../../../src/audit/retention/index.js'

/**
 * Mock AuditLogger for testing
 */
class MockAuditLogger implements EnterpriseAuditLogger {
  private events: AuditLogEntry[] = []
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
    this.ensureTableExists()
  }

  private ensureTableExists(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT,
        resource TEXT,
        action TEXT,
        result TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
    `)
  }

  log(entry: Omit<AuditLogEntry, 'id' | 'created_at'> & { timestamp?: string }): void {
    const id = crypto.randomUUID()
    const timestamp = entry.timestamp || new Date().toISOString()
    const created_at = new Date().toISOString()
    const metadata = entry.metadata ? JSON.stringify(entry.metadata) : null

    this.db
      .prepare(
        `
      INSERT INTO audit_logs (id, event_type, timestamp, actor, resource, action, result, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        entry.event_type,
        timestamp,
        entry.actor,
        entry.resource,
        entry.action,
        entry.result,
        metadata,
        created_at
      )
  }

  query(filter: {
    event_type?: AuditEventType
    since?: Date
    until?: Date
    limit?: number
  }): AuditLogEntry[] {
    let sql = 'SELECT * FROM audit_logs WHERE 1=1'
    const params: unknown[] = []

    if (filter.event_type) {
      sql += ' AND event_type = ?'
      params.push(filter.event_type)
    }
    if (filter.since) {
      sql += ' AND timestamp >= ?'
      params.push(filter.since.toISOString())
    }
    if (filter.until) {
      sql += ' AND timestamp <= ?'
      params.push(filter.until.toISOString())
    }

    sql += ' ORDER BY timestamp DESC'

    if (filter.limit) {
      sql += ' LIMIT ?'
      params.push(filter.limit)
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      event_type: AuditEventType
      timestamp: string
      actor: string
      resource: string
      action: string
      result: string
      metadata: string | null
      created_at: string
    }>

    return rows.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }))
  }

  cleanup(olderThan: Date): number {
    const result = this.db
      .prepare('DELETE FROM audit_logs WHERE timestamp < ?')
      .run(olderThan.toISOString())
    return result.changes
  }

  cleanupOldLogs(retentionDays: number = 90): number {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    return this.cleanup(cutoffDate)
  }

  getStats() {
    return {
      total_events: 0,
      events_by_type: {} as Record<AuditEventType, number>,
      events_by_result: {} as Record<string, number>,
      blocked_events: 0,
      error_events: 0,
      oldest_event: null,
      newest_event: null,
    }
  }

  export() {
    return '[]'
  }
}

describe('RetentionPolicy', () => {
  describe('validateRetentionConfig', () => {
    it('should accept valid configuration with 90 days', () => {
      const config: RetentionConfig = {
        defaultDays: 90,
        archiveBeforeDelete: false,
      }
      expect(() => validateRetentionConfig(config)).not.toThrow()
    })

    it('should accept valid configuration with 30 days', () => {
      const config: RetentionConfig = {
        defaultDays: 30,
        archiveBeforeDelete: false,
      }
      expect(() => validateRetentionConfig(config)).not.toThrow()
    })

    it('should accept valid configuration with per-event-type retention', () => {
      const config: RetentionConfig = {
        defaultDays: 90,
        perEventType: {
          security_scan: 60,
          config_change: 90,
        },
        archiveBeforeDelete: false,
      }
      expect(() => validateRetentionConfig(config)).not.toThrow()
    })

    it('should reject defaultDays below minimum (30)', () => {
      const config: RetentionConfig = {
        defaultDays: 29,
        archiveBeforeDelete: false,
      }
      expect(() => validateRetentionConfig(config)).toThrow(/minimum is 30 days/)
    })

    it('should reject defaultDays above maximum (90)', () => {
      const config: RetentionConfig = {
        defaultDays: 91,
        archiveBeforeDelete: false,
      }
      expect(() => validateRetentionConfig(config)).toThrow(/maximum is 90 days/)
    })

    it('should reject non-integer defaultDays', () => {
      const config: RetentionConfig = {
        defaultDays: 45.5,
        archiveBeforeDelete: false,
      }
      expect(() => validateRetentionConfig(config)).toThrow('must be an integer')
    })

    it('should reject per-event-type retention below minimum', () => {
      const config: RetentionConfig = {
        defaultDays: 90,
        perEventType: {
          security_scan: 20,
        },
        archiveBeforeDelete: false,
      }
      expect(() => validateRetentionConfig(config)).toThrow(/minimum is 30 days/)
    })

    it('should reject archiveBeforeDelete without archivePath', () => {
      const config: RetentionConfig = {
        defaultDays: 90,
        archiveBeforeDelete: true,
      }
      expect(() => validateRetentionConfig(config)).toThrow(
        'archivePath is required when archiveBeforeDelete is enabled'
      )
    })

    it('should accept archiveBeforeDelete with archivePath', () => {
      const config: RetentionConfig = {
        defaultDays: 90,
        archiveBeforeDelete: true,
        archivePath: '/tmp/archives',
      }
      expect(() => validateRetentionConfig(config)).not.toThrow()
    })
  })

  describe('createDefaultRetentionConfig', () => {
    it('should create config with 90 day default', () => {
      const config = createDefaultRetentionConfig()
      expect(config.defaultDays).toBe(DEFAULT_RETENTION_DAYS)
      expect(config.archiveBeforeDelete).toBe(false)
      expect(config.legalHoldEnabled).toBe(false)
    })
  })

  describe('getRetentionDaysForEventType', () => {
    it('should return default days when no per-event-type config', () => {
      const config: RetentionConfig = {
        defaultDays: 90,
        archiveBeforeDelete: false,
      }
      expect(getRetentionDaysForEventType(config, 'security_scan')).toBe(90)
    })

    it('should return per-event-type days when configured', () => {
      const config: RetentionConfig = {
        defaultDays: 90,
        perEventType: {
          security_scan: 60,
        },
        archiveBeforeDelete: false,
      }
      expect(getRetentionDaysForEventType(config, 'security_scan')).toBe(60)
      expect(getRetentionDaysForEventType(config, 'config_change')).toBe(90)
    })
  })
})

describe('RetentionEnforcer', () => {
  let db: Database.Database
  let auditLogger: MockAuditLogger
  let archivePath: string

  beforeEach(() => {
    db = new Database(':memory:')
    auditLogger = new MockAuditLogger(db)
    archivePath = join(tmpdir(), 'audit-archive-test-' + Date.now())
  })

  afterEach(() => {
    db.close()
    if (existsSync(archivePath)) {
      rmSync(archivePath, { recursive: true })
    }
  })

  describe('constructor', () => {
    it('should create enforcer with valid config', () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 90, archiveBeforeDelete: false },
        auditLogger
      )
      expect(enforcer).toBeDefined()
      expect(enforcer.getConfig().defaultDays).toBe(90)
    })

    it('should throw on invalid config', () => {
      expect(() => {
        new RetentionEnforcer({ defaultDays: 10, archiveBeforeDelete: false }, auditLogger)
      }).toThrow()
    })
  })

  describe('setLegalHold', () => {
    it('should enable legal hold', () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 90, archiveBeforeDelete: false },
        auditLogger
      )
      expect(enforcer.isLegalHoldActive()).toBe(false)

      enforcer.setLegalHold(true, 'Litigation pending')

      expect(enforcer.isLegalHoldActive()).toBe(true)
      const holdConfig = enforcer.getLegalHoldConfig()
      expect(holdConfig.enabled).toBe(true)
      expect(holdConfig.reason).toBe('Litigation pending')
      expect(holdConfig.activatedAt).toBeDefined()
    })

    it('should disable legal hold', () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 90, archiveBeforeDelete: false },
        auditLogger
      )
      enforcer.setLegalHold(true, 'Litigation pending')
      enforcer.setLegalHold(false)

      expect(enforcer.isLegalHoldActive()).toBe(false)
      const holdConfig = enforcer.getLegalHoldConfig()
      expect(holdConfig.enabled).toBe(false)
      expect(holdConfig.reason).toBeUndefined()
    })
  })

  describe('enforce', () => {
    it('should not delete events when legal hold is active', async () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 30, archiveBeforeDelete: false },
        auditLogger
      )

      // Add an old event
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) // 60 days ago
      auditLogger.log({
        event_type: 'security_scan',
        timestamp: oldDate.toISOString(),
        actor: 'system',
        resource: '/test',
        action: 'scan',
        result: 'success',
      })

      // Enable legal hold
      enforcer.setLegalHold(true, 'Litigation')

      const result = await enforcer.enforce()

      expect(result.success).toBe(true)
      expect(result.deletedCount).toBe(0)
      expect(result.error).toContain('Legal hold is active')
    })

    it('should delete expired events', async () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 30, archiveBeforeDelete: false },
        auditLogger
      )

      // Add an old event (60 days ago)
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      auditLogger.log({
        event_type: 'security_scan',
        timestamp: oldDate.toISOString(),
        actor: 'system',
        resource: '/test',
        action: 'scan',
        result: 'success',
      })

      // Add a recent event
      auditLogger.log({
        event_type: 'security_scan',
        actor: 'system',
        resource: '/test2',
        action: 'scan',
        result: 'success',
      })

      const result = await enforcer.enforce()

      expect(result.success).toBe(true)
      expect(result.deletedCount).toBeGreaterThanOrEqual(1)
    })

    it('should archive events before deletion when configured', async () => {
      const enforcer = new RetentionEnforcer(
        {
          defaultDays: 30,
          archiveBeforeDelete: true,
          archivePath,
        },
        auditLogger
      )

      // Add an old event
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      auditLogger.log({
        event_type: 'security_scan',
        timestamp: oldDate.toISOString(),
        actor: 'system',
        resource: '/test',
        action: 'scan',
        result: 'success',
      })

      const result = await enforcer.enforce()

      expect(result.success).toBe(true)
      expect(result.archivedCount).toBeGreaterThanOrEqual(1)

      // Check archive file was created
      expect(existsSync(archivePath)).toBe(true)
    })

    it('should respect per-event-type retention', async () => {
      const enforcer = new RetentionEnforcer(
        {
          defaultDays: 90,
          perEventType: {
            security_scan: 30, // Shorter retention for security scans
          },
          archiveBeforeDelete: false,
        },
        auditLogger
      )

      // Add a security_scan event from 45 days ago (should be deleted with 30-day policy)
      const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)
      auditLogger.log({
        event_type: 'security_scan',
        timestamp: oldDate.toISOString(),
        actor: 'system',
        resource: '/test',
        action: 'scan',
        result: 'success',
      })

      // Add a config_change event from 45 days ago (should NOT be deleted with 90-day default)
      auditLogger.log({
        event_type: 'config_change',
        timestamp: oldDate.toISOString(),
        actor: 'user',
        resource: '/config',
        action: 'update',
        result: 'success',
      })

      const expired = await enforcer.getExpiredEvents()

      // Only security_scan should be expired
      const securityExpired = expired.filter((e) => e.event_type === 'security_scan')
      const configExpired = expired.filter((e) => e.event_type === 'config_change')

      expect(securityExpired.length).toBeGreaterThanOrEqual(1)
      expect(configExpired.length).toBe(0)
    })
  })

  describe('getExpiredEvents', () => {
    it('should return events older than retention period', async () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 30, archiveBeforeDelete: false },
        auditLogger
      )

      // Add old event
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      auditLogger.log({
        event_type: 'security_scan',
        timestamp: oldDate.toISOString(),
        actor: 'system',
        resource: '/test',
        action: 'scan',
        result: 'success',
      })

      const expired = await enforcer.getExpiredEvents()
      expect(expired.length).toBeGreaterThanOrEqual(1)
    })

    it('should filter by event type', async () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 30, archiveBeforeDelete: false },
        auditLogger
      )

      // Add old events of different types
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      auditLogger.log({
        event_type: 'security_scan',
        timestamp: oldDate.toISOString(),
        actor: 'system',
        resource: '/test',
        action: 'scan',
        result: 'success',
      })
      auditLogger.log({
        event_type: 'config_change',
        timestamp: oldDate.toISOString(),
        actor: 'user',
        resource: '/config',
        action: 'update',
        result: 'success',
      })

      const expired = await enforcer.getExpiredEvents('security_scan')
      expect(expired.every((e) => e.event_type === 'security_scan')).toBe(true)
    })
  })

  describe('archive', () => {
    it('should create archive file with events', async () => {
      const enforcer = new RetentionEnforcer(
        {
          defaultDays: 90,
          archiveBeforeDelete: true,
          archivePath,
        },
        auditLogger
      )

      const events: RetentionAuditEvent[] = [
        {
          id: 'test-1',
          event_type: 'security_scan' as AuditEventType,
          timestamp: new Date().toISOString(),
          actor: 'system',
          resource: '/test',
          action: 'scan',
          result: 'success',
          created_at: new Date().toISOString(),
        },
      ]

      await enforcer.archive(events)

      expect(existsSync(archivePath)).toBe(true)

      // Read archive contents
      const files = readdirSync(archivePath)
      expect(files.length).toBe(1)

      const archiveContent = JSON.parse(readFileSync(join(archivePath, files[0]), 'utf-8'))
      expect(archiveContent.eventCount).toBe(1)
      expect(archiveContent.events[0].id).toBe('test-1')
    })

    it('should throw error if archivePath not configured', async () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 90, archiveBeforeDelete: false },
        auditLogger
      )

      await expect(enforcer.archive([])).rejects.toThrow('Archive path not configured')
    })
  })

  describe('cleanup job', () => {
    it('should start and stop cleanup job', () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 90, archiveBeforeDelete: false },
        auditLogger
      )

      expect(enforcer.isCleanupJobRunning()).toBe(false)

      enforcer.startCleanupJob(60000) // 1 minute interval for testing
      expect(enforcer.isCleanupJobRunning()).toBe(true)

      enforcer.stopCleanupJob()
      expect(enforcer.isCleanupJobRunning()).toBe(false)
    })

    it('should configure cleanup job', () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 90, archiveBeforeDelete: false },
        auditLogger
      )

      enforcer.configureCleanupJob({
        enabled: true,
        batchSize: 5000,
        runOnStartup: true,
      })

      const config = enforcer.getCleanupJobConfig()
      expect(config.enabled).toBe(true)
      expect(config.batchSize).toBe(5000)
      expect(config.runOnStartup).toBe(true)
    })
  })

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 90, archiveBeforeDelete: false },
        auditLogger
      )

      enforcer.updateConfig({ defaultDays: 60 })
      expect(enforcer.getConfig().defaultDays).toBe(60)
    })

    it('should validate new configuration', () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 90, archiveBeforeDelete: false },
        auditLogger
      )

      expect(() => enforcer.updateConfig({ defaultDays: 10 })).toThrow()
    })
  })

  describe('getRetentionStats', () => {
    it('should return retention statistics', async () => {
      const enforcer = new RetentionEnforcer(
        { defaultDays: 30, archiveBeforeDelete: false },
        auditLogger
      )

      // Add some old events
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      auditLogger.log({
        event_type: 'security_scan',
        timestamp: oldDate.toISOString(),
        actor: 'system',
        resource: '/test',
        action: 'scan',
        result: 'success',
      })

      const stats = await enforcer.getRetentionStats()

      expect(stats.totalEvents).toBeGreaterThanOrEqual(1)
      expect(stats.legalHoldActive).toBe(false)
      expect(stats.expiredEventsByType).toBeDefined()
    })
  })
})

describe('Constants', () => {
  it('should have correct min retention days', () => {
    expect(ENTERPRISE_MIN_RETENTION_DAYS).toBe(30)
  })

  it('should have correct max retention days', () => {
    expect(ENTERPRISE_MAX_RETENTION_DAYS).toBe(90)
  })

  it('should have correct default retention days', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90)
  })
})
