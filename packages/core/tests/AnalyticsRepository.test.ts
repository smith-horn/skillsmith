/**
 * AnalyticsRepository Tests
 *
 * Tests for Epic 3 and Epic 4 analytics infrastructure
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { initializeAnalyticsSchema } from '../src/analytics/schema.js'
import { AnalyticsRepository } from '../src/analytics/AnalyticsRepository.js'
import type { UsageEventInput, ExperimentInput, OutcomeInput } from '../src/analytics/types.js'

describe('AnalyticsRepository', () => {
  let db: DatabaseType
  let repo: AnalyticsRepository

  beforeEach(() => {
    db = new Database(':memory:')
    initializeAnalyticsSchema(db)
    repo = new AnalyticsRepository(db)
  })

  afterEach(() => {
    if (db) db.close()
  })

  describe('Usage Events', () => {
    it('should record a usage event', () => {
      const input: UsageEventInput = {
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
        valueScore: 0.8,
      }

      const event = repo.recordUsageEvent(input)

      expect(event.id).toBeDefined()
      expect(event.skillId).toBe('skill-1')
      expect(event.userId).toBe('user-1')
      expect(event.sessionId).toBe('session-1')
      expect(event.eventType).toBe('activation')
      expect(event.valueScore).toBe(0.8)
      expect(event.timestamp).toBeDefined()
    })

    it('should record event with context', () => {
      const input: UsageEventInput = {
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
        context: { action: 'test', details: 'foo' },
        valueScore: 0.9,
      }

      const event = repo.recordUsageEvent(input)

      expect(event.context).toEqual({ action: 'test', details: 'foo' })
    })

    it('should get usage event by ID', () => {
      const input: UsageEventInput = {
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'invocation',
      }

      const created = repo.recordUsageEvent(input)
      const retrieved = repo.getUsageEvent(created.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(created.id)
      expect(retrieved?.skillId).toBe('skill-1')
    })

    it('should get usage events for a skill', () => {
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)

      // Record multiple events
      repo.recordUsageEvent({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
      })
      repo.recordUsageEvent({
        skillId: 'skill-1',
        userId: 'user-2',
        sessionId: 'session-2',
        eventType: 'success',
      })
      repo.recordUsageEvent({
        skillId: 'skill-2',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
      })

      const events = repo.getUsageEventsForSkill(
        'skill-1',
        yesterday.toISOString(),
        tomorrow.toISOString()
      )

      expect(events.length).toBe(2)
      expect(events.every((e) => e.skillId === 'skill-1')).toBe(true)
    })

    it('should get usage events for a user', () => {
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)

      // Record multiple events
      repo.recordUsageEvent({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'activation',
      })
      repo.recordUsageEvent({
        skillId: 'skill-2',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
      })
      repo.recordUsageEvent({
        skillId: 'skill-1',
        userId: 'user-2',
        sessionId: 'session-2',
        eventType: 'activation',
      })

      const events = repo.getUsageEventsForUser(
        'user-1',
        yesterday.toISOString(),
        tomorrow.toISOString()
      )

      expect(events.length).toBe(2)
      expect(events.every((e) => e.userId === 'user-1')).toBe(true)
    })

    it('should cleanup old events', () => {
      // Record events with custom timestamp
      const oldEvent = repo.recordUsageEvent({
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
        oldEvent.id
      )

      // Record recent event
      repo.recordUsageEvent({
        skillId: 'skill-2',
        userId: 'user-2',
        sessionId: 'session-2',
        eventType: 'success',
      })

      // Cleanup with 30-day retention
      const deleted = repo.cleanupOldEvents(30)

      expect(deleted).toBe(1)

      // Verify old event is gone
      const retrieved = repo.getUsageEvent(oldEvent.id)
      expect(retrieved).toBeNull()
    })
  })

  describe('Experiments', () => {
    it('should create an experiment', () => {
      const input: ExperimentInput = {
        name: 'Test Experiment',
        description: 'Testing A/B testing',
        hypothesis: 'Treatment will improve engagement',
        variantA: { feature: 'control' },
        variantB: { feature: 'treatment' },
        targetSampleSize: 100,
      }

      const experiment = repo.createExperiment(input)

      expect(experiment.id).toBeDefined()
      expect(experiment.name).toBe('Test Experiment')
      expect(experiment.description).toBe('Testing A/B testing')
      expect(experiment.hypothesis).toBe('Treatment will improve engagement')
      expect(experiment.status).toBe('draft')
      expect(experiment.variantA).toEqual({ feature: 'control' })
      expect(experiment.variantB).toEqual({ feature: 'treatment' })
      expect(experiment.targetSampleSize).toBe(100)
    })

    it('should get experiment by ID', () => {
      const created = repo.createExperiment({
        name: 'Test',
        variantA: { a: 1 },
        variantB: { b: 2 },
      })

      const retrieved = repo.getExperiment(created.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(created.id)
      expect(retrieved?.name).toBe('Test')
    })

    it('should get experiment by name', () => {
      repo.createExperiment({
        name: 'Unique Name',
        variantA: { a: 1 },
        variantB: { b: 2 },
      })

      const retrieved = repo.getExperimentByName('Unique Name')

      expect(retrieved).toBeDefined()
      expect(retrieved?.name).toBe('Unique Name')
    })

    it('should update experiment status', () => {
      const experiment = repo.createExperiment({
        name: 'Status Test',
        variantA: { a: 1 },
        variantB: { b: 2 },
      })

      const updated = repo.updateExperimentStatus(experiment.id, 'active')
      expect(updated).toBe(true)

      const retrieved = repo.getExperiment(experiment.id)
      expect(retrieved?.status).toBe('active')
    })

    it('should get active experiments', () => {
      // Create experiments with different statuses
      const exp1 = repo.createExperiment({
        name: 'Exp 1',
        variantA: { a: 1 },
        variantB: { b: 2 },
      })
      repo.updateExperimentStatus(exp1.id, 'active')

      repo.createExperiment({
        name: 'Exp 2',
        variantA: { a: 1 },
        variantB: { b: 2 },
      }) // draft

      const exp3 = repo.createExperiment({
        name: 'Exp 3',
        variantA: { a: 1 },
        variantB: { b: 2 },
      })
      repo.updateExperimentStatus(exp3.id, 'active')

      const activeExperiments = repo.getActiveExperiments()

      expect(activeExperiments.length).toBe(2)
      expect(activeExperiments.every((e) => e.status === 'active')).toBe(true)
    })
  })

  describe('Experiment Assignments', () => {
    let experimentId: string

    beforeEach(() => {
      const experiment = repo.createExperiment({
        name: 'Assignment Test',
        variantA: { a: 1 },
        variantB: { b: 2 },
      })
      experimentId = experiment.id
    })

    it('should assign user to experiment', () => {
      const assignment = repo.assignUserToExperiment(experimentId, 'user-1', 'control')

      expect(assignment.id).toBeDefined()
      expect(assignment.experimentId).toBe(experimentId)
      expect(assignment.userId).toBe('user-1')
      expect(assignment.variant).toBe('control')
      expect(assignment.assignedAt).toBeDefined()
    })

    it('should handle duplicate assignments (upsert)', () => {
      const first = repo.assignUserToExperiment(experimentId, 'user-1', 'control')
      const second = repo.assignUserToExperiment(experimentId, 'user-1', 'treatment')

      // Should update the variant
      const retrieved = repo.getUserAssignment(experimentId, 'user-1')
      expect(retrieved?.variant).toBe('treatment')
    })

    it('should get user assignment', () => {
      repo.assignUserToExperiment(experimentId, 'user-1', 'treatment')

      const assignment = repo.getUserAssignment(experimentId, 'user-1')

      expect(assignment).toBeDefined()
      expect(assignment?.userId).toBe('user-1')
      expect(assignment?.variant).toBe('treatment')
    })

    it('should get all assignments for experiment', () => {
      repo.assignUserToExperiment(experimentId, 'user-1', 'control')
      repo.assignUserToExperiment(experimentId, 'user-2', 'treatment')
      repo.assignUserToExperiment(experimentId, 'user-3', 'control')

      const assignments = repo.getExperimentAssignments(experimentId)

      expect(assignments.length).toBe(3)
      expect(assignments.every((a) => a.experimentId === experimentId)).toBe(true)
    })
  })

  describe('Experiment Outcomes', () => {
    let experimentId: string
    let assignmentId: string

    beforeEach(() => {
      const experiment = repo.createExperiment({
        name: 'Outcome Test',
        variantA: { a: 1 },
        variantB: { b: 2 },
      })
      experimentId = experiment.id

      const assignment = repo.assignUserToExperiment(experimentId, 'user-1', 'control')
      assignmentId = assignment.id
    })

    it('should record an outcome', () => {
      const input: OutcomeInput = {
        experimentId,
        assignmentId,
        outcomeType: 'engagement_score',
        outcomeValue: 0.75,
        metadata: { details: 'test' },
      }

      const outcome = repo.recordOutcome(input)

      expect(outcome.id).toBeDefined()
      expect(outcome.experimentId).toBe(experimentId)
      expect(outcome.assignmentId).toBe(assignmentId)
      expect(outcome.outcomeType).toBe('engagement_score')
      expect(outcome.outcomeValue).toBe(0.75)
      expect(outcome.metadata).toEqual({ details: 'test' })
    })

    it('should get outcomes for experiment', () => {
      repo.recordOutcome({
        experimentId,
        assignmentId,
        outcomeType: 'score',
        outcomeValue: 0.5,
      })
      repo.recordOutcome({
        experimentId,
        assignmentId,
        outcomeType: 'clicks',
        outcomeValue: 10,
      })

      const outcomes = repo.getExperimentOutcomes(experimentId)

      expect(outcomes.length).toBe(2)
      expect(outcomes.every((o) => o.experimentId === experimentId)).toBe(true)
    })
  })

  describe('ROI Metrics', () => {
    it('should store ROI metrics', () => {
      const metrics = repo.storeROIMetrics({
        metricType: 'daily',
        periodStart: '2025-01-01',
        periodEnd: '2025-01-02',
        totalActivations: 100,
        totalInvocations: 500,
        totalSuccesses: 450,
        totalFailures: 50,
        avgValueScore: 0.85,
        estimatedTimeSaved: 2250,
        estimatedValueUsd: 4500,
        computedAt: new Date().toISOString(),
      })

      expect(metrics.id).toBeDefined()
      expect(metrics.metricType).toBe('daily')
      expect(metrics.totalActivations).toBe(100)
      expect(metrics.estimatedValueUsd).toBe(4500)
    })

    it('should get ROI metrics for a period', () => {
      repo.storeROIMetrics({
        metricType: 'daily',
        periodStart: '2025-01-01',
        periodEnd: '2025-01-02',
        totalActivations: 100,
        totalInvocations: 500,
        totalSuccesses: 450,
        totalFailures: 50,
        avgValueScore: 0.85,
        estimatedTimeSaved: 2250,
        estimatedValueUsd: 4500,
        computedAt: new Date().toISOString(),
      })

      repo.storeROIMetrics({
        metricType: 'daily',
        periodStart: '2025-01-02',
        periodEnd: '2025-01-03',
        totalActivations: 120,
        totalInvocations: 600,
        totalSuccesses: 550,
        totalFailures: 50,
        avgValueScore: 0.9,
        estimatedTimeSaved: 2750,
        estimatedValueUsd: 5500,
        computedAt: new Date().toISOString(),
      })

      const metrics = repo.getROIMetrics('daily', '2025-01-01', '2025-01-03')

      expect(metrics.length).toBe(2)
      expect(metrics.every((m) => m.metricType === 'daily')).toBe(true)
    })

    it('should get entity-specific ROI metrics', () => {
      repo.storeROIMetrics({
        metricType: 'user',
        entityId: 'user-1',
        periodStart: '2025-01-01',
        periodEnd: '2025-01-02',
        totalActivations: 10,
        totalInvocations: 50,
        totalSuccesses: 45,
        totalFailures: 5,
        avgValueScore: 0.9,
        estimatedTimeSaved: 225,
        estimatedValueUsd: 450,
        computedAt: new Date().toISOString(),
      })

      repo.storeROIMetrics({
        metricType: 'user',
        entityId: 'user-2',
        periodStart: '2025-01-01',
        periodEnd: '2025-01-02',
        totalActivations: 5,
        totalInvocations: 25,
        totalSuccesses: 20,
        totalFailures: 5,
        avgValueScore: 0.8,
        estimatedTimeSaved: 100,
        estimatedValueUsd: 200,
        computedAt: new Date().toISOString(),
      })

      const metrics = repo.getEntityROIMetrics('user-1', '2025-01-01', '2025-01-03')

      expect(metrics.length).toBe(1)
      expect(metrics[0].entityId).toBe('user-1')
    })
  })
})
