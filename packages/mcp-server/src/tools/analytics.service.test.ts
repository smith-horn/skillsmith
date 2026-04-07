/**
 * @fileoverview Tests for real analytics service (SQLite-backed)
 * @see SMI-3916: Wave 2 — Analytics real queries
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase } from '@skillsmith/core'
import type { Database } from '@skillsmith/core'
import { createRealAnalyticsService, type AnalyticsService } from './analytics.service.js'

// ============================================================================
// Test helpers
// ============================================================================

function seedAuditLogs(db: Database, rows: Array<Partial<AuditRow>>): void {
  const stmt = db.prepare(
    'INSERT INTO audit_logs (id, event_type, timestamp, actor, resource, action, result) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (const row of rows) {
    stmt.run(
      row.id ?? crypto.randomUUID(),
      row.event_type ?? 'tool.call',
      row.timestamp ?? new Date().toISOString(),
      row.actor ?? null,
      row.resource ?? null,
      row.action ?? 'execute',
      row.result ?? 'success'
    )
  }
}

interface AuditRow {
  id: string
  event_type: string
  timestamp: string
  actor: string | null
  resource: string | null
  action: string
  result: string
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

// ============================================================================
// Tests
// ============================================================================

describe('createRealAnalyticsService', () => {
  let db: Database
  let svc: AnalyticsService

  beforeEach(() => {
    db = createDatabase(':memory:')
    svc = createRealAnalyticsService(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('getDashboardData', () => {
    it('returns zero counts for an empty database', () => {
      const data = svc.getDashboardData(30)
      expect(data.totalToolCalls).toBe(0)
      expect(data.uniqueTools).toBe(0)
      expect(data.topTools).toEqual([])
      expect(data.dailyTrend).toEqual([])
      expect(data.periodComparison).toEqual({
        current: 0,
        previous: 0,
        changePercent: 0,
      })
    })

    it('counts total tool calls within the period', () => {
      seedAuditLogs(db, [
        { resource: 'search', timestamp: daysAgo(5) },
        { resource: 'search', timestamp: daysAgo(10) },
        { resource: 'install', timestamp: daysAgo(40) }, // outside 30d
      ])

      const data = svc.getDashboardData(30)
      expect(data.totalToolCalls).toBe(2)
    })

    it('counts unique tools', () => {
      seedAuditLogs(db, [
        { resource: 'search', timestamp: daysAgo(1) },
        { resource: 'search', timestamp: daysAgo(2) },
        { resource: 'install', timestamp: daysAgo(3) },
        { resource: 'validate', timestamp: daysAgo(4) },
      ])

      const data = svc.getDashboardData(30)
      expect(data.uniqueTools).toBe(3)
    })

    it('returns top tools ordered by count', () => {
      seedAuditLogs(db, [
        { resource: 'search', timestamp: daysAgo(1) },
        { resource: 'search', timestamp: daysAgo(2) },
        { resource: 'search', timestamp: daysAgo(3) },
        { resource: 'install', timestamp: daysAgo(1) },
        { resource: 'install', timestamp: daysAgo(2) },
        { resource: 'validate', timestamp: daysAgo(1) },
      ])

      const data = svc.getDashboardData(30)
      expect(data.topTools).toHaveLength(3)
      expect(data.topTools[0]).toEqual({ tool: 'search', count: 3 })
      expect(data.topTools[1]).toEqual({ tool: 'install', count: 2 })
      expect(data.topTools[2]).toEqual({ tool: 'validate', count: 1 })
    })

    it('limits top tools to 10', () => {
      const resources = Array.from({ length: 15 }, (_, i) => `tool-${i}`)
      const rows = resources.map((r) => ({ resource: r, timestamp: daysAgo(1) }))
      seedAuditLogs(db, rows)

      const data = svc.getDashboardData(30)
      expect(data.topTools).toHaveLength(10)
    })

    it('produces daily trend grouped by date', () => {
      seedAuditLogs(db, [
        { resource: 'search', timestamp: daysAgo(2) },
        { resource: 'search', timestamp: daysAgo(2) },
        { resource: 'install', timestamp: daysAgo(1) },
      ])

      const data = svc.getDashboardData(7)
      expect(data.dailyTrend.length).toBeGreaterThanOrEqual(2)

      // Each entry has date + count
      for (const entry of data.dailyTrend) {
        expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(entry.count).toBeGreaterThanOrEqual(1)
      }
    })

    it('computes period comparison correctly', () => {
      // Previous period: 4 events (60-31 days ago)
      seedAuditLogs(db, [
        { resource: 'a', timestamp: daysAgo(35) },
        { resource: 'a', timestamp: daysAgo(40) },
        { resource: 'a', timestamp: daysAgo(45) },
        { resource: 'a', timestamp: daysAgo(50) },
      ])

      // Current period: 2 events (within 30 days)
      seedAuditLogs(db, [
        { resource: 'a', timestamp: daysAgo(5) },
        { resource: 'a', timestamp: daysAgo(10) },
      ])

      const data = svc.getDashboardData(30)
      expect(data.periodComparison.current).toBe(2)
      expect(data.periodComparison.previous).toBe(4)
      expect(data.periodComparison.changePercent).toBe(-50)
    })
  })

  describe('getUsageReport', () => {
    it('returns dashboard data without byActor in non-detailed mode', () => {
      seedAuditLogs(db, [{ resource: 'search', actor: 'alice', timestamp: daysAgo(1) }])

      const data = svc.getUsageReport(30, false)
      expect(data.totalToolCalls).toBe(1)
      expect(data.byActor).toBeUndefined()
    })

    it('includes byActor in detailed mode', () => {
      seedAuditLogs(db, [
        { resource: 'search', actor: 'alice', timestamp: daysAgo(1) },
        { resource: 'search', actor: 'alice', timestamp: daysAgo(2) },
        { resource: 'install', actor: 'bob', timestamp: daysAgo(1) },
      ])

      const data = svc.getUsageReport(30, true)
      expect(data.byActor).toBeDefined()
      expect(data.byActor).toHaveLength(2)
      expect(data.byActor![0]).toEqual({ actor: 'alice', count: 2 })
      expect(data.byActor![1]).toEqual({ actor: 'bob', count: 1 })
    })

    it('excludes null actors from byActor', () => {
      seedAuditLogs(db, [
        { resource: 'search', actor: null, timestamp: daysAgo(1) },
        { resource: 'search', actor: 'alice', timestamp: daysAgo(1) },
      ])

      const data = svc.getUsageReport(30, true)
      expect(data.byActor).toHaveLength(1)
      expect(data.byActor![0].actor).toBe('alice')
    })
  })
})
