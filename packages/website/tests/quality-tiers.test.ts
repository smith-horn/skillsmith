import { describe, it, expect } from 'vitest'
import {
  getQualityTier,
  formatStarCount,
  getAccessibilityAttrs,
  TIER_THRESHOLDS,
  QUALITY_TIERS,
} from '../src/utils/quality-tiers'

describe('quality-tiers', () => {
  describe('TIER_THRESHOLDS', () => {
    it('has correct threshold values', () => {
      expect(TIER_THRESHOLDS.ELITE).toBe(10000)
      expect(TIER_THRESHOLDS.HIGH_QUALITY).toBe(500)
      expect(TIER_THRESHOLDS.GROWING).toBe(50)
    })
  })

  describe('QUALITY_TIERS', () => {
    it('has 4 tiers in descending order', () => {
      expect(QUALITY_TIERS).toHaveLength(4)
      expect(QUALITY_TIERS[0].label).toBe('Elite')
      expect(QUALITY_TIERS[1].label).toBe('High Quality')
      expect(QUALITY_TIERS[2].label).toBe('Growing')
      expect(QUALITY_TIERS[3].label).toBe('New')
    })

    it('has correct colors for each tier', () => {
      expect(QUALITY_TIERS[0].color).toBe('text-blue-400')
      expect(QUALITY_TIERS[1].color).toBe('text-green-400')
      expect(QUALITY_TIERS[2].color).toBe('text-yellow-400')
      expect(QUALITY_TIERS[3].color).toBe('text-red-400')
    })
  })

  describe('getQualityTier', () => {
    it('returns Elite tier for 10,000+ stars', () => {
      expect(getQualityTier(10000).label).toBe('Elite')
      expect(getQualityTier(10001).label).toBe('Elite')
      expect(getQualityTier(50000).label).toBe('Elite')
      expect(getQualityTier(100000).label).toBe('Elite')
    })

    it('returns High Quality tier for 500-9,999 stars', () => {
      expect(getQualityTier(500).label).toBe('High Quality')
      expect(getQualityTier(501).label).toBe('High Quality')
      expect(getQualityTier(5000).label).toBe('High Quality')
      expect(getQualityTier(9999).label).toBe('High Quality')
    })

    it('returns Growing tier for 50-499 stars', () => {
      expect(getQualityTier(50).label).toBe('Growing')
      expect(getQualityTier(51).label).toBe('Growing')
      expect(getQualityTier(250).label).toBe('Growing')
      expect(getQualityTier(499).label).toBe('Growing')
    })

    it('returns New tier for <50 stars', () => {
      expect(getQualityTier(0).label).toBe('New')
      expect(getQualityTier(1).label).toBe('New')
      expect(getQualityTier(25).label).toBe('New')
      expect(getQualityTier(49).label).toBe('New')
    })

    it('handles boundary conditions correctly', () => {
      // Boundaries between tiers
      expect(getQualityTier(49).label).toBe('New')
      expect(getQualityTier(50).label).toBe('Growing')

      expect(getQualityTier(499).label).toBe('Growing')
      expect(getQualityTier(500).label).toBe('High Quality')

      expect(getQualityTier(9999).label).toBe('High Quality')
      expect(getQualityTier(10000).label).toBe('Elite')
    })

    it('handles null and undefined', () => {
      expect(getQualityTier(null).label).toBe('New')
      expect(getQualityTier(undefined).label).toBe('New')
    })

    it('returns correct colors', () => {
      expect(getQualityTier(50000).color).toBe('text-blue-400')
      expect(getQualityTier(5000).color).toBe('text-green-400')
      expect(getQualityTier(250).color).toBe('text-yellow-400')
      expect(getQualityTier(10).color).toBe('text-red-400')
    })
  })

  describe('formatStarCount', () => {
    it('formats numbers with locale formatting', () => {
      // Note: Intl.NumberFormat output may vary by locale
      expect(formatStarCount(0)).toBe('0')
      expect(formatStarCount(100)).toBe('100')
      expect(formatStarCount(1000)).toMatch(/1[,.]?000/) // Handles comma or dot separator
      expect(formatStarCount(10000)).toMatch(/10[,.]?000/)
    })

    it('handles null and undefined', () => {
      expect(formatStarCount(null)).toBe('0')
      expect(formatStarCount(undefined)).toBe('0')
    })
  })

  describe('getAccessibilityAttrs', () => {
    it('returns correct accessibility attributes', () => {
      const tier = getQualityTier(15000)
      const attrs = getAccessibilityAttrs(tier, 15000)

      expect(attrs['aria-label']).toMatch(/Elite.*15.*000.*stars/i)
      expect(attrs.title).toMatch(/Elite.*15.*000.*stars/i)
      expect(attrs.role).toBe('img')
    })

    it('handles null star count', () => {
      const tier = getQualityTier(null)
      const attrs = getAccessibilityAttrs(tier, null)

      expect(attrs['aria-label']).toMatch(/New.*0.*stars/i)
      expect(attrs.role).toBe('img')
    })
  })
})
