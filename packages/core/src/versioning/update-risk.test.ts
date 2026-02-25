/**
 * @fileoverview Tests for update-risk.ts
 * @see SMI-skill-version-tracking Wave 2
 */

import { describe, it, expect } from 'vitest'
import { computeUpdateRisk } from './update-risk.js'

describe('computeUpdateRisk', () => {
  describe('score → level mapping', () => {
    it('returns low for score <= 20', () => {
      // community, patch, no local mods, no changelog → 0
      const result = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(result.level).toBe('low')
      expect(result.score).toBe(0)
    })

    it('returns medium for score 21–40', () => {
      // major (+30) + verified (-20) + changelog (-10) = 0 → low
      // Let's try: major (+30) + community (0) + changelog (-10) = 20 → low
      // major (+30) + community (0) + no changelog = 30 → medium
      const result = computeUpdateRisk({
        changeType: 'major',
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(result.level).toBe('medium')
      expect(result.score).toBe(30)
    })

    it('returns high for score 41–60', () => {
      // major (30) + local mods (20) + changelog (-10) = 40 → medium
      // major (30) + local mods (20) = 50 → high
      const result = computeUpdateRisk({
        changeType: 'major',
        hasLocalModifications: true,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(result.level).toBe('high')
      expect(result.score).toBe(50)
    })

    it('returns critical for score >= 61', () => {
      // major (30) + risk delta (20) + local mods (20) = 70 → critical
      const result = computeUpdateRisk({
        changeType: 'major',
        riskScoreDelta: 10, // positive → +20
        hasLocalModifications: true,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(result.level).toBe('critical')
      expect(result.score).toBe(70)
    })
  })

  describe('score → recommendation mapping', () => {
    it('returns auto-update for score <= 20', () => {
      const result = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(result.recommendation).toBe('auto-update')
    })

    it('returns review-then-update for score 21–50', () => {
      // major (30), community, no local, no changelog = 30
      const result = computeUpdateRisk({
        changeType: 'major',
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(result.recommendation).toBe('review-then-update')
    })

    it('returns manual-review-required for score >= 51', () => {
      // major (30) + local mods (20) = 50 → review-then-update
      // major (30) + local mods (20) + risk delta (20) = 70 → manual
      const result = computeUpdateRisk({
        changeType: 'major',
        riskScoreDelta: 5, // positive → +20
        hasLocalModifications: true,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(result.recommendation).toBe('manual-review-required')
    })
  })

  describe('individual score factors', () => {
    it('verified tier reduces score by 20', () => {
      const withCommunity = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      const withVerified = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: false,
        trustTier: 'verified',
        hasChangelog: false,
      })
      expect(withVerified.score).toBe(withCommunity.score - 20)
    })

    it('changelog reduces score by 10', () => {
      const withoutChangelog = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      const withChangelog = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: true,
      })
      expect(withChangelog.score).toBe(withoutChangelog.score - 10)
    })

    it('hasLocalModifications adds 20', () => {
      const without = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      const with_ = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: true,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(with_.score).toBe(without.score + 20)
    })

    it('riskScoreDelta > 0 adds 20', () => {
      const without = computeUpdateRisk({
        changeType: 'patch',
        riskScoreDelta: 0,
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      const with_ = computeUpdateRisk({
        changeType: 'patch',
        riskScoreDelta: 1, // positive
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(with_.score).toBe(without.score + 20)
    })

    it('negative riskScoreDelta does not add penalty', () => {
      const result = computeUpdateRisk({
        changeType: 'patch',
        riskScoreDelta: -10,
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      // risk delta ≤ 0 should not add the +20 penalty
      expect(result.score).toBe(0)
    })

    it('undefined riskScoreDelta does not add penalty', () => {
      const result = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: false,
        trustTier: 'community',
        hasChangelog: false,
      })
      expect(result.score).toBe(0)
    })
  })

  describe('combined scenarios', () => {
    it('fully safe update: patch + verified + changelog = -30 → low (clamped to 0 effectively)', () => {
      const result = computeUpdateRisk({
        changeType: 'patch',
        hasLocalModifications: false,
        trustTier: 'verified',
        hasChangelog: true,
      })
      // 0 - 20 - 10 = -30 → level: low (score <= 20)
      expect(result.level).toBe('low')
      expect(result.recommendation).toBe('auto-update')
    })

    it('worst case scenario produces critical + manual-review-required', () => {
      const result = computeUpdateRisk({
        changeType: 'major',
        riskScoreDelta: 50,
        hasLocalModifications: true,
        trustTier: 'experimental',
        hasChangelog: false,
      })
      expect(result.level).toBe('critical')
      expect(result.recommendation).toBe('manual-review-required')
    })
  })
})
