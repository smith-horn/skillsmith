// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * SMI-1602: Quota System Tests
 *
 * Tests for quota constants and helper functions to increase branch coverage.
 */

import { describe, it, expect } from 'vitest'
import {
  TIER_QUOTAS,
  WARNING_THRESHOLDS,
  WARNING_CONFIG,
  DORMANT_ACCOUNT_DAYS,
  BILLING_PERIOD_DAYS,
  getQuotaLimit,
  isUnlimited,
  getWarningLevel,
  getWarningConfig,
  getTierPriceDisplay,
  getQuotaDisplay,
  getUpgradeRecommendation,
  buildUpgradeUrl,
} from '../../src/license/quotas.js'

describe('Quota System', () => {
  // ============================================================================
  // Constants Tests
  // ============================================================================

  describe('TIER_QUOTAS', () => {
    it('should define quotas for all tiers', () => {
      expect(TIER_QUOTAS.community).toBeDefined()
      expect(TIER_QUOTAS.individual).toBeDefined()
      expect(TIER_QUOTAS.team).toBeDefined()
      expect(TIER_QUOTAS.enterprise).toBeDefined()
    })

    it('should have correct community tier values', () => {
      expect(TIER_QUOTAS.community.apiCallsPerMonth).toBe(1_000)
      expect(TIER_QUOTAS.community.price).toBe(0)
      expect(TIER_QUOTAS.community.perUser).toBeUndefined()
      expect(TIER_QUOTAS.community.description).toBe('Free tier for evaluation')
    })

    it('should have correct individual tier values', () => {
      expect(TIER_QUOTAS.individual.apiCallsPerMonth).toBe(10_000)
      expect(TIER_QUOTAS.individual.price).toBe(9.99)
      expect(TIER_QUOTAS.individual.perUser).toBeUndefined()
      expect(TIER_QUOTAS.individual.description).toBe('For solo developers')
    })

    it('should have correct team tier values', () => {
      expect(TIER_QUOTAS.team.apiCallsPerMonth).toBe(100_000)
      expect(TIER_QUOTAS.team.price).toBe(25)
      expect(TIER_QUOTAS.team.perUser).toBe(true)
      expect(TIER_QUOTAS.team.description).toBe('For development teams')
    })

    it('should have correct enterprise tier values', () => {
      expect(TIER_QUOTAS.enterprise.apiCallsPerMonth).toBe(-1)
      expect(TIER_QUOTAS.enterprise.price).toBe(55)
      expect(TIER_QUOTAS.enterprise.perUser).toBe(true)
      expect(TIER_QUOTAS.enterprise.description).toBe(
        'Full enterprise features with unlimited usage'
      )
    })
  })

  describe('WARNING_THRESHOLDS', () => {
    it('should have correct threshold values', () => {
      expect(WARNING_THRESHOLDS).toEqual([80, 90, 100])
    })
  })

  describe('WARNING_CONFIG', () => {
    it('should have 3 warning configurations', () => {
      expect(WARNING_CONFIG).toHaveLength(3)
    })

    it('should have correct 80% threshold config', () => {
      const config = WARNING_CONFIG[0]
      expect(config.threshold).toBe(80)
      expect(config.severity).toBe('info')
      expect(config.message).toBe('Approaching quota limit')
      expect(config.sendEmail).toBe(false)
    })

    it('should have correct 90% threshold config', () => {
      const config = WARNING_CONFIG[1]
      expect(config.threshold).toBe(90)
      expect(config.severity).toBe('warning')
      expect(config.message).toBe('Quota nearly exhausted')
      expect(config.sendEmail).toBe(true)
    })

    it('should have correct 100% threshold config', () => {
      const config = WARNING_CONFIG[2]
      expect(config.threshold).toBe(100)
      expect(config.severity).toBe('error')
      expect(config.message).toBe('Quota exceeded')
      expect(config.sendEmail).toBe(true)
    })
  })

  describe('Policy Constants', () => {
    it('should define dormant account days', () => {
      expect(DORMANT_ACCOUNT_DAYS).toBe(90)
    })

    it('should define billing period days', () => {
      expect(BILLING_PERIOD_DAYS).toBe(30)
    })
  })

  // ============================================================================
  // Helper Function Tests
  // ============================================================================

  describe('getQuotaLimit', () => {
    it('should return 1000 for community tier', () => {
      expect(getQuotaLimit('community')).toBe(1_000)
    })

    it('should return 10000 for individual tier', () => {
      expect(getQuotaLimit('individual')).toBe(10_000)
    })

    it('should return 100000 for team tier', () => {
      expect(getQuotaLimit('team')).toBe(100_000)
    })

    it('should return -1 for enterprise tier (unlimited)', () => {
      expect(getQuotaLimit('enterprise')).toBe(-1)
    })
  })

  describe('isUnlimited', () => {
    it('should return false for community tier', () => {
      expect(isUnlimited('community')).toBe(false)
    })

    it('should return false for individual tier', () => {
      expect(isUnlimited('individual')).toBe(false)
    })

    it('should return false for team tier', () => {
      expect(isUnlimited('team')).toBe(false)
    })

    it('should return true for enterprise tier', () => {
      expect(isUnlimited('enterprise')).toBe(true)
    })
  })

  describe('getWarningLevel', () => {
    it('should return 0 for usage below 80%', () => {
      expect(getWarningLevel(0)).toBe(0)
      expect(getWarningLevel(50)).toBe(0)
      expect(getWarningLevel(79)).toBe(0)
      expect(getWarningLevel(79.9)).toBe(0)
    })

    it('should return 80 for usage between 80% and 90%', () => {
      expect(getWarningLevel(80)).toBe(80)
      expect(getWarningLevel(85)).toBe(80)
      expect(getWarningLevel(89.9)).toBe(80)
    })

    it('should return 90 for usage between 90% and 100%', () => {
      expect(getWarningLevel(90)).toBe(90)
      expect(getWarningLevel(95)).toBe(90)
      expect(getWarningLevel(99.9)).toBe(90)
    })

    it('should return 100 for usage at or above 100%', () => {
      expect(getWarningLevel(100)).toBe(100)
      expect(getWarningLevel(105)).toBe(100)
      expect(getWarningLevel(150)).toBe(100)
    })
  })

  describe('getWarningConfig', () => {
    it('should return undefined for usage below 80%', () => {
      expect(getWarningConfig(0)).toBeUndefined()
      expect(getWarningConfig(50)).toBeUndefined()
      expect(getWarningConfig(79)).toBeUndefined()
    })

    it('should return info config for 80% threshold', () => {
      const config = getWarningConfig(80)
      expect(config).toBeDefined()
      expect(config?.threshold).toBe(80)
      expect(config?.severity).toBe('info')
    })

    it('should return warning config for 90% threshold', () => {
      const config = getWarningConfig(90)
      expect(config).toBeDefined()
      expect(config?.threshold).toBe(90)
      expect(config?.severity).toBe('warning')
    })

    it('should return error config for 100% threshold', () => {
      const config = getWarningConfig(100)
      expect(config).toBeDefined()
      expect(config?.threshold).toBe(100)
      expect(config?.severity).toBe('error')
    })
  })

  describe('getTierPriceDisplay', () => {
    it('should return "Free" for community tier', () => {
      expect(getTierPriceDisplay('community')).toBe('Free')
    })

    it('should return "$9.99/mo" for individual tier', () => {
      expect(getTierPriceDisplay('individual')).toBe('$9.99/mo')
    })

    it('should return "$25/user/mo" for team tier', () => {
      expect(getTierPriceDisplay('team')).toBe('$25/user/mo')
    })

    it('should return "$55/user/mo" for enterprise tier', () => {
      expect(getTierPriceDisplay('enterprise')).toBe('$55/user/mo')
    })
  })

  describe('getQuotaDisplay', () => {
    it('should return formatted calls for community tier', () => {
      expect(getQuotaDisplay('community')).toBe('1,000 calls/mo')
    })

    it('should return formatted calls for individual tier', () => {
      expect(getQuotaDisplay('individual')).toBe('10,000 calls/mo')
    })

    it('should return formatted calls for team tier', () => {
      expect(getQuotaDisplay('team')).toBe('100,000 calls/mo')
    })

    it('should return "Unlimited" for enterprise tier', () => {
      expect(getQuotaDisplay('enterprise')).toBe('Unlimited')
    })
  })

  describe('getUpgradeRecommendation', () => {
    it('should recommend individual for community tier', () => {
      expect(getUpgradeRecommendation('community')).toBe('individual')
    })

    it('should recommend team for individual tier', () => {
      expect(getUpgradeRecommendation('individual')).toBe('team')
    })

    it('should recommend enterprise for team tier', () => {
      expect(getUpgradeRecommendation('team')).toBe('enterprise')
    })

    it('should return null for enterprise tier (already at highest)', () => {
      expect(getUpgradeRecommendation('enterprise')).toBeNull()
    })
  })

  describe('buildUpgradeUrl', () => {
    it('should build URL with quota_exceeded reason', () => {
      const url = buildUpgradeUrl('community', 'quota_exceeded')
      expect(url).toContain('https://skillsmith.app/upgrade')
      expect(url).toContain('from=community')
      expect(url).toContain('to=individual')
      expect(url).toContain('reason=quota_exceeded')
      expect(url).toContain('utm_source=cli')
      expect(url).toContain('utm_medium=quota_warning')
      expect(url).toContain('utm_campaign=upgrade_prompt')
    })

    it('should build URL with quota_warning reason', () => {
      const url = buildUpgradeUrl('individual', 'quota_warning')
      expect(url).toContain('from=individual')
      expect(url).toContain('to=team')
      expect(url).toContain('reason=quota_warning')
    })

    it('should build URL with feature_required reason', () => {
      const url = buildUpgradeUrl('team', 'feature_required')
      expect(url).toContain('from=team')
      expect(url).toContain('to=enterprise')
      expect(url).toContain('reason=feature_required')
    })

    it('should default to enterprise for already-enterprise tier', () => {
      const url = buildUpgradeUrl('enterprise', 'quota_exceeded')
      expect(url).toContain('from=enterprise')
      expect(url).toContain('to=enterprise')
    })
  })
})
