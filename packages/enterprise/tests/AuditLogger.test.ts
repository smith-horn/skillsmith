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
  SSOLoginInput,
  RBACCheckInput,
  LicenseCheckInput,
} from '../src/audit/AuditLogger.js'
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

describe('EnterpriseAuditLogger', () => {
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

  describe('constructor', () => {
    it('should create logger with default configuration', () => {
      const config = logger.getRetentionConfig()
      expect(config.min).toBe(ENTERPRISE_MIN_RETENTION_DAYS)
      expect(config.max).toBe(ENTERPRISE_MAX_RETENTION_DAYS)
      expect(config.current).toBe(90) // Default retention
    })

    it('should constrain retention to minimum enterprise limit', async () => {
      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)
      const testLogger = new EnterpriseAuditLogger(testDb, { retentionDays: 10 })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(ENTERPRISE_MIN_RETENTION_DAYS)

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should constrain retention to maximum enterprise limit', async () => {
      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)
      const testLogger = new EnterpriseAuditLogger(testDb, { retentionDays: 365 })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(ENTERPRISE_MAX_RETENTION_DAYS)

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should accept retention within enterprise limits', async () => {
      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)
      const testLogger = new EnterpriseAuditLogger(testDb, { retentionDays: 60 })

      const config = testLogger.getRetentionConfig()
      expect(config.current).toBe(60)

      testLogger.dispose()
      closeDatabase(testDb)
    })

    it('should support custom min/max retention limits', async () => {
      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)
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

    it('should setup auto-flush timer when configured', async () => {
      const testDb = await createDatabaseAsync(':memory:')
      initializeSchema(testDb)
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

      const ssoLog = logs[0]!
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

      const ssoLog = logs[0]!
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
      expect(logs[0]!.metadata).toMatchObject({
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

      const rbacLog = logs[0]!
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

      const rbacLog = logs[0]!
      expect(rbacLog.result).toBe('blocked')
      expect((rbacLog.metadata as Record<string, unknown>)?.['denialReason']).toBe(
        'Insufficient permissions for admin resource'
      )
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
      expect(logs[0]!.actor).toBe('system')
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

      const licenseLog = logs[0]!
      expect(licenseLog.event_type).toBe('license_validation')
      expect(licenseLog.resource).toBe('license:enterprise')
      expect(licenseLog.result).toBe('success')
      expect((licenseLog.metadata as Record<string, unknown>)?.['seatsUsed']).toBe(45)
      expect((licenseLog.metadata as Record<string, unknown>)?.['seatsTotal']).toBe(100)
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
      expect(logs[0]!.action).toBe('validate:advanced_analytics')
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
      expect(logs[0]!.result).toBe('error')
      expect((logs[0]!.metadata as Record<string, unknown>)?.['reason']).toBe('License expired')
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
})
