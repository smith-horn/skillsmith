import { describe, it, expect } from 'vitest'
import {
  type FeatureFlag,
  type LicenseTier,
  ALL_FEATURE_FLAGS,
  ALL_LICENSE_TIERS,
  isFeatureFlag,
  isLicenseTier,
} from '../../src/license/FeatureFlags.js'

describe('FeatureFlags', () => {
  describe('ALL_FEATURE_FLAGS', () => {
    it('should contain all 14 feature flags', () => {
      // 2 individual + 4 team + 8 enterprise = 14 features
      expect(ALL_FEATURE_FLAGS).toHaveLength(14)
    })

    it('should include all individual tier features', () => {
      expect(ALL_FEATURE_FLAGS).toContain('basic_analytics')
      expect(ALL_FEATURE_FLAGS).toContain('email_support')
    })

    it('should include all team tier features', () => {
      expect(ALL_FEATURE_FLAGS).toContain('team_workspaces')
      expect(ALL_FEATURE_FLAGS).toContain('private_skills')
      expect(ALL_FEATURE_FLAGS).toContain('usage_analytics')
      expect(ALL_FEATURE_FLAGS).toContain('priority_support')
    })

    it('should include all enterprise tier features', () => {
      expect(ALL_FEATURE_FLAGS).toContain('sso_saml')
      expect(ALL_FEATURE_FLAGS).toContain('rbac')
      expect(ALL_FEATURE_FLAGS).toContain('audit_logging')
      expect(ALL_FEATURE_FLAGS).toContain('siem_export')
      expect(ALL_FEATURE_FLAGS).toContain('compliance_reports')
      expect(ALL_FEATURE_FLAGS).toContain('private_registry')
      expect(ALL_FEATURE_FLAGS).toContain('custom_integrations')
      expect(ALL_FEATURE_FLAGS).toContain('advanced_analytics')
    })

    it('should be readonly', () => {
      // TypeScript compile-time check - this array cannot be modified
      const flags: readonly FeatureFlag[] = ALL_FEATURE_FLAGS
      expect(flags).toBe(ALL_FEATURE_FLAGS)
    })
  })

  describe('ALL_LICENSE_TIERS', () => {
    it('should contain all 4 license tiers', () => {
      expect(ALL_LICENSE_TIERS).toHaveLength(4)
    })

    it('should include community, individual, team, and enterprise tiers', () => {
      expect(ALL_LICENSE_TIERS).toContain('community')
      expect(ALL_LICENSE_TIERS).toContain('individual')
      expect(ALL_LICENSE_TIERS).toContain('team')
      expect(ALL_LICENSE_TIERS).toContain('enterprise')
    })

    it('should be readonly', () => {
      // TypeScript compile-time check - this array cannot be modified
      const tiers: readonly LicenseTier[] = ALL_LICENSE_TIERS
      expect(tiers).toBe(ALL_LICENSE_TIERS)
    })
  })

  describe('isFeatureFlag', () => {
    it('should return true for valid feature flags', () => {
      expect(isFeatureFlag('team_workspaces')).toBe(true)
      expect(isFeatureFlag('private_skills')).toBe(true)
      expect(isFeatureFlag('usage_analytics')).toBe(true)
      expect(isFeatureFlag('priority_support')).toBe(true)
      expect(isFeatureFlag('sso_saml')).toBe(true)
      expect(isFeatureFlag('rbac')).toBe(true)
      expect(isFeatureFlag('audit_logging')).toBe(true)
      expect(isFeatureFlag('siem_export')).toBe(true)
      expect(isFeatureFlag('compliance_reports')).toBe(true)
      expect(isFeatureFlag('private_registry')).toBe(true)
      expect(isFeatureFlag('custom_integrations')).toBe(true)
      expect(isFeatureFlag('advanced_analytics')).toBe(true)
    })

    it('should return false for invalid feature flags', () => {
      expect(isFeatureFlag('invalid_feature')).toBe(false)
      expect(isFeatureFlag('')).toBe(false)
      expect(isFeatureFlag('TEAM_WORKSPACES')).toBe(false) // case-sensitive
      expect(isFeatureFlag('team-workspaces')).toBe(false) // wrong separator
    })

    it('should work as a type guard', () => {
      const value: string = 'team_workspaces'
      if (isFeatureFlag(value)) {
        // TypeScript should narrow the type to FeatureFlag
        const flag: FeatureFlag = value
        expect(flag).toBe('team_workspaces')
      }
    })
  })

  describe('isLicenseTier', () => {
    it('should return true for valid license tiers', () => {
      expect(isLicenseTier('community')).toBe(true)
      expect(isLicenseTier('individual')).toBe(true)
      expect(isLicenseTier('team')).toBe(true)
      expect(isLicenseTier('enterprise')).toBe(true)
    })

    it('should return false for invalid license tiers', () => {
      expect(isLicenseTier('invalid_tier')).toBe(false)
      expect(isLicenseTier('')).toBe(false)
      expect(isLicenseTier('ENTERPRISE')).toBe(false) // case-sensitive
      expect(isLicenseTier('pro')).toBe(false)
      expect(isLicenseTier('free')).toBe(false)
    })

    it('should work as a type guard', () => {
      const value: string = 'enterprise'
      if (isLicenseTier(value)) {
        // TypeScript should narrow the type to LicenseTier
        const tier: LicenseTier = value
        expect(tier).toBe('enterprise')
      }
    })
  })

  describe('Type definitions', () => {
    it('should allow valid FeatureFlag assignments', () => {
      const flag1: FeatureFlag = 'team_workspaces'
      const flag2: FeatureFlag = 'sso_saml'
      expect(flag1).toBe('team_workspaces')
      expect(flag2).toBe('sso_saml')
    })

    it('should allow valid LicenseTier assignments', () => {
      const tier1: LicenseTier = 'community'
      const tier2: LicenseTier = 'individual'
      const tier3: LicenseTier = 'team'
      const tier4: LicenseTier = 'enterprise'
      expect(tier1).toBe('community')
      expect(tier2).toBe('individual')
      expect(tier3).toBe('team')
      expect(tier4).toBe('enterprise')
    })
  })
})
