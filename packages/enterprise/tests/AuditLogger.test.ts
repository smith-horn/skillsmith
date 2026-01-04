/**
 * SMI-957: Enterprise Audit Logger Tests
 *
 * Comprehensive test suite for the enterprise audit logging system
 * Target: 90%+ coverage
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  EnterpriseAuditLogger,
  ENTERPRISE_MIN_RETENTION_DAYS,
  ENTERPRISE_MAX_RETENTION_DAYS,
} from '../src/audit/AuditLogger.js'
import type {
  AuditExporter,
  AuditEvent,
  SSOLoginInput,
  RBACCheckInput,
  LicenseCheckInput,
} from '../src/audit/AuditLogger.js'
import { createDatabase, closeDatabase } from '@skillsmith/core'
import type { Database as DatabaseType } from 'better-sqlite3'

/**
 * Fixed timestamp for deterministic testing
 */
const FIXED_TIMESTAMP = 1705312800000 // January 15, 2024 at 10:00 UTC
const FIXED_DATE = new Date(FIXED_TIMESTAMP)
const ONE_DAY_MS = 24 * 60 * 60 * 1000

function setupFakeTimers(): void {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_DATE)
}

function cleanupFakeTimers(): void {
  vi.useRealTimers()
}

describe('EnterpriseAuditLogger', () => {
  let db: DatabaseType
  let logger: EnterpriseAuditLogger

  beforeEach(() => {
    setupFakeTimers()
    db = createDatabase(':memory:')
    logger = new EnterpriseAuditLogger(db)
  })

  afterEach(() => {
    logger.dispose()
    closeDatabase(db)
    cleanupFakeTimers()
  })

  describe('constructor', () => {
    it('should create logger with default configuration', () => {
      const config = logger.getRetentionConfig()
      expect(config.min).toBe(ENTERPRISE_MIN_RETENTION_DAYS)
      expect(config.max).toBe(ENTERPRISE_MAX_RETENTION_DAYS)
      expect(config.current).toBe(90) // Default retention
    })

    it('should constrain retention to minimum enterprise limit', () => {
      const testDb = createDatabase(':memory:')
      const testLogger = new EnterpriseAuditLogger(testDb, { retentionDays: 10 })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(ENTERPRISE_MIN_RETENTION_DAYS)

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should constrain retention to maximum enterprise limit', () => {
      const testDb = createDatabase(':memory:')
      const testLogger = new EnterpriseAuditLogger(testDb, { retentionDays: 365 })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(ENTERPRISE_MAX_RETENTION_DAYS)

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should accept retention within enterprise limits', () => {
      const testDb = createDatabase(':memory:')
      const testLogger = new EnterpriseAuditLogger(testDb, { retentionDays: 60 })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(60)

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should support custom min/max retention limits', () => {
      const testDb = createDatabase(':memory:')
      const testLogger = new EnterpriseAuditLogger(testDb, {
        minRetentionDays: 45,
        maxRetentionDays: 75,
        retentionDays: 50,
      })

      const config = testLogger.getRetentionConfig()
      expect(config.min).toBe(45)
      expect(config.max).toBe(75)
      expect(config.current).toBe(50)

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should setup auto-flush timer when configured', () => {
      const testDb = createDatabase(':memory:')
      const testLogger = new EnterpriseAuditLogger(testDb, {
        autoFlushInterval: 5000,
      })

      // Verify timer was set up (dispose clears it)
      testLogger.dispose()
      closeDatabase(testDb)
    })
  })

  describe('exporter registration', () => {
    it('should register an exporter', () => {
      const mockExporter: AuditExporter = {
        name: 'test-exporter',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(mockExporter)

      expect(logger.getRegisteredExporters()).toContain('test-exporter')
    })

    it('should throw when registering duplicate exporter', () => {
      const exporter: AuditExporter = {
        name: 'duplicate',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(exporter)

      expect(() => logger.registerExporter(exporter)).toThrow(
        "Exporter 'duplicate' is already registered"
      )
    })

    it('should unregister an exporter', () => {
      const exporter: AuditExporter = {
        name: 'removable',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(exporter)
      expect(logger.getRegisteredExporters()).toContain('removable')

      const result = logger.unregisterExporter('removable')
      expect(result).toBe(true)
      expect(logger.getRegisteredExporters()).not.toContain('removable')
    })

    it('should return false when unregistering non-existent exporter', () => {
      const result = logger.unregisterExporter('non-existent')
      expect(result).toBe(false)
    })

    it('should log exporter registration events', () => {
      const exporter: AuditExporter = {
        name: 'logged-exporter',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(exporter)

      const logs = logger.query({ resource: 'exporter:logged-exporter' })
      expect(logs.length).toBeGreaterThan(0)

      const registrationLog = logs.find((l) => l.action === 'exporter_registered')
      expect(registrationLog).toBeDefined()
      expect(registrationLog!.result).toBe('success')
    })

    it('should log exporter unregistration events', () => {
      const exporter: AuditExporter = {
        name: 'unlog-exporter',
        export: vi.fn().mockResolvedValue(undefined),
      }

      logger.registerExporter(exporter)
      logger.unregisterExporter('unlog-exporter')

      const logs = logger.query({ resource: 'exporter:unlog-exporter' })
      const unregistrationLog = logs.find((l) => l.action === 'exporter_unregistered')
      expect(unregistrationLog).toBeDefined()
      expect(unregistrationLog!.result).toBe('success')
    })

    it('should support multiple exporters', () => {
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

      const exporters = logger.getRegisteredExporters()
      expect(exporters).toContain('exporter-1')
      expect(exporters).toContain('exporter-2')
      expect(exporters).toHaveLength(2)
    })
  })

  describe('logSSOEvent', () => {
    it('should log successful SSO login', () => {
      const event: SSOLoginInput = {
        provider: 'okta',
        userId: 'user@example.com',
        result: 'success',
        sessionId: 'sess_abc123',
        clientIp: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      }

      logger.logSSOEvent(event)

      const logs = logger.queryEnterprise({ enterpriseEventType: 'sso_login' })
      expect(logs.length).toBeGreaterThan(0)

      const ssoLog = logs[0]
      expect(ssoLog.event_type).toBe('sso_login')
      expect(ssoLog.result).toBe('success')
      expect(ssoLog.metadata).toMatchObject({
        provider: 'okta',
        userId: 'user@example.com',
        sessionId: 'sess_abc123',
      })
    })

    it('should log failed SSO login attempt', () => {
      const event: SSOLoginInput = {
        provider: 'azure_ad',
        userId: 'unknown@example.com',
        result: 'blocked',
      }

      logger.logSSOEvent(event)

      const logs = logger.queryEnterprise({ enterpriseEventType: 'sso_login' })
      expect(logs.length).toBeGreaterThan(0)

      const ssoLog = logs[0]
      expect(ssoLog.action).toBe('login_attempt')
      expect(ssoLog.result).toBe('blocked')
    })

    it('should include optional metadata', () => {
      const event: SSOLoginInput = {
        provider: 'google',
        userId: 'user@example.com',
        result: 'success',
        metadata: {
          mfaUsed: true,
          loginMethod: 'password',
        },
      }

      logger.logSSOEvent(event)

      const logs = logger.queryEnterprise({ enterpriseEventType: 'sso_login' })
      expect(logs[0].metadata).toMatchObject({
        mfaUsed: true,
        loginMethod: 'password',
      })
    })
  })

  describe('logRBACEvent', () => {
    it('should log successful RBAC check', () => {
      const event: RBACCheckInput = {
        principal: 'user@example.com',
        principalType: 'user',
        resource: '/api/skills',
        permission: 'read',
        roles: ['viewer', 'member'],
        result: 'success',
      }

      logger.logRBACEvent(event)

      const logs = logger.queryEnterprise({ enterpriseEventType: 'rbac_check' })
      expect(logs.length).toBeGreaterThan(0)

      const rbacLog = logs[0]
      expect(rbacLog.event_type).toBe('rbac_check')
      expect(rbacLog.actor).toBe('user')
      expect(rbacLog.action).toBe('check:read')
      expect(rbacLog.result).toBe('success')
    })

    it('should log blocked RBAC check with denial reason', () => {
      const event: RBACCheckInput = {
        principal: 'api-key-123',
        principalType: 'api_key',
        resource: '/api/admin',
        permission: 'write',
        result: 'blocked',
        denialReason: 'Insufficient permissions for admin resource',
      }

      logger.logRBACEvent(event)

      const logs = logger.queryEnterprise({ enterpriseEventType: 'rbac_check' })
      expect(logs.length).toBeGreaterThan(0)

      const rbacLog = logs[0]
      expect(rbacLog.result).toBe('blocked')
      expect(rbacLog.metadata?.denialReason).toBe('Insufficient permissions for admin resource')
    })

    it('should handle service account principal type', () => {
      const event: RBACCheckInput = {
        principal: 'svc-automation',
        principalType: 'service_account',
        resource: '/api/internal',
        permission: 'execute',
        result: 'success',
      }

      logger.logRBACEvent(event)

      const logs = logger.queryEnterprise({ enterpriseEventType: 'rbac_check' })
      expect(logs[0].actor).toBe('system')
    })
  })

  describe('logLicenseEvent', () => {
    it('should log successful license validation', () => {
      const event: LicenseCheckInput = {
        licenseKeyHint: '****abc1',
        tier: 'enterprise',
        result: 'success',
        expiresAt: '2025-12-31T23:59:59Z',
        seatsUsed: 45,
        seatsTotal: 100,
      }

      logger.logLicenseEvent(event)

      const logs = logger.queryEnterprise({ enterpriseEventType: 'license_validation' })
      expect(logs.length).toBeGreaterThan(0)

      const licenseLog = logs[0]
      expect(licenseLog.event_type).toBe('license_validation')
      expect(licenseLog.resource).toBe('license:enterprise')
      expect(licenseLog.result).toBe('success')
      expect(licenseLog.metadata?.seatsUsed).toBe(45)
      expect(licenseLog.metadata?.seatsTotal).toBe(100)
    })

    it('should log feature-specific license check', () => {
      const event: LicenseCheckInput = {
        licenseKeyHint: '****xyz9',
        tier: 'professional',
        feature: 'advanced_analytics',
        result: 'success',
      }

      logger.logLicenseEvent(event)

      const logs = logger.queryEnterprise({ enterpriseEventType: 'license_validation' })
      expect(logs[0].action).toBe('validate:advanced_analytics')
    })

    it('should log failed license validation', () => {
      const event: LicenseCheckInput = {
        licenseKeyHint: '****exp0',
        tier: 'starter',
        result: 'error',
        metadata: {
          reason: 'License expired',
        },
      }

      logger.logLicenseEvent(event)

      const logs = logger.queryEnterprise({ enterpriseEventType: 'license_validation' })
      expect(logs[0].result).toBe('error')
      expect(logs[0].metadata?.reason).toBe('License expired')
    })

    it('should handle all license tiers', () => {
      const tiers: LicenseCheckInput['tier'][] = [
        'starter',
        'professional',
        'enterprise',
        'unlimited',
      ]

      for (const tier of tiers) {
        logger.logLicenseEvent({
          licenseKeyHint: '****test',
          tier,
          result: 'success',
        })
      }

      const logs = logger.queryEnterprise({ enterpriseEventType: 'license_validation' })
      expect(logs).toHaveLength(4)
    })
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

      const testDb = createDatabase(':memory:')
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
    it('should clean up resources', () => {
      const testDb = createDatabase(':memory:')
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
    it('should enforce minimum retention of 30 days', () => {
      const testDb = createDatabase(':memory:')

      // Try to set retention below minimum
      const testLogger = new EnterpriseAuditLogger(testDb, {
        retentionDays: 15, // Below 30-day minimum
      })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(30) // Should be clamped to minimum

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should enforce maximum retention of 90 days', () => {
      const testDb = createDatabase(':memory:')

      // Try to set retention above maximum
      const testLogger = new EnterpriseAuditLogger(testDb, {
        retentionDays: 180, // Above 90-day maximum
      })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(90) // Should be clamped to maximum

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should allow custom retention within bounds', () => {
      const testDb = createDatabase(':memory:')

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
        (l) => (l.metadata as Record<string, unknown>)?._enterpriseEventType === 'sso_login'
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
        (l) => (l.metadata as Record<string, unknown>)?._enterpriseEventType === 'rbac_check'
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
          (l.metadata as Record<string, unknown>)?._enterpriseEventType === 'license_validation'
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
      expect(splunkEvents[0].event_type).toBe('sso_login')
      expect(splunkEvents[1].event_type).toBe('rbac_check')
      expect(splunkEvents[2].event_type).toBe('license_validation')

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
