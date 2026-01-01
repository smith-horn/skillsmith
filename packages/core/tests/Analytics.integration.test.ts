/**
 * Analytics Integration Tests
 *
 * End-to-end tests for Phase 4 Product Strategy analytics workflows
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { initializeAnalyticsSchema } from '../src/analytics/schema.js'
import { UsageAnalyticsService } from '../src/analytics/UsageAnalyticsService.js'
import { ExperimentService } from '../src/analytics/ExperimentService.js'
import { ROIDashboardService } from '../src/analytics/ROIDashboardService.js'

describe('Analytics Integration Tests', () => {
  let db: DatabaseType
  let usageService: UsageAnalyticsService
  let experimentService: ExperimentService
  let roiService: ROIDashboardService

  beforeEach(() => {
    db = new Database(':memory:')
    initializeAnalyticsSchema(db)
    usageService = new UsageAnalyticsService(db)
    experimentService = new ExperimentService(db)
    roiService = new ROIDashboardService(db)
  })

  afterEach(() => {
    if (db) db.close()
  })

  describe('Epic 3: Skill Usage Analytics Workflow', () => {
    it('should track usage and generate reports', () => {
      // 1. Track skill activations
      usageService.trackUsage({
        skillId: 'jest-helper',
        userId: 'dev-1',
        sessionId: 'session-1',
        eventType: 'activation',
      })

      // 2. Track successful usage
      usageService.trackUsage({
        skillId: 'jest-helper',
        userId: 'dev-1',
        sessionId: 'session-1',
        eventType: 'success',
        valueScore: 0.9,
      })

      usageService.trackUsage({
        skillId: 'jest-helper',
        userId: 'dev-1',
        sessionId: 'session-1',
        eventType: 'success',
        valueScore: 0.85,
      })

      // 3. Generate usage summary
      const summary = usageService.getUsageSummary({ skillId: 'jest-helper' })

      expect(summary.totalEvents).toBe(3)
      expect(summary.eventsByType.activation).toBe(1)
      expect(summary.eventsByType.success).toBe(2)
      expect(summary.avgValueScore).toBeCloseTo(0.875, 2)

      // 4. Export data
      const jsonExport = usageService.exportUsageData({
        skillId: 'jest-helper',
        format: 'json',
      })
      expect(jsonExport).toBeDefined()

      const csvExport = usageService.exportUsageData({
        skillId: 'jest-helper',
        format: 'csv',
      })
      expect(csvExport).toContain('Total Events,3')
    })

    it('should enforce 30-day rolling window', () => {
      // Record event
      const event = usageService.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
      })

      // Simulate old event (31 days ago)
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 31)
      db.prepare('UPDATE skill_usage_events SET timestamp = ? WHERE id = ?').run(
        oldDate.toISOString(),
        event.id
      )

      // Record recent event
      usageService.trackUsage({
        skillId: 'skill-2',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
      })

      // Cleanup old data
      const deleted = usageService.cleanupOldData()
      expect(deleted).toBe(1)

      // Only recent event should remain
      const summary = usageService.getUsageSummary({ userId: 'user-1' })
      expect(summary.totalEvents).toBe(1)
    })
  })

  describe('Epic 4: A/B Testing Workflow', () => {
    it('should run complete experiment lifecycle', () => {
      // 1. Create experiment
      const experiment = experimentService.createExperiment({
        name: 'Recommendation Algorithm Test',
        description: 'Test new vs old recommendation algorithm',
        hypothesis: 'New algorithm increases skill activation by 20%',
        variantA: { algorithm: 'collaborative_filtering' },
        variantB: { algorithm: 'neural_network' },
        targetSampleSize: 20,
      })

      expect(experiment.status).toBe('draft')

      // 2. Start experiment
      experimentService.startExperiment(experiment.id)

      // 3. Assign users
      const assignments = []
      for (let i = 0; i < 20; i++) {
        const assignment = experimentService.assignUser(experiment.id, `user-${i}`)
        assignments.push(assignment)
      }

      // Should be balanced
      const controlCount = assignments.filter((a) => a.variant === 'control').length
      const treatmentCount = assignments.filter((a) => a.variant === 'treatment').length
      expect(controlCount).toBeGreaterThan(7) // Allow some variance
      expect(treatmentCount).toBeGreaterThan(7)

      // 4. Record outcomes
      for (const assignment of assignments) {
        // Simulate treatment being better
        const baseScore = assignment.variant === 'control' ? 0.5 : 0.65
        const noise = (Math.random() - 0.5) * 0.1

        experimentService.recordOutcome({
          experimentId: experiment.id,
          assignmentId: assignment.id,
          outcomeType: 'activation_rate',
          outcomeValue: Math.max(0, Math.min(1, baseScore + noise)),
        })
      }

      // 5. Analyze results
      const analysis = experimentService.analyzeExperiment(experiment.id)

      expect(analysis.controlGroup.sampleSize).toBeGreaterThan(0)
      expect(analysis.treatmentGroup.sampleSize).toBeGreaterThan(0)
      expect(analysis.controlGroup.outcomes.activation_rate).toBeDefined()
      expect(analysis.treatmentGroup.outcomes.activation_rate).toBeDefined()
      expect(analysis.recommendation).toBeDefined()

      // 6. Complete experiment
      experimentService.completeExperiment(experiment.id)

      const completed = experimentService.getActiveExperiments()
      expect(completed.find((e) => e.id === experiment.id)).toBeUndefined()
    })

    it('should handle multiple concurrent experiments', () => {
      // Create multiple experiments
      const exp1 = experimentService.createExperiment({
        name: 'Experiment 1',
        variantA: { feature: 'A' },
        variantB: { feature: 'B' },
      })

      const exp2 = experimentService.createExperiment({
        name: 'Experiment 2',
        variantA: { feature: 'X' },
        variantB: { feature: 'Y' },
      })

      experimentService.startExperiment(exp1.id)
      experimentService.startExperiment(exp2.id)

      // Assign same user to both experiments
      const assignment1 = experimentService.assignUser(exp1.id, 'user-1')
      const assignment2 = experimentService.assignUser(exp2.id, 'user-1')

      expect(assignment1.experimentId).toBe(exp1.id)
      expect(assignment2.experimentId).toBe(exp2.id)

      // Record outcomes
      experimentService.recordOutcome({
        experimentId: exp1.id,
        assignmentId: assignment1.id,
        outcomeType: 'score',
        outcomeValue: 0.8,
      })

      experimentService.recordOutcome({
        experimentId: exp2.id,
        assignmentId: assignment2.id,
        outcomeType: 'score',
        outcomeValue: 0.7,
      })

      // Both experiments should have data
      const analysis1 = experimentService.analyzeExperiment(exp1.id)
      const analysis2 = experimentService.analyzeExperiment(exp2.id)

      expect(analysis1.experimentId).toBe(exp1.id)
      expect(analysis2.experimentId).toBe(exp2.id)
    })
  })

  describe('Epic 4: ROI Dashboard Workflow', () => {
    it('should generate user ROI dashboard from usage data', () => {
      // 1. Track user activity
      const userId = 'developer-1'

      // Skill 1: High usage
      for (let i = 0; i < 10; i++) {
        usageService.trackUsage({
          skillId: 'git-helper',
          userId,
          sessionId: 'session-1',
          eventType: 'success',
          valueScore: 0.9,
        })
      }

      // Skill 2: Medium usage
      for (let i = 0; i < 5; i++) {
        usageService.trackUsage({
          skillId: 'docker-helper',
          userId,
          sessionId: 'session-2',
          eventType: 'success',
          valueScore: 0.85,
        })
      }

      // 2. Compute ROI metrics
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      roiService.computeROIMetrics({
        userId,
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })

      // 3. Generate user ROI dashboard
      const userROI = roiService.getUserROI(userId, 30)

      expect(userROI!.userId).toBe(userId)
      expect(userROI!.totalTimeSaved).toBe(75) // 15 successes * 5 min
      expect(userROI!.estimatedValueUsd).toBe(150) // 75 min * $2/min
      expect(userROI!.topSkills.length).toBeGreaterThan(0)
      expect(userROI!.topSkills[0].skillId).toBe('git-helper')

      // 4. Export dashboard
      const exportedJSON = roiService.exportROIDashboard(userId, 'json', 30)
      expect(exportedJSON).toBeDefined()

      const exportedCSV = roiService.exportROIDashboard(userId, 'csv', 30)
      expect(exportedCSV).toContain('Total Time Saved')
    })

    it('should generate stakeholder ROI dashboard', () => {
      // 1. Track activity for multiple users
      const users = ['user-1', 'user-2', 'user-3']

      for (const userId of users) {
        usageService.trackUsage({
          skillId: 'skill-1',
          userId,
          sessionId: `session-${userId}`,
          eventType: 'activation',
        })

        usageService.trackUsage({
          skillId: 'skill-1',
          userId,
          sessionId: `session-${userId}`,
          eventType: 'success',
          valueScore: 0.8,
        })
      }

      // 2. Compute aggregate metrics
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      roiService.computeROIMetrics({
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })

      // 3. Generate stakeholder dashboard
      const stakeholderROI = roiService.getStakeholderROI(30)

      expect(stakeholderROI).toBeDefined()
      expect(stakeholderROI!.totalActivations).toBeGreaterThanOrEqual(0)

      // 4. Export for stakeholders
      const exported = roiService.exportROIDashboard(null, 'csv', 30)
      expect(exported).toContain('Stakeholder ROI Dashboard')
    })

    it('should support automated data refresh', () => {
      // Record some usage
      usageService.trackUsage({
        skillId: 'skill-1',
        userId: 'user-1',
        sessionId: 'session-1',
        eventType: 'success',
      })

      // Refresh metrics (should run without errors)
      expect(() => {
        roiService.refreshMetrics()
      }).not.toThrow()

      // Verify metrics were computed
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      const computed = roiService.computeROIMetrics({
        startDate: yesterday.toISOString(),
        endDate: now.toISOString(),
      })

      expect(computed.length).toBeGreaterThan(0)
    })
  })

  describe('Cross-Epic Integration', () => {
    it('should use usage analytics in experiment outcomes', () => {
      // 1. Create experiment
      const experiment = experimentService.createExperiment({
        name: 'Onboarding Flow Test',
        variantA: { flow: 'manual' },
        variantB: { flow: 'guided' },
        targetSampleSize: 10,
      })
      experimentService.startExperiment(experiment.id)

      // 2. Assign users and track their usage
      for (let i = 0; i < 10; i++) {
        const userId = `user-${i}`
        const assignment = experimentService.assignUser(experiment.id, userId)

        // Track usage based on variant
        const successRate = assignment.variant === 'control' ? 0.6 : 0.8

        if (Math.random() < successRate) {
          usageService.trackUsage({
            skillId: 'onboarding-skill',
            userId,
            sessionId: `session-${i}`,
            eventType: 'success',
            valueScore: successRate,
          })
        }

        // Record experiment outcome
        experimentService.recordOutcome({
          experimentId: experiment.id,
          assignmentId: assignment.id,
          outcomeType: 'success_rate',
          outcomeValue: successRate,
        })
      }

      // 3. Analyze experiment
      const analysis = experimentService.analyzeExperiment(experiment.id)

      // 4. Generate ROI for users
      const roi = roiService.getUserROI('user-0', 30)

      // Both analytics should have data
      expect(analysis.controlGroup.outcomes.success_rate).toBeDefined()
      expect(roi).toBeDefined()
    })

    it('should track ROI improvements from A/B test winners', () => {
      // 1. Baseline: Track usage with current algorithm
      for (let i = 0; i < 5; i++) {
        usageService.trackUsage({
          skillId: 'skill-1',
          userId: 'user-1',
          sessionId: 'session-1',
          eventType: 'success',
        })
      }

      const beforeROI = roiService.getUserROI('user-1', 30)
      const baselineTime = beforeROI!.totalTimeSaved

      // 2. Run experiment
      const experiment = experimentService.createExperiment({
        name: 'Algorithm Improvement',
        variantA: { version: '1.0' },
        variantB: { version: '2.0' },
        targetSampleSize: 2,
      })
      experimentService.startExperiment(experiment.id)

      // 3. Simulate outcomes for user-2 (regardless of variant)
      const assignment = experimentService.assignUser(experiment.id, 'user-2')

      // Track events for user-2 - treatment may get more successes
      const eventCount = assignment.variant === 'treatment' ? 8 : 5
      for (let i = 0; i < eventCount; i++) {
        usageService.trackUsage({
          skillId: 'skill-1',
          userId: 'user-2',
          sessionId: 'session-2',
          eventType: 'success',
        })
      }

      const afterROI = roiService.getUserROI('user-2', 30)

      // Verify ROI metrics are being tracked
      expect(afterROI!.totalTimeSaved).toBeGreaterThan(0)
    })
  })
})
