/**
 * SMI-957: Enterprise Audit Logger Tests — flush, buffer, query, dispose, retention, mapping, integration
 *
 * Companion to AuditLogger.test.ts (split at 500-line limit per CLAUDE.md).
 * Covers: flush, auto-flush, queryEnterprise, dispose, getBufferSize,
 *         retention policy, event type mapping, and integration tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EnterpriseAuditLogger } from '../src/audit/AuditLogger.js'
import type { AuditExporter, AuditEvent } from '../src/audit/AuditLogger.js'
import { createDatabaseAsync, initializeSchema, closeDatabase } from '@skillsmith/core'
import type { Database as DatabaseType } from '@skillsmith/core'

/**
 * Fixed timestamp for deterministic testing
 */
const FIXED_TIMESTAMP = 1705312800000 // January 15, 2024 at 10:00 UTC
const FIXED_DATE = new Date(FIXED_TIMESTAMP)

function setupFakeTimers(): void {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_DATE)
}

function cleanupFakeTimers(): void {
  vi.useRealTimers()
}

describe('EnterpriseAuditLogger — flush & beyond', () => {
  let db: DatabaseType
  let logger: EnterpriseAuditLogger

  beforeEach(async () => {
    setupFakeTimers()
    db = await createDatabaseAsync(':memory:')
    initializeSchema(db)
    logger = new EnterpriseAuditLogger(db)
  })

  afterEach(() => {
    logger.dispose()
    closeDatabase(db)
    cleanupFakeTimers()
  })

  describe('flush', () => {
    it('should flush events to all exporters', async () => {
      const exportedEvents: AuditEvent[] = []
      const mockExporter: AuditExporter = {
        name: 'capture-exporter',
        export: vi.fn().mockImplementation((events) => {
          exportedEvents.push(...events)
          return Promise.resolve()
        }),
      }

      logger.registerExporter(mockExporter)

      logger.logSSOEvent({
        provider: 'okta',
        userId: 'user@example.com',
        result: 'success',
      })

      await logger.flush()

      expect(exportedEvents.length).toBeGreaterThan(0)
      expect(mockExporter.export).toHaveBeenCalled()
    })

    it('should clear buffer after flush', async () => {
      const mockExporter: AuditExporter = {
        name: 'buffer-test',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(mockExporter)

      logger.logSSOEvent({
        provider: 'test',
        userId: 'user@test.com',
        result: 'success',
      })

      expect(logger.getBufferSize()).toBeGreaterThan(0)

      await logger.flush()

      expect(logger.getBufferSize()).toBe(0)
    })

    it('should do nothing when buffer is empty', async () => {
      const mockExporter: AuditExporter = {
        name: 'empty-test',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(mockExporter)

      await logger.flush()

      expect(mockExporter.export).not.toHaveBeenCalled()
    })

    it('should do nothing when no exporters registered', async () => {
      logger.logSSOEvent({
        provider: 'test',
        userId: 'user@test.com',
        result: 'success',
      })

      // Should not throw
      await logger.flush()
    })

    it('should handle exporter errors gracefully', async () => {
      const failingExporter: AuditExporter = {
        name: 'failing-exporter',
        export: vi.fn().mockRejectedValue(new Error('Export failed')),
      }

      const successExporter: AuditExporter = {
        name: 'success-exporter',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(failingExporter)
      logger.registerExporter(successExporter)

      logger.logSSOEvent({
        provider: 'test',
        userId: 'user@test.com',
        result: 'success',
      })

      // Should not throw
      await logger.flush()

      // Both exporters should have been called
      expect(failingExporter.export).toHaveBeenCalled()
      expect(successExporter.export).toHaveBeenCalled()
    })

    it('should export to multiple exporters in parallel', async () => {
      const exporter1: AuditExporter = {
        name: 'exporter-1',
        export: vi.fn().mockResolvedValue(undefined),
      }

      const exporter2: AuditExporter = {
        name: 'exporter-2',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(exporter1)
      logger.registerExporter(exporter2)

      logger.logSSOEvent({
        provider: 'test',
        userId: 'user@test.com',
        result: 'success',
      })

      await logger.flush()

      expect(exporter1.export).toHaveBeenCalled()
      expect(exporter2.export).toHaveBeenCalled()
    })
  })

  describe('auto-flush on buffer full', () => {
    it('should auto-flush when buffer reaches limit', async () => {
      // Use real timers for this test since auto-flush uses async operations
      cleanupFakeTimers()

      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)
      const testLogger = new EnterpriseAuditLogger(testDb, {
        exportBufferSize: 3,
      })

      const mockExporter: AuditExporter = {
        name: 'auto-flush-test',
        export: vi.fn().mockResolvedValue(undefined),
      }

      testLogger.registerExporter(mockExporter)

      // Log events to trigger auto-flush (buffer size is 3, so 4th event triggers flush)
      for (let i = 0; i < 4; i++) {
        testLogger.logSSOEvent({
          provider: 'test',
          userId: `user${i}@test.com`,
          result: 'success',
        })
      }

      // Wait for async flush with real timer
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(mockExporter.export).toHaveBeenCalled()

      testLogger.dispose()
      closeDatabase(testDb)

      // Restore fake timers
      setupFakeTimers()
    })
  })

  describe('queryEnterprise', () => {
    beforeEach(() => {
      // Add various event types
      logger.logSSOEvent({
        provider: 'okta',
        userId: 'sso@example.com',
        result: 'success',
      })

      logger.logRBACEvent({
        principal: 'rbac@example.com',
        principalType: 'user',
        resource: '/api/test',
        permission: 'read',
        result: 'success',
      })

      logger.logLicenseEvent({
        licenseKeyHint: '****test',
        tier: 'enterprise',
        result: 'success',
      })
    })

    it('should query all enterprise events', () => {
      const logs = logger.queryEnterprise()
      expect(logs.length).toBeGreaterThanOrEqual(3)
    })

    it('should filter by enterprise event type', () => {
      const ssoLogs = logger.queryEnterprise({ enterpriseEventType: 'sso_login' })
      expect(ssoLogs.length).toBeGreaterThan(0)
      expect(ssoLogs.every((l) => l.event_type === 'sso_login')).toBe(true)

      const rbacLogs = logger.queryEnterprise({ enterpriseEventType: 'rbac_check' })
      expect(rbacLogs.length).toBeGreaterThan(0)
      expect(rbacLogs.every((l) => l.event_type === 'rbac_check')).toBe(true)

      const licenseLogs = logger.queryEnterprise({ enterpriseEventType: 'license_validation' })
      expect(licenseLogs.length).toBeGreaterThan(0)
      expect(licenseLogs.every((l) => l.event_type === 'license_validation')).toBe(true)
    })

    it('should support standard query filters', () => {
      const logs = logger.queryEnterprise({ result: 'success', limit: 10 })
      expect(logs.every((l) => l.result === 'success')).toBe(true)
    })
  })

  describe('dispose', () => {
    it('should clean up resources', async () => {
      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)
      const testLogger = new EnterpriseAuditLogger(testDb, {
        autoFlushInterval: 1000,
      })

      // Should not throw
      testLogger.dispose()
      testLogger.dispose() // Second call should be safe

      closeDatabase(testDb)
    })
  })

  describe('getBufferSize', () => {
    it('should return current buffer size', () => {
      expect(logger.getBufferSize()).toBe(0)

      logger.logSSOEvent({
        provider: 'test',
        userId: 'user@test.com',
        result: 'success',
      })

      expect(logger.getBufferSize()).toBe(1)
    })
  })

  describe('retention policy', () => {
    it('should enforce minimum retention of 30 days', async () => {
      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)

      // Try to set retention below minimum
      const testLogger = new EnterpriseAuditLogger(testDb, {
        retentionDays: 15, // Below 30-day minimum
      })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(30) // Should be clamped to minimum

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should enforce maximum retention of 90 days', async () => {
      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)

      // Try to set retention above maximum
      const testLogger = new EnterpriseAuditLogger(testDb, {
        retentionDays: 180, // Above 90-day maximum
      })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(90) // Should be clamped to maximum

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should allow custom retention within bounds', async () => {
      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)

      const testLogger = new EnterpriseAuditLogger(testDb, {
        retentionDays: 45, // Within bounds
      })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(45)

      testLogger.dispose()
      closeDatabase(testDb)
    })
  })

  describe('event type mapping', () => {
    it('should map sso_login to security_scan in database', () => {
      logger.logSSOEvent({
        provider: 'test',
        userId: 'user@test.com',
        result: 'success',
      })

      // Query using core method to see actual stored type
      const coreLogs = logger.query({ event_type: 'security_scan' })
      const ssoLog = coreLogs.find(
        (l) => (l.metadata as Record<string, unknown>)?.['_enterpriseEventType'] === 'sso_login'
      )
      expect(ssoLog).toBeDefined()
    })

    it('should map rbac_check to security_scan in database', () => {
      logger.logRBACEvent({
        principal: 'test@test.com',
        principalType: 'user',
        resource: '/api/test',
        permission: 'read',
        result: 'success',
      })

      const coreLogs = logger.query({ event_type: 'security_scan' })
      const rbacLog = coreLogs.find(
        (l) => (l.metadata as Record<string, unknown>)?.['_enterpriseEventType'] === 'rbac_check'
      )
      expect(rbacLog).toBeDefined()
    })

    it('should map license_validation to config_change in database', () => {
      logger.logLicenseEvent({
        licenseKeyHint: '****test',
        tier: 'enterprise',
        result: 'success',
      })

      const coreLogs = logger.query({ event_type: 'config_change' })
      const licenseLog = coreLogs.find(
        (l) =>
          (l.metadata as Record<string, unknown>)?.['_enterpriseEventType'] === 'license_validation'
      )
      expect(licenseLog).toBeDefined()
    })
  })

  describe('integration tests', () => {
    it('should handle complex workflow', async () => {
      // Setup exporters
      const splunkEvents: AuditEvent[] = []
      const datadogEvents: AuditEvent[] = []

      const splunkExporter: AuditExporter = {
        name: 'splunk',
        export: async (events) => {
          splunkEvents.push(...events)
        },
      }

      const datadogExporter: AuditExporter = {
        name: 'datadog',
        export: async (events) => {
          datadogEvents.push(...events)
        },
      }

      logger.registerExporter(splunkExporter)
      logger.registerExporter(datadogExporter)

      // Simulate enterprise workflow
      // 1. User logs in via SSO
      logger.logSSOEvent({
        provider: 'okta',
        userId: 'admin@enterprise.com',
        result: 'success',
        sessionId: 'sess_admin123',
      })

      // 2. System checks RBAC for admin action
      logger.logRBACEvent({
        principal: 'admin@enterprise.com',
        principalType: 'user',
        resource: '/api/admin/settings',
        permission: 'write',
        roles: ['admin', 'superuser'],
        result: 'success',
      })

      // 3. License is validated for enterprise feature
      logger.logLicenseEvent({
        licenseKeyHint: '****ent1',
        tier: 'enterprise',
        feature: 'audit_export',
        result: 'success',
        expiresAt: '2025-12-31T23:59:59Z',
      })

      // Flush to exporters
      await logger.flush()

      // Verify export
      expect(splunkEvents.length).toBe(3)
      expect(datadogEvents.length).toBe(3)

      // Verify event order and types
      expect(splunkEvents[0]!.event_type).toBe('sso_login')
      expect(splunkEvents[1]!.event_type).toBe('rbac_check')
      expect(splunkEvents[2]!.event_type).toBe('license_validation')

      // Query enterprise logs
      const allLogs = logger.queryEnterprise()
      expect(allLogs.length).toBeGreaterThanOrEqual(3)
    })

    it('should persist events across flush cycles', async () => {
      const mockExporter: AuditExporter = {
        name: 'persistence-test',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(mockExporter)

      // First batch
      logger.logSSOEvent({
        provider: 'test1',
        userId: 'user1@test.com',
        result: 'success',
      })
      await logger.flush()

      // Second batch
      logger.logSSOEvent({
        provider: 'test2',
        userId: 'user2@test.com',
        result: 'success',
      })
      await logger.flush()

      // All events should be in database
      const logs = logger.queryEnterprise({ enterpriseEventType: 'sso_login' })
      expect(logs.length).toBeGreaterThanOrEqual(2)

      // Exporter should have been called twice
      expect(mockExporter.export).toHaveBeenCalledTimes(2)
    })
  })
})
