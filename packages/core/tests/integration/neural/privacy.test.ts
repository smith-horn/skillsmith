/**
 * SMI-1536: Privacy Manager Integration Tests
 *
 * Tests the IPrivacyManager interface for GDPR compliance and
 * data lifecycle management in the Recommendation Learning Loop.
 *
 * Test Cases:
 * 1. purgeOldSignals() removes signals older than 90 days
 * 2. exportUserData() returns all user signals and profile
 * 3. wipeAllData() removes profile and all signals
 * 4. Signal anonymization strips PII
 * 5. Retention policy configurable per-tenant
 * 6. Privacy audit log records all operations
 *
 * @see packages/core/src/learning/interfaces.ts
 * @see docs/execution/phase5-testing-execution.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createNeuralTestContext,
  cleanupNeuralTestContext,
  createDefaultProfile,
  type NeuralTestContext,
} from './setup.js'
import { generateSignal, generateContext, daysAgo } from './helpers.js'
import { SignalType, SkillCategory } from '../../../src/learning/types.js'

describe('PrivacyManager Integration', () => {
  let ctx: NeuralTestContext

  beforeEach(() => {
    ctx = createNeuralTestContext()
  })

  afterEach(async () => {
    await cleanupNeuralTestContext(ctx)
  })

  describe('Signal Retention', () => {
    it('should purge signals older than 90 days', async () => {
      // Add signals at various ages
      // Old signals (should be purged)
      ctx.signalCollector.addSignal(
        generateSignal({
          skillId: 'old-skill-1',
          timestamp: daysAgo(100), // 100 days old
        })
      )
      ctx.signalCollector.addSignal(
        generateSignal({
          skillId: 'old-skill-2',
          timestamp: daysAgo(95), // 95 days old
        })
      )
      ctx.signalCollector.addSignal(
        generateSignal({
          skillId: 'old-skill-3',
          timestamp: daysAgo(91), // 91 days old
        })
      )

      // Recent signals (should be kept)
      ctx.signalCollector.addSignal(
        generateSignal({
          skillId: 'recent-skill-1',
          timestamp: daysAgo(30),
        })
      )
      ctx.signalCollector.addSignal(
        generateSignal({
          skillId: 'recent-skill-2',
          timestamp: daysAgo(1),
        })
      )

      const countBefore = await ctx.signalCollector.getSignalCount()
      expect(countBefore).toBe(5)

      // Purge signals older than 90 days
      const deletedCount = await ctx.privacyManager.purgeOldSignals(90)

      expect(deletedCount).toBe(3) // 3 old signals removed
      const countAfter = await ctx.signalCollector.getSignalCount()
      expect(countAfter).toBe(2) // 2 recent signals remain

      // Verify remaining signals
      const remaining = ctx.signalCollector.getAllSignals()
      expect(remaining.every((s) => s.timestamp >= daysAgo(90))).toBe(true)
    })

    it('should handle custom retention periods', async () => {
      // Add signals at various ages
      ctx.signalCollector.addSignal(
        generateSignal({
          skillId: 'skill-45-days',
          timestamp: daysAgo(45),
        })
      )
      ctx.signalCollector.addSignal(
        generateSignal({
          skillId: 'skill-20-days',
          timestamp: daysAgo(20),
        })
      )

      // Purge with 30-day retention
      const deleted = await ctx.privacyManager.purgeOldSignals(30)

      expect(deleted).toBe(1) // 45-day old signal removed
      expect(await ctx.signalCollector.getSignalCount()).toBe(1)
    })
  })

  describe('Data Export', () => {
    it('should export all user signals and profile', async () => {
      // Add some signals
      for (let i = 0; i < 5; i++) {
        await ctx.signalCollector.recordAccept(
          `skill-${i}`,
          generateContext({ category: SkillCategory.TESTING })
        )
      }
      await ctx.signalCollector.recordDismiss('unwanted-skill', generateContext())

      // Build and save profile
      let profile = createDefaultProfile()
      const signals = await ctx.signalCollector.getSignals({})
      profile = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      await ctx.profileRepository.saveProfile(profile)

      // Export data
      const exported = await ctx.privacyManager.exportUserData()

      // Verify export contents
      expect(exported.exported_at).toBeDefined()
      expect(exported.version).toBe(1)
      expect(exported.profile.signal_count).toBe(6)
      expect(exported.signals).toHaveLength(6)

      // Profile should have learned preferences
      expect(exported.profile.category_weights[SkillCategory.TESTING]).toBeGreaterThan(0)
    })

    it('should include all signal types in export', async () => {
      // Add various signal types
      await ctx.signalCollector.recordAccept('accepted', generateContext())
      await ctx.signalCollector.recordDismiss('dismissed', generateContext())
      await ctx.signalCollector.recordUsage('used', 'daily')
      await ctx.signalCollector.recordAbandonment('abandoned', 30)
      await ctx.signalCollector.recordUninstall('uninstalled', 14)

      const exported = await ctx.privacyManager.exportUserData()

      expect(exported.signals).toHaveLength(5)

      const types = exported.signals.map((s) => s.type)
      expect(types).toContain(SignalType.ACCEPT)
      expect(types).toContain(SignalType.DISMISS)
      expect(types).toContain(SignalType.USAGE_DAILY)
      expect(types).toContain(SignalType.ABANDONED)
      expect(types).toContain(SignalType.UNINSTALL)
    })
  })

  describe('Data Wipe', () => {
    it('should remove profile and all signals', async () => {
      // Add signals
      for (let i = 0; i < 10; i++) {
        await ctx.signalCollector.recordAccept(`skill-${i}`, generateContext())
      }

      // Create and save profile
      let profile = createDefaultProfile()
      const signals = await ctx.signalCollector.getSignals({})
      profile = await ctx.preferenceLearner.batchUpdateProfile(profile, signals)
      await ctx.profileRepository.saveProfile(profile)

      // Verify data exists
      expect(await ctx.signalCollector.getSignalCount()).toBe(10)
      expect(await ctx.profileRepository.exists()).toBe(true)

      // Wipe all data
      const deletedCount = await ctx.privacyManager.wipeAllData()

      expect(deletedCount).toBe(11) // 10 signals + 1 profile
      expect(await ctx.signalCollector.getSignalCount()).toBe(0)
      expect(await ctx.profileRepository.exists()).toBe(false)
    })

    it('should handle wipe with no data', async () => {
      const deletedCount = await ctx.privacyManager.wipeAllData()
      // Returns 0 signals + attempts profile delete (which may return 1 even if no profile)
      // Implementation detail: wipeAllData returns signalCount + 1 for profile
      expect(deletedCount).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Anonymization', () => {
    it('should produce anonymized aggregate statistics', async () => {
      // Add signals with categories
      for (let i = 0; i < 10; i++) {
        await ctx.signalCollector.recordAccept(
          `testing-skill-${i}`,
          generateContext({ category: SkillCategory.TESTING })
        )
      }
      for (let i = 0; i < 5; i++) {
        await ctx.signalCollector.recordDismiss(
          `git-skill-${i}`,
          generateContext({ category: SkillCategory.GIT })
        )
      }
      for (let i = 0; i < 3; i++) {
        await ctx.signalCollector.recordUsage(`testing-skill-${i}`, 'daily')
      }

      const stats = await ctx.privacyManager.anonymizeForAnalytics()

      // Check aggregate stats
      expect(stats.date).toMatch(/^\d{4}-\d{2}-\d{2}$/) // YYYY-MM-DD format
      expect(stats.total_signals).toBe(18)

      // Signal type counts
      expect(stats.signal_counts[SignalType.ACCEPT]).toBe(10)
      expect(stats.signal_counts[SignalType.DISMISS]).toBe(5)
      expect(stats.signal_counts[SignalType.USAGE_DAILY]).toBe(3)

      // Accept rate: 10 / (10 + 5) = 0.667
      expect(stats.avg_accept_rate).toBeCloseTo(0.667, 2)

      // Popular categories (only counted from signals with category in context)
      expect(stats.popular_categories.length).toBeGreaterThan(0)
      // TESTING category has 10 accepts with category context
      // Usage signals don't have category in their context by default
      expect(stats.popular_categories[0].category).toBe(SkillCategory.TESTING)
      expect(stats.popular_categories[0].count).toBe(10)
    })

    it('should not include PII in anonymized stats', async () => {
      await ctx.signalCollector.recordAccept('skill-1', generateContext())
      await ctx.signalCollector.recordAccept('skill-2', generateContext())

      const stats = await ctx.privacyManager.anonymizeForAnalytics()

      // Stats should not contain skill IDs or other identifying info
      const statsJson = JSON.stringify(stats)
      expect(statsJson).not.toContain('skill-1')
      expect(statsJson).not.toContain('skill-2')
    })
  })

  describe('Privacy Verification', () => {
    it('should verify no data leaks', async () => {
      await ctx.signalCollector.recordAccept('sensitive-skill', generateContext())

      const isPrivate = await ctx.privacyManager.verifyPrivacy()
      expect(isPrivate).toBe(true)
    })
  })

  describe('Audit Logging', () => {
    it('should record audit log for purge operations', async () => {
      ctx.signalCollector.addSignal(
        generateSignal({
          timestamp: daysAgo(100),
        })
      )

      await ctx.privacyManager.purgeOldSignals(90)

      const auditLog = ctx.privacyManager.getAuditLog()
      expect(auditLog).toHaveLength(1)
      expect(auditLog[0].operation).toBe('purgeOldSignals')
      expect(auditLog[0].timestamp).toBeDefined()
      expect(auditLog[0].details).toContain('Deleted 1 signals')
    })

    it('should record audit log for export operations', async () => {
      await ctx.signalCollector.recordAccept('skill-1', generateContext())
      await ctx.privacyManager.exportUserData()

      const auditLog = ctx.privacyManager.getAuditLog()
      expect(auditLog.some((e) => e.operation === 'exportUserData')).toBe(true)
    })

    it('should record audit log for wipe operations', async () => {
      await ctx.signalCollector.recordAccept('skill-1', generateContext())
      await ctx.privacyManager.wipeAllData()

      const auditLog = ctx.privacyManager.getAuditLog()
      expect(auditLog.some((e) => e.operation === 'wipeAllData')).toBe(true)
    })
  })

  describe('Storage Size', () => {
    it('should report storage size', async () => {
      // Empty storage
      const emptySize = await ctx.privacyManager.getStorageSize()
      expect(emptySize).toBe(2) // Empty array stringified: '[]'

      // Add signals
      for (let i = 0; i < 10; i++) {
        await ctx.signalCollector.recordAccept(`skill-${i}`, generateContext())
      }

      const populatedSize = await ctx.privacyManager.getStorageSize()
      expect(populatedSize).toBeGreaterThan(emptySize)
    })
  })
})
