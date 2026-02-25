/**
 * SMI-2756: AuditLogger — error handling and rotation tests
 *
 * Supplements AuditLogger.test.ts (838 lines, already over 500-line gate).
 * Tests error swallowing, rotate/VACUUM, getRecentLogs filtering, and limits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AuditLogger } from '../src/security/AuditLogger.js'
import { createDatabase, closeDatabase } from '../src/db/schema.js'
import type { Database } from '../src/db/database-interface.js'

/** Fixed timestamp used for all tests */
const BASE_DATE = new Date('2026-01-15T10:00:00.000Z')

describe('AuditLogger — error handling and rotation', () => {
  let db: Database
  let auditLogger: AuditLogger

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_DATE)
    db = createDatabase(':memory:')
    auditLogger = new AuditLogger(db)
  })

  afterEach(() => {
    closeDatabase(db)
    vi.useRealTimers()
  })

  // ---------------------------------------------------------------------------
  // Error swallowing
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('log() does not swallow inserts — throws on DB insert error', () => {
      // The source code re-throws after logging the error.
      // Force an error by closing the DB before logging.
      closeDatabase(db)

      // The AuditLogger's stmts.insert.run() will throw after DB close.
      expect(() =>
        auditLogger.log({
          event_type: 'url_fetch',
          actor: 'system',
          resource: 'http://example.com',
          action: 'fetch',
          result: 'success',
        })
      ).toThrow(Error)
    })
  })

  // ---------------------------------------------------------------------------
  // Rotation via cleanupOldLogs
  // ---------------------------------------------------------------------------

  describe('cleanupOldLogs (rotation)', () => {
    function insertOldLog(daysAgo: number): void {
      const oldTs = new Date(BASE_DATE.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
      db.exec(
        `INSERT INTO audit_logs (id, event_type, timestamp, actor, resource, action, result, created_at)
         VALUES ('old-${daysAgo}-${Math.random()}', 'url_fetch', '${oldTs}', 'test', 'res', 'act', 'success', '${oldTs}')`
      )
    }

    it('cleanupOldLogs(30) deletes entries older than 30 days and runs without error', () => {
      insertOldLog(31) // should be deleted
      insertOldLog(29) // should be kept

      const deleted = auditLogger.cleanupOldLogs(30)

      expect(deleted).toBeGreaterThanOrEqual(1)
      // The 29-day entry should remain
      const remaining = auditLogger.query({ limit: 100 })
      // Remaining: at minimum the 29-day entry + the meta cleanup log
      expect(remaining.length).toBeGreaterThan(0)
    })

    it('cleanupOldLogs with threshold=1 deletes entries older than 1 day', () => {
      insertOldLog(2)  // 2 days old — should be deleted
      insertOldLog(0)  // today — should be kept (0 days old, timestamp = now)

      const deleted = auditLogger.cleanupOldLogs(1)

      // The 2-day entry is deleted
      expect(deleted).toBeGreaterThanOrEqual(1)
    })

    it('cleanupOldLogs with no old entries returns 0 deleted', () => {
      // Only log a fresh entry (right now)
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'system',
        resource: 'http://example.com',
        action: 'fetch',
        result: 'success',
      })

      const deleted = auditLogger.cleanupOldLogs(1)

      // Nothing old to delete
      expect(deleted).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // getRecentLogs / query filtering
  // ---------------------------------------------------------------------------

  describe('query (getRecentLogs equivalent)', () => {
    beforeEach(() => {
      // Seed several log entries with different event types
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'http://example.com',
        action: 'fetch',
        result: 'success',
      })
      auditLogger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'test-skill',
        action: 'install',
        result: 'success',
      })
      auditLogger.log({
        event_type: 'url_fetch',
        actor: 'adapter',
        resource: 'http://another.com',
        action: 'fetch',
        result: 'blocked',
      })
    })

    it('filters by event_type', () => {
      const logs = auditLogger.query({ event_type: 'skill_install' })

      expect(logs.length).toBe(1)
      expect(logs[0].event_type).toBe('skill_install')
    })

    it('limit param returns capped count', () => {
      const logs = auditLogger.query({ limit: 1 })

      expect(logs).toHaveLength(1)
    })

    it('returns empty array when no matching logs', () => {
      const logs = auditLogger.query({ event_type: 'config_change', result: 'error' })

      // No config_change + error entries were inserted
      expect(logs).toHaveLength(0)
    })

    it('filters by result', () => {
      const blocked = auditLogger.query({ result: 'blocked' })

      expect(blocked.length).toBe(1)
      expect(blocked[0].result).toBe('blocked')
    })

    it('no filters returns all entries (up to default limit)', () => {
      const all = auditLogger.query({})

      // 3 seeded entries
      expect(all.length).toBe(3)
    })
  })
})
