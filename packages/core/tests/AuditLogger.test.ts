/**
 * SMI-733: Audit Logger Tests
 *
 * Comprehensive test suite for the audit logging system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from '../src/security/AuditLogger.js'
import { createDatabase, closeDatabase } from '../src/db/schema.js'
import type { Database as DatabaseType } from 'better-sqlite3'

describe('AuditLogger', () => {
  let db: DatabaseType
  let auditLogger: AuditLogger

  beforeEach(() => {
    // Create in-memory database for testing
    db = createDatabase(':memory:')
    auditLogger = new AuditLogger(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('log', () => {
    it('should log a simple audit event', () => {
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'https://example.com',
        action: 'fetch',
        result: 'success',
      })

      const logs = auditLogger.query({ limit: 10 })
      expect(logs).toHaveLength(1)
      expect(logs[0].event_type).toBe('url_fetch')
      expect(logs[0].actor).toBe('adapter')
      expect(logs[0].resource).toBe('https://example.com')
      expect(logs[0].action).toBe('fetch')
      expect(logs[0].result).toBe('success')
    })

    it('should generate unique IDs for each log entry', () => {
      auditLogger.log({
        event_type: 'file_access',
        actor: 'system',
        resource: '/path/to/file',
        action: 'read',
        result: 'success',
      })

      auditLogger.log({
        event_type: 'file_access',
        actor: 'system',
        resource: '/path/to/file2',
        action: 'read',
        result: 'success',
      })

      const logs = auditLogger.query({ limit: 10 })
      expect(logs).toHaveLength(2)
      expect(logs[0].id).not.toBe(logs[1].id)
    })

    it('should auto-generate timestamps', () => {
      const before = new Date()
      auditLogger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'test-skill',
        action: 'install',
        result: 'success',
      })
      const after = new Date()

      const logs = auditLogger.query({ limit: 1 })
      const timestamp = new Date(logs[0].timestamp)

      expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('should store metadata as JSON', () => {
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'https://example.com',
        action: 'fetch',
        result: 'success',
        metadata: {
          status: 200,
          duration: 123,
          headers: { 'content-type': 'application/json' },
        },
      })

      const logs = auditLogger.query({ limit: 1 })
      expect(logs[0].metadata).toEqual({
        status: 200,
        duration: 123,
        headers: { 'content-type': 'application/json' },
      })
    })

    it('should handle missing metadata', () => {
      auditLogger.log({
        event_type: 'file_access',
        actor: 'system',
        resource: '/path/to/file',
        action: 'read',
        result: 'success',
      })

      const logs = auditLogger.query({ limit: 1 })
      expect(logs[0].metadata).toBeUndefined()
    })

    it('should log all event types', () => {
      const eventTypes = [
        'url_fetch',
        'file_access',
        'skill_install',
        'skill_uninstall',
        'security_scan',
        'cache_operation',
        'source_sync',
        'config_change',
      ] as const

      for (const event_type of eventTypes) {
        auditLogger.log({
          event_type,
          actor: 'system',
          resource: 'test',
          action: 'test',
          result: 'success',
        })
      }

      const logs = auditLogger.query({ limit: 100 })
      expect(logs).toHaveLength(eventTypes.length)
    })

    it('should log all result types', () => {
      const results = ['success', 'blocked', 'error', 'warning'] as const

      for (const result of results) {
        auditLogger.log({
          event_type: 'url_fetch',
          actor: 'adapter',
          resource: 'https://example.com',
          action: 'fetch',
          result,
        })
      }

      const logs = auditLogger.query({ limit: 100 })
      expect(logs).toHaveLength(results.length)
    })
  })

  describe('query', () => {
    beforeEach(() => {
      // Insert test data
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'https://example.com',
        action: 'fetch',
        result: 'success',
        metadata: { status: 200 },
      })

      auditLogger.log({
        event_type: 'file_access',
        actor: 'system',
        resource: '/etc/passwd',
        action: 'read',
        result: 'blocked',
        metadata: { reason: 'sensitive path' },
      })

      auditLogger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'test-skill',
        action: 'install',
        result: 'success',
      })

      auditLogger.log({
        event_type: 'security_scan',
        actor: 'scanner',
        resource: 'test-skill',
        action: 'scan',
        result: 'warning',
        metadata: { findings: 2 },
      })
    })

    it('should query all logs without filter', () => {
      const logs = auditLogger.query()
      expect(logs.length).toBeGreaterThanOrEqual(4)
    })

    it('should filter by event type', () => {
      const logs = auditLogger.query({ event_type: 'url_fetch' })
      expect(logs).toHaveLength(1)
      expect(logs[0].event_type).toBe('url_fetch')
    })

    it('should filter by actor', () => {
      const logs = auditLogger.query({ actor: 'user' })
      expect(logs).toHaveLength(1)
      expect(logs[0].actor).toBe('user')
    })

    it('should filter by resource (partial match)', () => {
      const logs = auditLogger.query({ resource: 'test-skill' })
      expect(logs).toHaveLength(2)
      expect(logs.every((l) => l.resource.includes('test-skill'))).toBe(true)
    })

    it('should filter by result', () => {
      const logs = auditLogger.query({ result: 'blocked' })
      expect(logs).toHaveLength(1)
      expect(logs[0].result).toBe('blocked')
    })

    it('should filter by date range', () => {
      const since = new Date(Date.now() - 1000) // 1 second ago
      const until = new Date(Date.now() + 1000) // 1 second from now

      const logs = auditLogger.query({ since, until })
      expect(logs.length).toBeGreaterThanOrEqual(4)
    })

    it('should limit results', () => {
      const logs = auditLogger.query({ limit: 2 })
      expect(logs).toHaveLength(2)
    })

    it('should support offset pagination', () => {
      const page1 = auditLogger.query({ limit: 2, offset: 0 })
      const page2 = auditLogger.query({ limit: 2, offset: 2 })

      expect(page1).toHaveLength(2)
      expect(page2.length).toBeGreaterThan(0)
      expect(page1[0].id).not.toBe(page2[0].id)
    })

    it('should combine multiple filters', () => {
      const logs = auditLogger.query({
        event_type: 'security_scan',
        actor: 'scanner',
        result: 'warning',
      })

      expect(logs).toHaveLength(1)
      expect(logs[0].event_type).toBe('security_scan')
      expect(logs[0].actor).toBe('scanner')
      expect(logs[0].result).toBe('warning')
    })

    it('should return results in descending timestamp order', () => {
      const logs = auditLogger.query({ limit: 4 })

      for (let i = 0; i < logs.length - 1; i++) {
        const current = new Date(logs[i].timestamp)
        const next = new Date(logs[i + 1].timestamp)
        expect(current.getTime()).toBeGreaterThanOrEqual(next.getTime())
      }
    })
  })

  describe('getStats', () => {
    beforeEach(() => {
      // Insert test data with known distribution
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'https://example.com',
        action: 'fetch',
        result: 'success',
      })

      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'https://evil.com',
        action: 'fetch',
        result: 'blocked',
      })

      auditLogger.log({
        event_type: 'file_access',
        actor: 'system',
        resource: '/etc/passwd',
        action: 'read',
        result: 'blocked',
      })

      auditLogger.log({
        event_type: 'security_scan',
        actor: 'scanner',
        resource: 'test-skill',
        action: 'scan',
        result: 'error',
      })
    })

    it('should return total event count', () => {
      const stats = auditLogger.getStats()
      expect(stats.total_events).toBe(4)
    })

    it('should count events by type', () => {
      const stats = auditLogger.getStats()
      expect(stats.events_by_type.url_fetch).toBe(2)
      expect(stats.events_by_type.file_access).toBe(1)
      expect(stats.events_by_type.security_scan).toBe(1)
    })

    it('should count events by result', () => {
      const stats = auditLogger.getStats()
      expect(stats.events_by_result.success).toBe(1)
      expect(stats.events_by_result.blocked).toBe(2)
      expect(stats.events_by_result.error).toBe(1)
    })

    it('should count blocked events', () => {
      const stats = auditLogger.getStats()
      expect(stats.blocked_events).toBe(2)
    })

    it('should count error events', () => {
      const stats = auditLogger.getStats()
      expect(stats.error_events).toBe(1)
    })

    it('should track oldest and newest events', () => {
      const stats = auditLogger.getStats()
      expect(stats.oldest_event).toBeTruthy()
      expect(stats.newest_event).toBeTruthy()

      const oldest = new Date(stats.oldest_event!)
      const newest = new Date(stats.newest_event!)
      expect(oldest.getTime()).toBeLessThanOrEqual(newest.getTime())
    })

    it('should handle empty database', () => {
      const emptyDb = createDatabase(':memory:')
      const emptyAuditLogger = new AuditLogger(emptyDb)

      const stats = emptyAuditLogger.getStats()
      expect(stats.total_events).toBe(0)
      expect(stats.blocked_events).toBe(0)
      expect(stats.error_events).toBe(0)
      expect(stats.oldest_event).toBeNull()
      expect(stats.newest_event).toBeNull()

      closeDatabase(emptyDb)
    })
  })

  describe('cleanup', () => {
    it('should delete old audit logs', () => {
      // Insert old logs
      const oldTimestamp = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago

      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'https://example.com',
        action: 'fetch',
        result: 'success',
        timestamp: oldTimestamp.toISOString(),
      })

      // Insert recent log
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'https://example.com',
        action: 'fetch',
        result: 'success',
      })

      const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) // 3 days ago
      const deleted = auditLogger.cleanup(cutoff)

      expect(deleted).toBe(1)

      const remaining = auditLogger.query()
      expect(remaining).toHaveLength(1)
    })

    it('should return count of deleted entries', () => {
      // Insert multiple old logs
      const oldTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago

      for (let i = 0; i < 5; i++) {
        auditLogger.log({
          event_type: 'url_fetch',
          actor: 'adapter',
          resource: `https://example${i}.com`,
          action: 'fetch',
          result: 'success',
          timestamp: oldTimestamp.toISOString(),
        })
      }

      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago
      const deleted = auditLogger.cleanup(cutoff)

      expect(deleted).toBe(5)
    })

    it('should not delete recent logs', () => {
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'https://example.com',
        action: 'fetch',
        result: 'success',
      })

      const cutoff = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) // 1 day ago
      const deleted = auditLogger.cleanup(cutoff)

      expect(deleted).toBe(0)

      const logs = auditLogger.query()
      expect(logs).toHaveLength(1)
    })
  })

  describe('export', () => {
    beforeEach(() => {
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'https://example.com',
        action: 'fetch',
        result: 'success',
        metadata: { status: 200 },
      })

      auditLogger.log({
        event_type: 'file_access',
        actor: 'system',
        resource: '/path/to/file',
        action: 'read',
        result: 'blocked',
      })
    })

    it('should export logs as JSON', () => {
      const exported = auditLogger.export()
      const parsed = JSON.parse(exported)

      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBeGreaterThanOrEqual(2)
    })

    it('should export with filters', () => {
      const exported = auditLogger.export({ result: 'blocked' })
      const parsed = JSON.parse(exported)

      expect(parsed).toHaveLength(1)
      expect(parsed[0].result).toBe('blocked')
    })

    it('should include metadata in export', () => {
      const exported = auditLogger.export({ event_type: 'url_fetch' })
      const parsed = JSON.parse(exported)

      expect(parsed[0].metadata).toEqual({ status: 200 })
    })
  })

  describe('performance', () => {
    it('should handle large volume of logs', () => {
      const start = performance.now()

      // Insert 1000 logs
      for (let i = 0; i < 1000; i++) {
        auditLogger.log({
          event_type: 'url_fetch',
          actor: 'adapter',
          resource: `https://example${i}.com`,
          action: 'fetch',
          result: i % 4 === 0 ? 'blocked' : 'success',
        })
      }

      const insertDuration = performance.now() - start
      expect(insertDuration).toBeLessThan(1000) // Should complete in under 1 second

      // Query should be fast
      const queryStart = performance.now()
      const logs = auditLogger.query({ limit: 100 })
      const queryDuration = performance.now() - queryStart

      expect(logs).toHaveLength(100)
      expect(queryDuration).toBeLessThan(100) // Should complete in under 100ms
    })

    it('should use indexes for efficient queries', () => {
      // Insert many logs
      for (let i = 0; i < 500; i++) {
        auditLogger.log({
          event_type: 'url_fetch',
          actor: 'adapter',
          resource: `https://example${i}.com`,
          action: 'fetch',
          result: 'success',
        })
      }

      // Indexed queries should be fast
      const start = performance.now()
      auditLogger.query({ event_type: 'url_fetch', result: 'success', limit: 50 })
      const duration = performance.now() - start

      expect(duration).toBeLessThan(50) // Indexed query should be very fast
    })
  })
})
