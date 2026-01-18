/**
 * SMI-1535: Signal Collection Integration Tests
 *
 * Tests the ISignalCollector interface for recording and querying
 * user interaction signals in the Recommendation Learning Loop.
 *
 * Test Cases:
 * 1. Record ACCEPT signal with skill metadata
 * 2. Record DISMISS signal with reason
 * 3. Record USAGE_DAILY signal
 * 4. Record USAGE_WEEKLY signal
 * 5. Record ABANDONED signal after 30 days
 * 6. Record UNINSTALL signal
 * 7. Query signals by type filter
 * 8. Query signals by date range
 *
 * @see packages/core/src/learning/interfaces.ts
 * @see docs/execution/phase5-testing-execution.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createNeuralTestContext,
  cleanupNeuralTestContext,
  type NeuralTestContext,
} from './setup.js'
import { generateContext, generateMetadata, daysAgo, hoursAgo } from './helpers.js'
import { SignalType, DismissReason, SkillCategory } from '../../../src/learning/types.js'

describe('SignalCollector Integration', () => {
  let ctx: NeuralTestContext

  beforeEach(() => {
    ctx = createNeuralTestContext()
  })

  afterEach(async () => {
    await cleanupNeuralTestContext(ctx)
  })

  describe('Recording Signals', () => {
    it('should record ACCEPT signal with skill metadata', async () => {
      const skillId = 'anthropic/commit-helper'
      const context = generateContext({
        installedSkills: ['anthropic/review-pr', 'community/jest-runner'],
        originalScore: 0.92,
        category: SkillCategory.GIT,
        trustTier: 'verified',
      })
      const metadata = generateMetadata({
        timeToAction: 3500,
        suggestionCount: 1,
      })

      await ctx.signalCollector.recordAccept(skillId, context, metadata)

      const signals = await ctx.signalCollector.getSignals({})
      expect(signals).toHaveLength(1)

      const signal = signals[0]
      expect(signal.type).toBe(SignalType.ACCEPT)
      expect(signal.skill_id).toBe(skillId)
      expect(signal.context.installed_skills).toEqual(context.installed_skills)
      expect(signal.context.original_score).toBe(0.92)
      expect(signal.context.category).toBe(SkillCategory.GIT)
      expect(signal.context.trust_tier).toBe('verified')
      expect(signal.metadata?.time_to_action).toBe(3500)
      expect(signal.metadata?.suggestion_count).toBe(1)
      expect(signal.id).toBeDefined()
      expect(signal.timestamp).toBeDefined()
    })

    it('should record DISMISS signal with reason', async () => {
      const skillId = 'community/complex-helper'
      const context = generateContext({
        originalScore: 0.65,
        category: SkillCategory.PRODUCTIVITY,
        trustTier: 'community',
      })

      await ctx.signalCollector.recordDismiss(skillId, context, DismissReason.TOO_COMPLEX)

      const signals = await ctx.signalCollector.getSignals({})
      expect(signals).toHaveLength(1)

      const signal = signals[0]
      expect(signal.type).toBe(SignalType.DISMISS)
      expect(signal.skill_id).toBe(skillId)
      expect(signal.dismiss_reason).toBe(DismissReason.TOO_COMPLEX)
      expect(signal.context.category).toBe(SkillCategory.PRODUCTIVITY)
    })

    it('should record USAGE_DAILY signal', async () => {
      const skillId = 'anthropic/review-pr'

      await ctx.signalCollector.recordUsage(skillId, 'daily')

      const signals = await ctx.signalCollector.getSignals({})
      expect(signals).toHaveLength(1)

      const signal = signals[0]
      expect(signal.type).toBe(SignalType.USAGE_DAILY)
      expect(signal.skill_id).toBe(skillId)
    })

    it('should record USAGE_WEEKLY signal', async () => {
      const skillId = 'community/doc-generator'

      await ctx.signalCollector.recordUsage(skillId, 'weekly')

      const signals = await ctx.signalCollector.getSignals({})
      expect(signals).toHaveLength(1)

      const signal = signals[0]
      expect(signal.type).toBe(SignalType.USAGE_WEEKLY)
      expect(signal.skill_id).toBe(skillId)
    })

    it('should record ABANDONED signal after 30 days', async () => {
      const skillId = 'experimental/unused-tool'
      const daysSinceInstall = 35

      await ctx.signalCollector.recordAbandonment(skillId, daysSinceInstall)

      const signals = await ctx.signalCollector.getSignals({})
      expect(signals).toHaveLength(1)

      const signal = signals[0]
      expect(signal.type).toBe(SignalType.ABANDONED)
      expect(signal.skill_id).toBe(skillId)
      expect(signal.metadata?.extra?.days_since_install).toBe(35)
    })

    it('should record UNINSTALL signal', async () => {
      const skillId = 'community/unwanted-helper'
      const daysSinceInstall = 14

      await ctx.signalCollector.recordUninstall(skillId, daysSinceInstall)

      const signals = await ctx.signalCollector.getSignals({})
      expect(signals).toHaveLength(1)

      const signal = signals[0]
      expect(signal.type).toBe(SignalType.UNINSTALL)
      expect(signal.skill_id).toBe(skillId)
      expect(signal.metadata?.extra?.days_since_install).toBe(14)
    })
  })

  describe('Querying Signals', () => {
    beforeEach(async () => {
      // Seed with various signal types
      const gitContext = generateContext({ category: SkillCategory.GIT })
      const testContext = generateContext({ category: SkillCategory.TESTING })

      await ctx.signalCollector.recordAccept('skill-1', gitContext)
      await ctx.signalCollector.recordAccept('skill-2', testContext)
      await ctx.signalCollector.recordDismiss('skill-3', gitContext, DismissReason.NOT_RELEVANT)
      await ctx.signalCollector.recordUsage('skill-1', 'daily')
      await ctx.signalCollector.recordUsage('skill-2', 'weekly')
      await ctx.signalCollector.recordUninstall('skill-4', 10)
    })

    it('should query signals by type filter', async () => {
      // Query single type
      const acceptSignals = await ctx.signalCollector.getSignals({
        type: SignalType.ACCEPT,
      })
      expect(acceptSignals).toHaveLength(2)
      expect(acceptSignals.every((s) => s.type === SignalType.ACCEPT)).toBe(true)

      // Query multiple types
      const usageSignals = await ctx.signalCollector.getSignals({
        type: [SignalType.USAGE_DAILY, SignalType.USAGE_WEEKLY],
      })
      expect(usageSignals).toHaveLength(2)
      expect(
        usageSignals.every(
          (s) => s.type === SignalType.USAGE_DAILY || s.type === SignalType.USAGE_WEEKLY
        )
      ).toBe(true)

      // Query dismiss only
      const dismissSignals = await ctx.signalCollector.getSignals({
        type: SignalType.DISMISS,
      })
      expect(dismissSignals).toHaveLength(1)
      expect(dismissSignals[0].dismiss_reason).toBe(DismissReason.NOT_RELEVANT)
    })

    it('should query signals by date range', async () => {
      // Add signals with specific timestamps for time-based testing
      ctx.signalCollector.clear()

      // Signal from 2 days ago
      ctx.signalCollector.addSignal({
        id: 'old-signal-1',
        type: SignalType.ACCEPT,
        skill_id: 'old-skill',
        timestamp: daysAgo(2),
        context: generateContext(),
      })

      // Signal from 1 hour ago
      ctx.signalCollector.addSignal({
        id: 'recent-signal-1',
        type: SignalType.ACCEPT,
        skill_id: 'recent-skill',
        timestamp: hoursAgo(1),
        context: generateContext(),
      })

      // Signal from 5 days ago
      ctx.signalCollector.addSignal({
        id: 'very-old-signal',
        type: SignalType.DISMISS,
        skill_id: 'very-old-skill',
        timestamp: daysAgo(5),
        context: generateContext(),
      })

      // Query last 24 hours
      const recentSignals = await ctx.signalCollector.getSignals({
        time_range: {
          start: daysAgo(1),
          end: Date.now(),
        },
      })
      expect(recentSignals).toHaveLength(1)
      expect(recentSignals[0].skill_id).toBe('recent-skill')

      // Query last 3 days
      const threeDaySignals = await ctx.signalCollector.getSignals({
        time_range: {
          start: daysAgo(3),
          end: Date.now(),
        },
      })
      expect(threeDaySignals).toHaveLength(2)

      // Query all signals
      const allSignals = await ctx.signalCollector.getSignals({})
      expect(allSignals).toHaveLength(3)
    })
  })

  describe('Signal Count and Skill-Specific Queries', () => {
    it('should return accurate signal count', async () => {
      expect(await ctx.signalCollector.getSignalCount()).toBe(0)

      await ctx.signalCollector.recordAccept('skill-1', generateContext())
      expect(await ctx.signalCollector.getSignalCount()).toBe(1)

      await ctx.signalCollector.recordDismiss('skill-2', generateContext())
      await ctx.signalCollector.recordUsage('skill-1', 'daily')
      expect(await ctx.signalCollector.getSignalCount()).toBe(3)
    })

    it('should get signals for specific skill', async () => {
      const targetSkill = 'anthropic/target-skill'
      const otherSkill = 'community/other-skill'

      await ctx.signalCollector.recordAccept(targetSkill, generateContext())
      await ctx.signalCollector.recordUsage(targetSkill, 'daily')
      await ctx.signalCollector.recordUsage(targetSkill, 'weekly')
      await ctx.signalCollector.recordAccept(otherSkill, generateContext())

      const targetSignals = await ctx.signalCollector.getSignalsForSkill(targetSkill)
      expect(targetSignals).toHaveLength(3)
      expect(targetSignals.every((s) => s.skill_id === targetSkill)).toBe(true)

      const otherSignals = await ctx.signalCollector.getSignalsForSkill(otherSkill)
      expect(otherSignals).toHaveLength(1)
    })

    it('should apply limit to query results', async () => {
      // Add 10 signals
      for (let i = 0; i < 10; i++) {
        await ctx.signalCollector.recordAccept(`skill-${i}`, generateContext())
      }

      const limited = await ctx.signalCollector.getSignals({}, 5)
      expect(limited).toHaveLength(5)

      const unlimited = await ctx.signalCollector.getSignals({})
      expect(unlimited).toHaveLength(10)
    })
  })
})
