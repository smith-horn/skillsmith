/**
 * ROIDashboardService Tests
 *
 * Tests for Epic 4: ROI Dashboard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { initializeAnalyticsSchema } from '../src/analytics/schema.js'
import { ROIDashboardService } from '../src/analytics/ROIDashboardService.js'
import { AnalyticsRepository } from '../src/analytics/AnalyticsRepository.js'
import type { UsageEventInput } from '../src/analytics/types.js'

describe('ROIDashboardService', () => {
  let db: DatabaseType
  let service: ROIDashboardService
  let repo: AnalyticsRepository

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'))
    db = new Database(':memory:')
    initializeAnalyticsSchema(db)
    service = new ROIDashboardService(db)
    repo = new AnalyticsRepository(db)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (db) db.close()
  })

  describe('getUserROI', () => {
    beforeEach(() => {
      // Seed usage events for user-1
      const events: UsageEventInput[] = [
        {
          skillId: 'skill-1',
          userId: 'user-1',
          sessionId: 'session-1',
          eventType: 'activation',
        },
        {
          skillId: 'skill-1',
          userId: 'user-1',
          sessionId: 'session-1',
          eventType: 'success',
          valueScore: 0.9,
        },
        {
          skillId: 'skill-1',
          userId: 'user-1',
          sessionId: 'session-1',
          eventType: 'success',
          valueScore: 0.8,
        },
        {
          skillId: 'skill-2',
          userId: 'user-1',
          sessionId: 'session-2',
          eventType: 'success',
          valueScore: 0.85,
        },
      ]

      for (const event of events) {
        repo.recordUsageEvent(event)
      }
    })

    it('should generate user ROI dashboard', () => {
      const roi = service.getUserROI('user-1', 30)

      expect(roi).toBeDefined()
      expect(roi!.userId).toBe('user-1')
      expect(roi!.totalTimeSaved).toBeGreaterThan(0)
      expect(roi!.estimatedValueUsd).toBeGreaterThan(0)
      expect(roi!.topSkills).toBeDefined()
      expect(roi!.weeklyTrend).toBeDefined()
    })

    it('should calculate time saved from success events', () => {
      const roi = service.getUserROI('user-1', 30)

      // 3 success events * 5 minutes each = 15 minutes
      expect(roi!.totalTimeSaved).toBe(15)
    })

    it('should estimate value in USD', () => {
      const roi = service.getUserROI('user-1', 30)

      // 15 minutes * $2/minute = $30
      expect(roi!.estimatedValueUsd).toBe(30)
    })

    it('should identify top skills', () => {
      const roi = service.getUserROI('user-1', 30)

      expect(roi!.topSkills.length).toBeGreaterThan(0)
      expect(roi!.topSkills[0].skillId).toBe('skill-1')
      expect(roi!.topSkills[0].timeSaved).toBe(10) // 2 successes * 5 min
    })

    it('should generate weekly trend', () => {
      const roi = service.getUserROI('user-1', 30)

      expect(roi!.weeklyTrend.length).toBeGreaterThan(0)
      expect(roi!.weeklyTrend[0].week).toBeDefined()
      expect(roi!.weeklyTrend[0].timeSaved).toBeGreaterThanOrEqual(0)
    })
  })

  describe('getStakeholderROI', () => {
    beforeEach(() => {
      // Seed usage events for multiple users
      const events: UsageEventInput[] = [
        {
          skillId: 'skill-1',
          userId: 'user-1',
          sessionId: 'session-1',
          eventType: 'activation',
        },
        {
          skillId: 'skill-1',
          userId: 'user-1',
          sessionId: 'session-1',
          eventType: 'success',
        },
        {
          skillId: 'skill-2',
          userId: 'user-2',
          sessionId: 'session-2',
          eventType: 'activation',
        },
        {
          skillId: 'skill-2',
          userId: 'user-2',
          sessionId: 'session-2',
          eventType: 'success',
        },
      ]

      for (const event of events) {
        repo.recordUsageEvent(event)
      }

      // Compute ROI metrics
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      service.computeROIMetrics({
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })
    })

    it('should generate stakeholder ROI dashboard', () => {
      const roi = service.getStakeholderROI(30)

      expect(roi).toBeDefined()
      expect(roi!.totalUsers).toBeGreaterThanOrEqual(0)
      expect(roi!.totalActivations).toBeGreaterThanOrEqual(0)
      expect(roi!.avgTimeSavedPerUser).toBeGreaterThanOrEqual(0)
      expect(roi!.totalEstimatedValue).toBeGreaterThanOrEqual(0)
      expect(roi!.adoptionRate).toBeGreaterThanOrEqual(0)
      expect(roi!.skillLeaderboard).toBeDefined()
    })
  })

  describe('computeROIMetrics', () => {
    beforeEach(() => {
      repo.recordUsageEvent({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
      })
      repo.recordUsageEvent({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
        valueScore: 0.9,
      })
    })

    it('should compute metrics for a user', () => {
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      const metrics = service.computeROIMetrics({
        userId: 'user-1',
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })

      expect(metrics.length).toBe(1)
      expect(metrics[0]!.metricType).toBe('user')
      expect(metrics[0]!.entityId).toBe('user-1')
      expect(metrics[0]!.totalActivations).toBe(1)
      expect(metrics[0]!.totalSuccesses).toBe(1)
    })

    it('should compute metrics for a skill', () => {
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      const metrics = service.computeROIMetrics({
        skillId: 'skill-1',
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })

      expect(metrics.length).toBe(1)
      expect(metrics[0]!.metricType).toBe('skill')
      expect(metrics[0]!.entityId).toBe('skill-1')
      expect(metrics[0]!.totalActivations).toBe(1)
      expect(metrics[0]!.totalSuccesses).toBe(1)
    })

    it('should compute daily aggregate metrics', () => {
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      const metrics = service.computeROIMetrics({
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })

      expect(metrics.length).toBe(1)
      expect(metrics[0]!.metricType).toBe('daily')
    })

    it('should calculate estimated time saved', () => {
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      const metrics = service.computeROIMetrics({
        userId: 'user-1',
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })

      // 1 success * 5 minutes = 5 minutes
      expect(metrics[0]!.estimatedTimeSaved).toBe(5)
    })

    it('should calculate estimated value in USD', () => {
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      const metrics = service.computeROIMetrics({
        userId: 'user-1',
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })

      // 5 minutes * $2/minute = $10
      expect(metrics[0]!.estimatedValueUsd).toBe(10)
    })

    it('should calculate average value score', () => {
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      const metrics = service.computeROIMetrics({
        userId: 'user-1',
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })

      expect(metrics[0]!.avgValueScore).toBeCloseTo(0.9, 2)
    })
  })

  describe('exportROIDashboard', () => {
    beforeEach(() => {
      repo.recordUsageEvent({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
      })
    })

    it('should export user ROI as JSON', () => {
      const exported = service.exportROIDashboard('user-1', 'json', 30)

      expect(exported).toBeDefined()
      const parsed = JSON.parse(exported)
      expect(parsed.user).toBeDefined()
      expect(parsed.user.userId).toBe('user-1')
    })

    it('should export stakeholder ROI as JSON', () => {
      const exported = service.exportROIDashboard(null, 'json', 30)

      expect(exported).toBeDefined()
      const parsed = JSON.parse(exported)
      expect(parsed.stakeholder).toBeDefined()
    })

    it('should export user ROI as CSV', () => {
      const exported = service.exportROIDashboard('user-1', 'csv', 30)

      expect(exported).toBeDefined()
      expect(typeof exported).toBe('string')
      expect(exported).toContain('User ROI Dashboard')
      expect(exported).toContain('Metric,Value')
      expect(exported).toContain('Total Time Saved')
    })

    it('should export stakeholder ROI as CSV', () => {
      const exported = service.exportROIDashboard(null, 'csv', 30)

      expect(exported).toBeDefined()
      expect(typeof exported).toBe('string')
      expect(exported).toContain('Stakeholder ROI Dashboard')
      expect(exported).toContain('Total Users')
    })

    it('should reject PDF format', () => {
      expect(() => {
        service.exportROIDashboard('user-1', 'pdf', 30)
      }).toThrow('PDF export not yet implemented')
    })
  })

  describe('refreshMetrics', () => {
    it('should refresh ROI metrics', () => {
      repo.recordUsageEvent({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
      })

      // Should not throw
      expect(() => {
        service.refreshMetrics()
      }).not.toThrow()

      // Verify metrics were computed using the same frozen time
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      const metrics = repo.getROIMetrics('daily', yesterday.toISOString(), now.toISOString())
      expect(metrics.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Edge Cases', () => {
    it('should handle user with no events', () => {
      const roi = service.getUserROI('nonexistent-user', 30)

      expect(roi!.totalTimeSaved).toBe(0)
      expect(roi!.estimatedValueUsd).toBe(0)
      expect(roi!.topSkills.length).toBe(0)
    })

    it('should handle zero success events', () => {
      repo.recordUsageEvent({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
      })

      const roi = service.getUserROI('user-1', 30)

      expect(roi!.totalTimeSaved).toBe(0)
      expect(roi!.estimatedValueUsd).toBe(0)
    })
  })
})
