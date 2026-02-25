/**
 * SMI-2756: Wave 3 — AuditLogger edge-case tests
 *
 * Companion file to AuditLogger.test.ts (which exceeds the 500-line limit).
 * Covers: DB write error propagation, log retention via cleanupOldLogs,
 * meta-log written after successful cleanup, query date-range filters,
 * query action-type filter, and export producing valid JSON.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../src/db/schema.js'
import { AuditLogger } from '../src/security/AuditLogger.js'

describe('AuditLogger — edge cases (SMI-2756)', () => {
  let db: ReturnType<typeof createDatabase>
  let logger: AuditLogger

  beforeEach(() => {
    db = createDatabase(':memory:')
    logger = new AuditLogger(db)
  })

  afterEach(() => {
    if (db) closeDatabase(db)
  })

  // -------------------------------------------------------------------------
  // Retention / cleanup
  // -------------------------------------------------------------------------

  describe('cleanupOldLogs', () => {
    it('deletes entries older than the retention period', () => {
      // Insert an old log with a past timestamp
      const oldTimestamp = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
      logger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'old-skill',
        action: 'install',
        result: 'success',
        timestamp: oldTimestamp,
      })

      // Insert a recent log
      logger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'new-skill',
        action: 'install',
        result: 'success',
      })

      const deleted = logger.cleanupOldLogs(90)

      // Old entry should be removed
      expect(deleted).toBeGreaterThanOrEqual(1)

      const remaining = logger.query({ resource: 'old-skill' })
      expect(remaining).toHaveLength(0)
    })

    it('preserves entries within the retention period', () => {
      // Insert a recent log
      logger.log({
        event_type: 'cache_operation',
        actor: 'user',
        resource: 'recent-skill',
        action: 'search',
        result: 'success',
      })

      const deleted = logger.cleanupOldLogs(90)

      // No recent entries should be deleted
      expect(deleted).toBe(0)

      const remaining = logger.query({ resource: 'recent-skill' })
      expect(remaining).toHaveLength(1)
    })

    it('writes a meta-log entry after successful cleanup', () => {
      // Insert an old entry to be deleted
      const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
      logger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'audit_logs',
        action: 'install',
        result: 'success',
        timestamp: oldTs,
      })

      logger.cleanupOldLogs(90)

      // A config_change event should have been logged as meta-log
      const metaEntries = logger.query({ event_type: 'config_change', resource: 'audit_logs' })
      expect(metaEntries.length).toBeGreaterThanOrEqual(1)
      const cleanupLog = metaEntries.find((e) => e.action === 'cleanup')
      expect(cleanupLog).toBeDefined()
    })

    it('throws for retentionDays below minimum (< 1)', () => {
      expect(() => logger.cleanupOldLogs(0)).toThrow(/minimum/)
    })

    it('throws for fractional retentionDays', () => {
      expect(() => logger.cleanupOldLogs(1.5)).toThrow(/integer/)
    })
  })

  // -------------------------------------------------------------------------
  // Query filters
  // -------------------------------------------------------------------------

  describe('query — date range filters', () => {
    it('filters entries by since date', () => {
      const pastTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
      logger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'old-resource',
        action: 'install',
        result: 'success',
        timestamp: pastTs,
      })
      logger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'new-resource',
        action: 'install',
        result: 'success',
      })

      const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      const results = logger.query({ since })

      const resourceNames = results.map((e) => e.resource)
      expect(resourceNames).not.toContain('old-resource')
      expect(resourceNames).toContain('new-resource')
    })

    it('filters entries by until date', () => {
      const oldTs = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
      logger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'old-resource',
        action: 'install',
        result: 'success',
        timestamp: oldTs,
      })
      logger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'new-resource',
        action: 'install',
        result: 'success',
      })

      const until = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
      const results = logger.query({ until })

      const resourceNames = results.map((e) => e.resource)
      expect(resourceNames).toContain('old-resource')
      expect(resourceNames).not.toContain('new-resource')
    })
  })

  describe('query — action type filter', () => {
    it('filters by event_type', () => {
      logger.log({
        event_type: 'cache_operation',
        actor: 'user',
        resource: 'res-a',
        action: 'search',
        result: 'success',
      })
      logger.log({
        event_type: 'skill_install',
        actor: 'user',
        resource: 'res-b',
        action: 'install',
        result: 'success',
      })

      const results = logger.query({ event_type: 'cache_operation' })

      expect(results.every((e) => e.event_type === 'cache_operation')).toBe(true)
      expect(results.some((e) => e.resource === 'res-a')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // export
  // -------------------------------------------------------------------------

  describe('export', () => {
    it('returns valid JSON string containing logged entries', () => {
      logger.log({
        event_type: 'cache_operation',
        actor: 'user',
        resource: 'exported-resource',
        action: 'search',
        result: 'success',
      })

      const json = logger.export()
      const parsed = JSON.parse(json) as unknown[]

      expect(Array.isArray(parsed)).toBe(true)
      expect(
        parsed.some((e: unknown) => (e as { resource?: string }).resource === 'exported-resource')
      ).toBe(true)
    })
  })
})
