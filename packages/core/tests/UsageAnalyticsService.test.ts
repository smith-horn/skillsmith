/**
 * UsageAnalyticsService Tests
 *
 * Tests for Epic 3: Skill Usage Analytics
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { initializeAnalyticsSchema } from '../src/analytics/schema.js'
import { UsageAnalyticsService } from '../src/analytics/UsageAnalyticsService.js'
import type { UsageEventInput } from '../src/analytics/types.js'

describe('UsageAnalyticsService', () => {
  let db: DatabaseType
  let service: UsageAnalyticsService

  beforeEach(() => {
    db = new Database(':memory:')
    initializeAnalyticsSchema(db)
    service = new UsageAnalyticsService(db)
  })

  afterEach(() => {
    if (db) db.close()
  })

  describe('trackUsage', () => {
    it('should track a usage event', () => {
      const input: UsageEventInput = {
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
        valueScore: 0.8,
      }

      const event = service.trackUsage(input)

      expect(event.id).toBeDefined()
      expect(event.skillId).toBe('skill-1')
      expect(event.eventType).toBe('activation')
    })

    it('should track multiple event types', () => {
      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
      })

      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'invocation',
      })

      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
      })

      const summary = service.getUsageSummary({ skillId: 'skill-1' })

      expect(summary.totalEvents).toBe(3)
      expect(summary.eventsByType.activation).toBe(1)
      expect(summary.eventsByType.invocation).toBe(1)
      expect(summary.eventsByType.success).toBe(1)
    })
  })

  describe('getUsageSummary', () => {
    beforeEach(() => {
      // Seed data
      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
        valueScore: 0.8,
      })

      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
        valueScore: 0.9,
      })

      service.trackUsage({
        skillId: 'skill-2',
        userId: 'user-2',
        sessionId: 'session-2',
        eventType: 'activation',
        valueScore: 0.7,
      })
    })

    it('should generate summary for all events', () => {
      const summary = service.getUsageSummary()

      expect(summary.totalEvents).toBeGreaterThanOrEqual(3)
      expect(summary.periodStart).toBeDefined()
      expect(summary.periodEnd).toBeDefined()
    })

    it('should filter summary by skill', () => {
      const summary = service.getUsageSummary({ skillId: 'skill-1' })

      expect(summary.totalEvents).toBe(2)
      expect(summary.uniqueUsers).toBe(1)
      expect(summary.uniqueSkills).toBe(1)
    })

    it('should filter summary by user', () => {
      const summary = service.getUsageSummary({ userId: 'user-1' })

      expect(summary.totalEvents).toBe(2)
      expect(summary.uniqueUsers).toBe(1)
      expect(summary.uniqueSkills).toBe(1)
    })

    it('should calculate average value score', () => {
      const summary = service.getUsageSummary({ userId: 'user-1' })

      // Average of 0.8 and 0.9
      expect(summary.avgValueScore).toBeCloseTo(0.85, 2)
    })

    it('should identify top skills', () => {
      // Add more events for skill-1
      for (let i = 0; i < 5; i++) {
        service.trackUsage({
          skillId: 'skill-1',
          userId: 'user-1',
          sessionId: 'session-1',
          eventType: 'success',
        })
      }

      const summary = service.getUsageSummary()

      expect(summary.topSkills.length).toBeGreaterThan(0)
      expect(summary.topSkills[0].skillId).toBe('skill-1')
      expect(summary.topSkills[0].count).toBeGreaterThan(1)
    })
  })

  describe('getWeeklyDigest', () => {
    it('should generate weekly digest for user', () => {
      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
      })

      const digest = service.getWeeklyDigest('user-1')

      expect(digest.periodStart).toBeDefined()
      expect(digest.periodEnd).toBeDefined()
      expect(digest.totalEvents).toBeGreaterThanOrEqual(1)

      // Verify it's a 7-day window
      const start = new Date(digest.periodStart)
      const end = new Date(digest.periodEnd)
      const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
      expect(daysDiff).toBeLessThanOrEqual(7)
    })
  })

  describe('getMonthlySummary', () => {
    it('should generate monthly summary for user', () => {
      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
      })

      const summary = service.getMonthlySummary('user-1')

      expect(summary.periodStart).toBeDefined()
      expect(summary.periodEnd).toBeDefined()
      expect(summary.totalEvents).toBeGreaterThanOrEqual(1)

      // Verify it's a 30-day window
      const start = new Date(summary.periodStart)
      const end = new Date(summary.periodEnd)
      const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
      expect(daysDiff).toBeLessThanOrEqual(30)
    })
  })

  describe('exportUsageData', () => {
    beforeEach(() => {
      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
        valueScore: 0.8,
      })

      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
        valueScore: 0.9,
      })
    })

    it('should export as JSON', () => {
      const exported = service.exportUsageData({ format: 'json', userId: 'user-1' })

      expect(exported).toBeDefined()
      const parsed = JSON.parse(exported)
      expect(parsed.totalEvents).toBeGreaterThanOrEqual(2)
      expect(parsed.eventsByType).toBeDefined()
    })

    it('should export as CSV', () => {
      const exported = service.exportUsageData({ format: 'csv', userId: 'user-1' })

      expect(exported).toBeDefined()
      expect(typeof exported).toBe('string')
      expect(exported).toContain('Metric,Value')
      expect(exported).toContain('Total Events')
      expect(exported).toContain('Event Type,Count')
    })

    it('should reject PDF format (not implemented)', () => {
      expect(() => {
        service.exportUsageData({ format: 'pdf', userId: 'user-1' })
      }).toThrow('PDF export not yet implemented')
    })
  })

  describe('cleanupOldData', () => {
    it('should clean up old events beyond retention period', () => {
      // Record event
      const event = service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
      })

      // Manually update timestamp to 31 days ago
      const thirtyOneDaysAgo = new Date()
      thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31)
      db.prepare('UPDATE skill_usage_events SET timestamp = ? WHERE id = ?').run(
        thirtyOneDaysAgo.toISOString(),
        event.id
      )

      // Record recent event
      service.trackUsage({
        skillId: 'skill-2',
        userId: 'user-2',
        sessionId: 'session-2',
        eventType: 'success',
      })

      // Cleanup
      const deleted = service.cleanupOldData()

      expect(deleted).toBe(1)
    })

    it('should not delete recent events', () => {
      service.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
      })

      const deleted = service.cleanupOldData()

      expect(deleted).toBe(0)
    })
  })
})
