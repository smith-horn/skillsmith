import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  logger,
  createLogger,
  silentLogger,
  LogLevel,
  createAuditEvent,
  createSecurityEvent,
  getLogAggregator,
  setLogAggregator,
  type LogAggregator,
  type AuditEvent,
  type SecurityEvent,
} from '../src/utils/logger.js'

describe('Logger', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let originalAggregator: LogAggregator

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // Ensure NODE_ENV is set to 'test' for proper log suppression
    process.env.NODE_ENV = 'test'

    // Clear other environment variables
    delete process.env.DEBUG
    delete process.env.LOG_FORMAT
    delete process.env.LOG_LEVEL
    delete process.env.AUDIT_LOG

    // Save original aggregator before any test modifies it
    originalAggregator = getLogAggregator()

    // Clear aggregator
    if ('clear' in originalAggregator) {
      ;(originalAggregator as any).clear()
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Restore original aggregator in case a test replaced it
    setLogAggregator(originalAggregator)
  })

  describe('Basic Logging', () => {
    it('should log error messages in test mode', () => {
      logger.error('Test error')
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[skillsmith] Test error')
      )
    })

    it('should suppress warn messages in test mode', () => {
      logger.warn('Test warning')
      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })

    it('should suppress info messages without DEBUG', () => {
      logger.info('Test info')
      expect(consoleInfoSpy).not.toHaveBeenCalled()
    })

    it('should suppress debug messages without DEBUG', () => {
      logger.debug('Test debug')
      expect(consoleDebugSpy).not.toHaveBeenCalled()
    })

    it('should log info messages with DEBUG=true', () => {
      process.env.DEBUG = 'true'
      const debugLogger = createLogger('test')
      debugLogger.info('Test info')
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[skillsmith:test] Test info')
      )
    })

    it('should log debug messages with DEBUG=true', () => {
      process.env.DEBUG = 'true'
      const debugLogger = createLogger('test')
      debugLogger.debug('Test debug')
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[skillsmith:test] Test debug')
      )
    })
  })

  describe('Context Injection', () => {
    it('should include context in log messages', () => {
      logger.error('Error with context', undefined, { userId: '123', action: 'fetch' })
      const aggregator = getLogAggregator()
      const logs = aggregator.getLogs()
      const lastLog = logs[logs.length - 1]
      expect(lastLog.context).toEqual({ userId: '123', action: 'fetch' })
    })

    it('should include error object in log entries', () => {
      const error = new Error('Network failure')
      logger.error('Failed to fetch', error)
      const aggregator = getLogAggregator()
      const logs = aggregator.getLogs()
      const lastLog = logs[logs.length - 1]
      expect(lastLog.error).toBe(error)
    })

    it('should format context in human-readable output', () => {
      process.env.NODE_ENV = 'development'
      const devLogger = createLogger('test')
      devLogger.warn('Warning with context', { code: 'RATE_LIMIT' })
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('{"code":"RATE_LIMIT"}'))
    })
  })

  describe('Structured JSON Logging', () => {
    it('should output JSON format when LOG_FORMAT=json', () => {
      process.env.LOG_FORMAT = 'json'
      const jsonLogger = createLogger('test')
      jsonLogger.error('JSON error', new Error('test'))

      const callArg = consoleErrorSpy.mock.calls[0][0]
      expect(() => JSON.parse(callArg)).not.toThrow()

      const parsed = JSON.parse(callArg)
      expect(parsed).toMatchObject({
        level: 'ERROR',
        namespace: 'test',
        message: 'JSON error',
      })
      expect(parsed.error).toMatchObject({
        message: 'test',
      })
    })

    it('should include timestamp in JSON format', () => {
      process.env.LOG_FORMAT = 'json'
      const jsonLogger = createLogger('test')
      jsonLogger.error('Test')

      const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0])
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('Log Levels', () => {
    it('should respect LOG_LEVEL environment variable', () => {
      process.env.LOG_LEVEL = String(LogLevel.ERROR)
      process.env.NODE_ENV = 'development'
      const levelLogger = createLogger('test')

      levelLogger.warn('Should not log')
      levelLogger.error('Should log')

      expect(consoleWarnSpy).not.toHaveBeenCalled()
      expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('should handle numeric log levels correctly', () => {
      expect(LogLevel.DEBUG).toBe(0)
      expect(LogLevel.INFO).toBe(1)
      expect(LogLevel.WARN).toBe(2)
      expect(LogLevel.ERROR).toBe(3)
      expect(LogLevel.AUDIT).toBe(4)
      expect(LogLevel.SECURITY).toBe(5)
    })
  })

  describe('Namespaced Logger', () => {
    it('should create logger with namespace', () => {
      const namespacedLogger = createLogger('GitLabAdapter')
      namespacedLogger.error('Namespaced error')

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[skillsmith:GitLabAdapter] Namespaced error')
      )
    })

    it('should maintain namespace in aggregated logs', () => {
      const namespacedLogger = createLogger('TestNamespace')
      namespacedLogger.error('Test')

      const aggregator = getLogAggregator()
      const logs = aggregator.getLogs()
      const lastLog = logs[logs.length - 1]
      expect(lastLog.namespace).toBe('TestNamespace')
    })
  })

  describe('Silent Logger', () => {
    it('should not output any logs', () => {
      silentLogger.warn('Silent warn')
      silentLogger.error('Silent error')
      silentLogger.info('Silent info')
      silentLogger.debug('Silent debug')

      expect(consoleWarnSpy).not.toHaveBeenCalled()
      expect(consoleErrorSpy).not.toHaveBeenCalled()
      expect(consoleInfoSpy).not.toHaveBeenCalled()
      expect(consoleDebugSpy).not.toHaveBeenCalled()
    })

    it('should not call audit or security methods', () => {
      const auditEvent = createAuditEvent('skill.install', 'user', 'skill-id', 'install', 'success')
      const securityEvent = createSecurityEvent(
        'ssrf.blocked',
        'high',
        'http://evil.com',
        'fetch',
        'Blocked SSRF attempt'
      )

      silentLogger.auditLog(auditEvent)
      silentLogger.securityLog(securityEvent)

      expect(consoleLogSpy).not.toHaveBeenCalled()
      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })
  })

  describe('Audit Logging', () => {
    it('should log audit events with correct format', () => {
      const auditEvent: AuditEvent = {
        eventType: 'skill.install',
        timestamp: new Date().toISOString(),
        actor: 'user',
        resource: 'skill-123',
        action: 'install',
        result: 'success',
        metadata: { version: '1.0.0' },
      }

      logger.auditLog(auditEvent)

      const aggregator = getLogAggregator()
      const auditEvents = aggregator.getAuditEvents()
      expect(auditEvents).toHaveLength(1)
      expect(auditEvents[0]).toEqual(auditEvent)
    })

    it('should format audit events for console output', () => {
      process.env.AUDIT_LOG = 'true'
      const auditLogger = createLogger('test')

      const auditEvent = createAuditEvent(
        'adapter.request',
        'GitLabAdapter',
        'https://gitlab.com/api',
        'fetch',
        'success'
      )

      auditLogger.auditLog(auditEvent)

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[AUDIT] adapter.request'))
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('GitLabAdapter -> fetch on https://gitlab.com/api = success')
      )
    })

    it('should output audit events as JSON when LOG_FORMAT=json', () => {
      process.env.LOG_FORMAT = 'json'
      process.env.AUDIT_LOG = 'true'
      const jsonLogger = createLogger('test')

      const auditEvent = createAuditEvent('skill.fetch', 'system', 'skill-456', 'fetch', 'success')

      jsonLogger.auditLog(auditEvent)

      const callArg = consoleLogSpy.mock.calls[0][0]
      const parsed = JSON.parse(callArg)
      expect(parsed).toMatchObject({
        eventType: 'skill.fetch',
        actor: 'system',
        resource: 'skill-456',
        action: 'fetch',
        result: 'success',
      })
    })

    it('should include metadata in audit events', () => {
      const auditEvent = createAuditEvent(
        'skill.install',
        'user',
        'skill-789',
        'install',
        'success',
        { version: '2.0.0', author: 'test-author' }
      )

      logger.auditLog(auditEvent)

      const aggregator = getLogAggregator()
      const auditEvents = aggregator.getAuditEvents()
      expect(auditEvents[0].metadata).toEqual({
        version: '2.0.0',
        author: 'test-author',
      })
    })
  })

  describe('Security Logging', () => {
    it('should log security events with correct format', () => {
      const securityEvent: SecurityEvent = {
        eventType: 'ssrf.blocked',
        timestamp: new Date().toISOString(),
        severity: 'high',
        resource: 'http://169.254.169.254/metadata',
        action: 'fetch',
        details: 'Blocked SSRF attempt to AWS metadata endpoint',
        metadata: { adapter: 'GitHubAdapter' },
      }

      logger.securityLog(securityEvent)

      const aggregator = getLogAggregator()
      const securityEvents = aggregator.getSecurityEvents()
      expect(securityEvents).toHaveLength(1)
      expect(securityEvents[0]).toEqual(securityEvent)
    })

    it('should suppress security logs in test mode', () => {
      const securityEvent = createSecurityEvent(
        'path_traversal.blocked',
        'critical',
        '../../etc/passwd',
        'read',
        'Blocked path traversal attempt'
      )

      logger.securityLog(securityEvent)

      // Should not output to console in test mode
      expect(consoleWarnSpy).not.toHaveBeenCalled()

      // But should still aggregate
      const aggregator = getLogAggregator()
      const securityEvents = aggregator.getSecurityEvents()
      expect(securityEvents).toHaveLength(1)
    })

    it('should format security events for console output', () => {
      process.env.NODE_ENV = 'development'
      const devLogger = createLogger('test')

      const securityEvent = createSecurityEvent(
        'malware.detected',
        'critical',
        'skill-malicious',
        'scan',
        'Detected malicious code pattern'
      )

      devLogger.securityLog(securityEvent)

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SECURITY:CRITICAL] malware.detected')
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('scan on skill-malicious - Detected malicious code pattern')
      )
    })

    it('should output security events as JSON when LOG_FORMAT=json', () => {
      process.env.LOG_FORMAT = 'json'
      process.env.NODE_ENV = 'development'
      const jsonLogger = createLogger('test')

      const securityEvent = createSecurityEvent(
        'validation.failed',
        'medium',
        'user-input',
        'validate',
        'Input validation failed'
      )

      jsonLogger.securityLog(securityEvent)

      const callArg = consoleWarnSpy.mock.calls[0][0]
      const parsed = JSON.parse(callArg)
      expect(parsed).toMatchObject({
        eventType: 'validation.failed',
        severity: 'medium',
        resource: 'user-input',
        action: 'validate',
        details: 'Input validation failed',
      })
    })
  })

  describe('Log Aggregation', () => {
    it('should aggregate all log entries', () => {
      logger.warn('Warn message')
      logger.error('Error message')
      logger.info('Info message')

      const aggregator = getLogAggregator()
      const logs = aggregator.getLogs()
      expect(logs.length).toBeGreaterThanOrEqual(3)
    })

    it('should aggregate audit events separately', () => {
      const auditEvent1 = createAuditEvent('skill.install', 'user', 'skill-1', 'install', 'success')
      const auditEvent2 = createAuditEvent('skill.fetch', 'system', 'skill-2', 'fetch', 'success')

      logger.auditLog(auditEvent1)
      logger.auditLog(auditEvent2)

      const aggregator = getLogAggregator()
      const auditEvents = aggregator.getAuditEvents()
      expect(auditEvents).toHaveLength(2)
      expect(auditEvents[0].eventType).toBe('skill.install')
      expect(auditEvents[1].eventType).toBe('skill.fetch')
    })

    it('should aggregate security events separately', () => {
      const securityEvent1 = createSecurityEvent(
        'ssrf.blocked',
        'high',
        'http://evil.com',
        'fetch',
        'Blocked'
      )
      const securityEvent2 = createSecurityEvent(
        'path_traversal.blocked',
        'critical',
        '../../etc/passwd',
        'read',
        'Blocked'
      )

      logger.securityLog(securityEvent1)
      logger.securityLog(securityEvent2)

      const aggregator = getLogAggregator()
      const securityEvents = aggregator.getSecurityEvents()
      expect(securityEvents).toHaveLength(2)
      expect(securityEvents[0].eventType).toBe('ssrf.blocked')
      expect(securityEvents[1].eventType).toBe('path_traversal.blocked')
    })

    it('should limit aggregator size to prevent memory leaks', () => {
      const aggregator = getLogAggregator()

      // Add more logs than the max size (default 10000)
      for (let i = 0; i < 10005; i++) {
        logger.error(`Error ${i}`)
      }

      const logs = aggregator.getLogs()
      expect(logs.length).toBeLessThanOrEqual(10000)
    })

    it('should provide copies of logs to prevent external mutation', () => {
      logger.error('Original error')

      const aggregator = getLogAggregator()
      const logs1 = aggregator.getLogs()
      const logs2 = aggregator.getLogs()

      expect(logs1).not.toBe(logs2) // Different array instances
      expect(logs1).toEqual(logs2) // Same content
    })
  })

  describe('Custom Log Aggregator', () => {
    it('should allow setting custom aggregator', () => {
      const customAggregator: LogAggregator = {
        add: vi.fn(),
        addAudit: vi.fn(),
        addSecurity: vi.fn(),
        flush: vi.fn(),
        getLogs: vi.fn(() => []),
        getAuditEvents: vi.fn(() => []),
        getSecurityEvents: vi.fn(() => []),
      }

      setLogAggregator(customAggregator)

      logger.error('Test error')
      expect(customAggregator.add).toHaveBeenCalled()

      const auditEvent = createAuditEvent('skill.install', 'user', 'skill-1', 'install', 'success')
      logger.auditLog(auditEvent)
      expect(customAggregator.addAudit).toHaveBeenCalledWith(auditEvent)

      const securityEvent = createSecurityEvent(
        'ssrf.blocked',
        'high',
        'http://evil.com',
        'fetch',
        'Blocked'
      )
      logger.securityLog(securityEvent)
      expect(customAggregator.addSecurity).toHaveBeenCalledWith(securityEvent)
    })
  })

  describe('Helper Functions', () => {
    it('createAuditEvent should create valid audit event with timestamp', () => {
      const event = createAuditEvent('skill.install', 'user', 'skill-123', 'install', 'success', {
        version: '1.0.0',
      })

      expect(event).toMatchObject({
        eventType: 'skill.install',
        actor: 'user',
        resource: 'skill-123',
        action: 'install',
        result: 'success',
        metadata: { version: '1.0.0' },
      })
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('createSecurityEvent should create valid security event with timestamp', () => {
      const event = createSecurityEvent(
        'ssrf.blocked',
        'high',
        'http://evil.com',
        'fetch',
        'Blocked SSRF attempt',
        { ip: '1.2.3.4' }
      )

      expect(event).toMatchObject({
        eventType: 'ssrf.blocked',
        severity: 'high',
        resource: 'http://evil.com',
        action: 'fetch',
        details: 'Blocked SSRF attempt',
        metadata: { ip: '1.2.3.4' },
      })
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('should create events without metadata', () => {
      const auditEvent = createAuditEvent('cache.hit', 'system', 'cache-key', 'read', 'success')
      expect(auditEvent.metadata).toBeUndefined()

      const securityEvent = createSecurityEvent(
        'rate_limit.exceeded',
        'low',
        'api-endpoint',
        'request',
        'Too many requests'
      )
      expect(securityEvent.metadata).toBeUndefined()
    })
  })

  describe('Edge Cases', () => {
    it('should handle undefined context gracefully', () => {
      logger.error('Error without context')
      const aggregator = getLogAggregator()
      const logs = aggregator.getLogs()
      expect(logs.length).toBeGreaterThan(0)
      const lastLog = logs[logs.length - 1]
      expect(lastLog).toBeDefined()
      expect(lastLog.context).toBeUndefined()
    })

    it('should handle undefined error gracefully', () => {
      logger.error('Error without error object')
      const aggregator = getLogAggregator()
      const logs = aggregator.getLogs()
      expect(logs.length).toBeGreaterThan(0)
      const lastLog = logs[logs.length - 1]
      expect(lastLog).toBeDefined()
      expect(lastLog.error).toBeUndefined()
    })

    it('should handle complex metadata objects', () => {
      const complexMetadata = {
        nested: { deep: { value: 'test' } },
        array: [1, 2, 3],
        null: null,
        undefined: undefined,
      }

      const auditEvent = createAuditEvent(
        'skill.scan',
        'system',
        'skill-complex',
        'scan',
        'success',
        complexMetadata
      )

      logger.auditLog(auditEvent)

      const aggregator = getLogAggregator()
      const auditEvents = aggregator.getAuditEvents()
      expect(auditEvents.length).toBeGreaterThan(0)
      expect(auditEvents[0]).toBeDefined()
      expect(auditEvents[0].metadata).toMatchObject({
        nested: { deep: { value: 'test' } },
        array: [1, 2, 3],
        null: null,
      })
    })
  })
})
