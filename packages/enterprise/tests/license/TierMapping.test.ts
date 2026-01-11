import { describe, it, expect } from 'vitest'
import {
  FEATURE_TIERS,
  getRequiredTier,
  getFeaturesForTier,
  tierIncludes,
} from '../../src/license/TierMapping.js'
import { ALL_FEATURE_FLAGS, type FeatureFlag } from '../../src/license/FeatureFlags.js'

describe('TierMapping', () => {
  describe('FEATURE_TIERS', () => {
    it('should map all feature flags', () => {
      const mappedFeatures = Object.keys(FEATURE_TIERS)
      // 2 individual + 4 team + 8 enterprise = 14 features
      expect(mappedFeatures).toHaveLength(14)

      for (const flag of ALL_FEATURE_FLAGS) {
        expect(FEATURE_TIERS[flag]).toBeDefined()
      }
    })

    it('should map team features to team and enterprise tiers', () => {
      const teamFeatures: FeatureFlag[] = [
        'team_workspaces',
        'private_skills',
        'usage_analytics',
        'priority_support',
      ]

      for (const feature of teamFeatures) {
        expect(FEATURE_TIERS[feature]).toContain('team')
        expect(FEATURE_TIERS[feature]).toContain('enterprise')
        expect(FEATURE_TIERS[feature]).not.toContain('community')
      }
    })

    it('should map enterprise features to enterprise tier only', () => {
      const enterpriseOnlyFeatures: FeatureFlag[] = [
        'sso_saml',
        'rbac',
        'audit_logging',
        'siem_export',
        'compliance_reports',
        'private_registry',
        'custom_integrations',
        'advanced_analytics',
      ]

      for (const feature of enterpriseOnlyFeatures) {
        expect(FEATURE_TIERS[feature]).toContain('enterprise')
        expect(FEATURE_TIERS[feature]).not.toContain('team')
        expect(FEATURE_TIERS[feature]).not.toContain('community')
      }
    })

    it('should not include community tier for any feature', () => {
      for (const feature of ALL_FEATURE_FLAGS) {
        expect(FEATURE_TIERS[feature]).not.toContain('community')
      }
    })
  })

  describe('getRequiredTier', () => {
    it('should return team for team-tier features', () => {
      expect(getRequiredTier('team_workspaces')).toBe('team')
      expect(getRequiredTier('private_skills')).toBe('team')
      expect(getRequiredTier('usage_analytics')).toBe('team')
      expect(getRequiredTier('priority_support')).toBe('team')
    })

    it('should return enterprise for enterprise-only features', () => {
      expect(getRequiredTier('sso_saml')).toBe('enterprise')
      expect(getRequiredTier('rbac')).toBe('enterprise')
      expect(getRequiredTier('audit_logging')).toBe('enterprise')
      expect(getRequiredTier('siem_export')).toBe('enterprise')
      expect(getRequiredTier('compliance_reports')).toBe('enterprise')
      expect(getRequiredTier('private_registry')).toBe('enterprise')
      expect(getRequiredTier('custom_integrations')).toBe('enterprise')
      expect(getRequiredTier('advanced_analytics')).toBe('enterprise')
    })

    it('should return the minimum required tier for each feature', () => {
      // Team features require team tier (minimum)
      for (const feature of [
        'team_workspaces',
        'private_skills',
        'usage_analytics',
        'priority_support',
      ] as FeatureFlag[]) {
        expect(getRequiredTier(feature)).toBe('team')
      }

      // Enterprise features require enterprise tier
      for (const feature of [
        'sso_saml',
        'rbac',
        'audit_logging',
        'siem_export',
        'compliance_reports',
        'private_registry',
        'custom_integrations',
        'advanced_analytics',
      ] as FeatureFlag[]) {
        expect(getRequiredTier(feature)).toBe('enterprise')
      }
    })
  })

  describe('getFeaturesForTier', () => {
    it('should return empty array for community tier', () => {
      const features = getFeaturesForTier('community')
      expect(features).toEqual([])
      expect(features).toHaveLength(0)
    })

    it('should return 6 features for team tier (individual + team features)', () => {
      const features = getFeaturesForTier('team')
      // 2 individual + 4 team = 6 features
      expect(features).toHaveLength(6)
      // Individual features (inherited)
      expect(features).toContain('basic_analytics')
      expect(features).toContain('email_support')
      // Team features
      expect(features).toContain('team_workspaces')
      expect(features).toContain('private_skills')
      expect(features).toContain('usage_analytics')
      expect(features).toContain('priority_support')
    })

    it('should not include enterprise-only features in team tier', () => {
      const features = getFeaturesForTier('team')
      expect(features).not.toContain('sso_saml')
      expect(features).not.toContain('rbac')
      expect(features).not.toContain('audit_logging')
      expect(features).not.toContain('siem_export')
      expect(features).not.toContain('compliance_reports')
      expect(features).not.toContain('private_registry')
      expect(features).not.toContain('custom_integrations')
      expect(features).not.toContain('advanced_analytics')
    })

    it('should return all 14 features for enterprise tier', () => {
      const features = getFeaturesForTier('enterprise')
      // 2 individual + 4 team + 8 enterprise = 14 features
      expect(features).toHaveLength(14)

      // Should include all individual features
      expect(features).toContain('basic_analytics')
      expect(features).toContain('email_support')

      // Should include all team features
      expect(features).toContain('team_workspaces')
      expect(features).toContain('private_skills')
      expect(features).toContain('usage_analytics')
      expect(features).toContain('priority_support')

      // Should include all enterprise-only features
      expect(features).toContain('sso_saml')
      expect(features).toContain('rbac')
      expect(features).toContain('audit_logging')
      expect(features).toContain('siem_export')
      expect(features).toContain('compliance_reports')
      expect(features).toContain('private_registry')
      expect(features).toContain('custom_integrations')
      expect(features).toContain('advanced_analytics')
    })

    it('should return a new array each time (not the same reference)', () => {
      const features1 = getFeaturesForTier('enterprise')
      const features2 = getFeaturesForTier('enterprise')
      expect(features1).not.toBe(features2)
      expect(features1).toEqual(features2)
    })
  })

  describe('tierIncludes', () => {
    describe('community tier', () => {
      it('should not include any features', () => {
        for (const feature of ALL_FEATURE_FLAGS) {
          expect(tierIncludes('community', feature)).toBe(false)
        }
      })
    })

    describe('team tier', () => {
      it('should include team features', () => {
        expect(tierIncludes('team', 'team_workspaces')).toBe(true)
        expect(tierIncludes('team', 'private_skills')).toBe(true)
        expect(tierIncludes('team', 'usage_analytics')).toBe(true)
        expect(tierIncludes('team', 'priority_support')).toBe(true)
      })

      it('should not include enterprise-only features', () => {
        expect(tierIncludes('team', 'sso_saml')).toBe(false)
        expect(tierIncludes('team', 'rbac')).toBe(false)
        expect(tierIncludes('team', 'audit_logging')).toBe(false)
        expect(tierIncludes('team', 'siem_export')).toBe(false)
        expect(tierIncludes('team', 'compliance_reports')).toBe(false)
        expect(tierIncludes('team', 'private_registry')).toBe(false)
        expect(tierIncludes('team', 'custom_integrations')).toBe(false)
        expect(tierIncludes('team', 'advanced_analytics')).toBe(false)
      })
    })

    describe('enterprise tier', () => {
      it('should include all features', () => {
        for (const feature of ALL_FEATURE_FLAGS) {
          expect(tierIncludes('enterprise', feature)).toBe(true)
        }
      })

      it('should include team features', () => {
        expect(tierIncludes('enterprise', 'team_workspaces')).toBe(true)
        expect(tierIncludes('enterprise', 'private_skills')).toBe(true)
        expect(tierIncludes('enterprise', 'usage_analytics')).toBe(true)
        expect(tierIncludes('enterprise', 'priority_support')).toBe(true)
      })

      it('should include enterprise-only features', () => {
        expect(tierIncludes('enterprise', 'sso_saml')).toBe(true)
        expect(tierIncludes('enterprise', 'rbac')).toBe(true)
        expect(tierIncludes('enterprise', 'audit_logging')).toBe(true)
        expect(tierIncludes('enterprise', 'siem_export')).toBe(true)
        expect(tierIncludes('enterprise', 'compliance_reports')).toBe(true)
        expect(tierIncludes('enterprise', 'private_registry')).toBe(true)
        expect(tierIncludes('enterprise', 'custom_integrations')).toBe(true)
        expect(tierIncludes('enterprise', 'advanced_analytics')).toBe(true)
      })
    })
  })

  describe('tier hierarchy', () => {
    it('should follow proper feature inheritance', () => {
      // Community has no features
      const communityFeatures = getFeaturesForTier('community')
      expect(communityFeatures).toHaveLength(0)

      // Individual has 2 features
      const individualFeatures = getFeaturesForTier('individual')
      expect(individualFeatures).toHaveLength(2)

      // Team has individual + 4 team features = 6
      const teamFeatures = getFeaturesForTier('team')
      expect(teamFeatures).toHaveLength(6)

      // Enterprise has all features = 14
      const enterpriseFeatures = getFeaturesForTier('enterprise')
      expect(enterpriseFeatures).toHaveLength(14)

      // All individual features should be included in team
      for (const feature of individualFeatures) {
        expect(teamFeatures).toContain(feature)
      }

      // All team features should be included in enterprise
      for (const feature of teamFeatures) {
        expect(enterpriseFeatures).toContain(feature)
      }
    })

    it('should have enterprise include all team features', () => {
      const teamFeatures = getFeaturesForTier('team')
      const enterpriseFeatures = getFeaturesForTier('enterprise')

      for (const feature of teamFeatures) {
        expect(enterpriseFeatures).toContain(feature)
        expect(tierIncludes('enterprise', feature)).toBe(true)
      }
    })
  })
})
