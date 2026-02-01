/**
 * SMI-915: MetricsAggregator Tests
 *
 * Tests for skill metrics aggregation functionality including:
 * - Per-skill metrics
 * - Global metrics
 * - Time-period filtering
 * - Retention rate calculation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseSync } from '../../src/db/createDatabase.js'
import type { Database } from '../../src/db/database-interface.js'
import { MetricsAggregator } from '../../src/analytics/metrics-aggregator.js'
import type { AggregationPeriod } from '../../src/analytics/metrics-aggregator.js'
import type { SkillUsageOutcome } from '../../src/analytics/types.js'

describe('MetricsAggregator', () => {
  let db: Database
  let aggregator: MetricsAggregator

  // Helper to insert test events
  function insertEvent(
    skillId: string,
    userId: string,
    timestamp: number,
    taskDuration: number,
    outcome: SkillUsageOutcome,
    contextHash: string = 'test-context'
  ): void {
    db.prepare(
      `
      INSERT INTO usage_events (skill_id, user_id, timestamp, task_duration, outcome, context_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(skillId, userId, timestamp, taskDuration, outcome, contextHash)
  }

  beforeEach(() => {
    // Create in-memory database with schema
    db = createDatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        task_duration INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'error', 'abandoned')),
        context_hash TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );
      CREATE INDEX idx_skill_id ON usage_events(skill_id);
      CREATE INDEX idx_timestamp ON usage_events(timestamp);
      CREATE INDEX idx_user_id ON usage_events(user_id);
      CREATE INDEX idx_outcome ON usage_events(outcome);
    `)
    aggregator = new MetricsAggregator(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('getSkillMetrics', () => {
    it('should return zero metrics for non-existent skill', () => {
      const metrics = aggregator.getSkillMetrics('non-existent/skill')

      expect(metrics.skillId).toBe('non-existent/skill')
      expect(metrics.totalInvocations).toBe(0)
      expect(metrics.successRate).toBe(0)
      expect(metrics.avgTaskDuration).toBe(0)
      expect(metrics.uniqueUsers).toBe(0)
      expect(metrics.lastUsed).toBe(0)
    })

    it('should aggregate metrics for a skill with events', () => {
      const now = Date.now()

      // Insert test events
      insertEvent('anthropic/commit', 'user-1', now - 1000, 500, 'success')
      insertEvent('anthropic/commit', 'user-1', now - 2000, 600, 'success')
      insertEvent('anthropic/commit', 'user-2', now - 3000, 400, 'error')

      const metrics = aggregator.getSkillMetrics('anthropic/commit')

      expect(metrics.skillId).toBe('anthropic/commit')
      expect(metrics.totalInvocations).toBe(3)
      expect(metrics.successRate).toBeCloseTo(2 / 3, 2)
      expect(metrics.avgTaskDuration).toBe(500) // (500 + 600 + 400) / 3
      expect(metrics.uniqueUsers).toBe(2)
      expect(metrics.lastUsed).toBe(now - 1000)
    })

    it('should filter by time period', () => {
      const now = Date.now()
      const oneDay = 24 * 60 * 60 * 1000

      // Events: 2 today, 1 yesterday
      insertEvent('test/skill', 'user-1', now - 1000, 500, 'success')
      insertEvent('test/skill', 'user-2', now - 2000, 600, 'success')
      insertEvent('test/skill', 'user-3', now - oneDay - 1000, 700, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const metrics = aggregator.getSkillMetrics('test/skill', period)

      expect(metrics.totalInvocations).toBe(2)
      expect(metrics.uniqueUsers).toBe(2)
    })

    it('should calculate 100% success rate correctly', () => {
      const now = Date.now()

      insertEvent('perfect/skill', 'user-1', now - 1000, 100, 'success')
      insertEvent('perfect/skill', 'user-2', now - 2000, 200, 'success')

      const metrics = aggregator.getSkillMetrics('perfect/skill')

      expect(metrics.successRate).toBe(1)
    })

    it('should calculate 0% success rate correctly', () => {
      const now = Date.now()

      insertEvent('failing/skill', 'user-1', now - 1000, 100, 'error')
      insertEvent('failing/skill', 'user-2', now - 2000, 200, 'abandoned')

      const metrics = aggregator.getSkillMetrics('failing/skill')

      expect(metrics.successRate).toBe(0)
    })
  })

  describe('getAllSkillMetrics', () => {
    it('should return empty array when no events exist', () => {
      const allMetrics = aggregator.getAllSkillMetrics()
      expect(allMetrics).toEqual([])
    })

    it('should return metrics for all skills', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')
      insertEvent('skill-2', 'user-1', now - 2000, 200, 'success')
      insertEvent('skill-3', 'user-2', now - 3000, 300, 'error')

      const allMetrics = aggregator.getAllSkillMetrics()

      expect(allMetrics).toHaveLength(3)
      expect(allMetrics.map((m) => m.skillId).sort()).toEqual(['skill-1', 'skill-2', 'skill-3'])
    })

    it('should filter by time period', () => {
      const now = Date.now()
      const oneDay = 24 * 60 * 60 * 1000

      insertEvent('recent-skill', 'user-1', now - 1000, 100, 'success')
      insertEvent('old-skill', 'user-1', now - oneDay - 1000, 200, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const allMetrics = aggregator.getAllSkillMetrics(period)

      expect(allMetrics).toHaveLength(1)
      expect(allMetrics[0].skillId).toBe('recent-skill')
    })
  })

  describe('getGlobalMetrics', () => {
    it('should return zero metrics when no events exist', () => {
      const global = aggregator.getGlobalMetrics()

      expect(global.totalInvocations).toBe(0)
      expect(global.uniqueUsers).toBe(0)
      expect(global.overallSuccessRate).toBe(0)
      expect(global.avgTaskDuration).toBe(0)
      expect(global.topSkills).toEqual([])
    })

    it('should aggregate global metrics across all skills', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')
      insertEvent('skill-1', 'user-2', now - 2000, 200, 'success')
      insertEvent('skill-2', 'user-1', now - 3000, 300, 'error')
      insertEvent('skill-2', 'user-3', now - 4000, 400, 'success')

      const global = aggregator.getGlobalMetrics()

      expect(global.totalInvocations).toBe(4)
      expect(global.uniqueUsers).toBe(3)
      expect(global.overallSuccessRate).toBeCloseTo(0.75, 2)
      expect(global.avgTaskDuration).toBe(250) // (100 + 200 + 300 + 400) / 4
    })

    it('should return top skills ordered by invocation count', () => {
      const now = Date.now()

      // skill-1: 3 invocations
      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')
      insertEvent('skill-1', 'user-1', now - 2000, 100, 'success')
      insertEvent('skill-1', 'user-1', now - 3000, 100, 'success')

      // skill-2: 2 invocations
      insertEvent('skill-2', 'user-1', now - 4000, 100, 'success')
      insertEvent('skill-2', 'user-1', now - 5000, 100, 'success')

      // skill-3: 1 invocation
      insertEvent('skill-3', 'user-1', now - 6000, 100, 'success')

      const global = aggregator.getGlobalMetrics()

      expect(global.topSkills).toHaveLength(3)
      expect(global.topSkills[0]).toEqual({ skillId: 'skill-1', invocations: 3 })
      expect(global.topSkills[1]).toEqual({ skillId: 'skill-2', invocations: 2 })
      expect(global.topSkills[2]).toEqual({ skillId: 'skill-3', invocations: 1 })
    })

    it('should limit top skills to 10', () => {
      const now = Date.now()

      // Create 12 different skills
      for (let i = 1; i <= 12; i++) {
        insertEvent(`skill-${i}`, 'user-1', now - i * 1000, 100, 'success')
      }

      const global = aggregator.getGlobalMetrics()

      expect(global.topSkills).toHaveLength(10)
    })

    it('should filter by time period', () => {
      const now = Date.now()
      const oneDay = 24 * 60 * 60 * 1000

      insertEvent('recent-skill', 'user-1', now - 1000, 100, 'success')
      insertEvent('old-skill', 'user-1', now - oneDay - 1000, 200, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const global = aggregator.getGlobalMetrics(period)

      expect(global.totalInvocations).toBe(1)
      expect(global.topSkills).toHaveLength(1)
      expect(global.topSkills[0].skillId).toBe('recent-skill')
    })
  })

  describe('getRetentionRate', () => {
    it('should return 0 when no early users exist', () => {
      const rate = aggregator.getRetentionRate('test/skill', 7)
      expect(rate).toBe(0)
    })

    it('should return 0 when no users return', () => {
      const now = Date.now()
      const tenDays = 10 * 24 * 60 * 60 * 1000

      // User used skill 10 days ago but never returned
      insertEvent('test/skill', 'user-1', now - tenDays, 100, 'success')

      const rate = aggregator.getRetentionRate('test/skill', 7)

      expect(rate).toBe(0)
    })

    it('should calculate retention rate correctly', () => {
      const now = Date.now()
      const tenDays = 10 * 24 * 60 * 60 * 1000
      const fiveDays = 5 * 24 * 60 * 60 * 1000
      const oneDay = 24 * 60 * 60 * 1000

      // user-1: used 10 days ago, returned 5 days ago (retained)
      insertEvent('test/skill', 'user-1', now - tenDays, 100, 'success')
      insertEvent('test/skill', 'user-1', now - fiveDays, 100, 'success')

      // user-2: used 10 days ago, never returned (not retained)
      insertEvent('test/skill', 'user-2', now - tenDays, 100, 'success')

      // user-3: used 10 days ago, returned yesterday (retained)
      insertEvent('test/skill', 'user-3', now - tenDays, 100, 'success')
      insertEvent('test/skill', 'user-3', now - oneDay, 100, 'success')

      // 2 out of 3 early users returned
      const rate = aggregator.getRetentionRate('test/skill', 7)

      expect(rate).toBeCloseTo(2 / 3, 2)
    })

    it('should return 1 when all users return', () => {
      const now = Date.now()
      const tenDays = 10 * 24 * 60 * 60 * 1000
      const oneDay = 24 * 60 * 60 * 1000

      insertEvent('test/skill', 'user-1', now - tenDays, 100, 'success')
      insertEvent('test/skill', 'user-1', now - oneDay, 100, 'success')

      insertEvent('test/skill', 'user-2', now - tenDays, 100, 'success')
      insertEvent('test/skill', 'user-2', now - oneDay, 100, 'success')

      const rate = aggregator.getRetentionRate('test/skill', 7)

      expect(rate).toBe(1)
    })
  })

  describe('getActiveSkills', () => {
    it('should return empty array when no events in period', () => {
      const now = Date.now()
      const period: AggregationPeriod = {
        start: now - 1000,
        end: now,
      }

      const activeSkills = aggregator.getActiveSkills(period)

      expect(activeSkills).toEqual([])
    })

    it('should return skills with events in period', () => {
      const now = Date.now()

      insertEvent('skill-a', 'user-1', now - 1000, 100, 'success')
      insertEvent('skill-b', 'user-1', now - 2000, 100, 'success')
      insertEvent('skill-c', 'user-1', now - 3000, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 5000,
        end: now,
      }

      const activeSkills = aggregator.getActiveSkills(period)

      expect(activeSkills.sort()).toEqual(['skill-a', 'skill-b', 'skill-c'])
    })
  })

  describe('getDataRange', () => {
    it('should return null when no events exist', () => {
      const range = aggregator.getDataRange()
      expect(range).toBeNull()
    })

    it('should return min and max timestamps', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 3000, 100, 'success')
      insertEvent('skill-1', 'user-1', now - 2000, 100, 'success')
      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')

      const range = aggregator.getDataRange()

      expect(range).not.toBeNull()
      expect(range!.minTimestamp).toBe(now - 3000)
      expect(range!.maxTimestamp).toBe(now - 1000)
    })
  })
})
