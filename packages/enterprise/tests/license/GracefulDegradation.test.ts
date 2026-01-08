/**
 * SMI-1060: Graceful Degradation Tests
 *
 * Tests for the graceful degradation system for license validation.
 */

import { describe, it, expect } from 'vitest'
import {
  createUpgradePrompt,
  createDetailedUpgradePrompt,
  createTierComparisonMessage,
  handleFeatureDenied,
  checkFeatureGracefully,
  getUpgradeUrl,
  getPricingUrl,
  getTierComparison,
  formatAsMcpResponse,
  createShortUpgradeNotice,
  createDegradationEvent,
  TIER_PRICING,
  FEATURE_DISPLAY_NAMES,
  FEATURE_DESCRIPTIONS,
  TIER_DISPLAY_NAMES,
} from '../../src/license/GracefulDegradation.js'
import type { FeatureFlag, LicenseTier } from '../../src/license/types.js'

// ============================================================================
// Constants Tests
// ============================================================================

describe('Constants', () => {
  describe('TIER_PRICING', () => {
    it('should have pricing for all tiers', () => {
      expect(TIER_PRICING.community).toBe('$0/month')
      expect(TIER_PRICING.team).toBe('$25/user/month')
      expect(TIER_PRICING.enterprise).toBe('$55/user/month')
    })
  })

  describe('FEATURE_DISPLAY_NAMES', () => {
    it('should have display names for all features', () => {
      const features: FeatureFlag[] = [
        'team_workspaces',
        'private_skills',
        'usage_analytics',
        'priority_support',
        'sso_saml',
        'rbac',
        'audit_logging',
        'siem_export',
        'compliance_reports',
        'private_registry',
      ]

      for (const feature of features) {
        expect(FEATURE_DISPLAY_NAMES[feature]).toBeDefined()
        expect(typeof FEATURE_DISPLAY_NAMES[feature]).toBe('string')
        expect(FEATURE_DISPLAY_NAMES[feature].length).toBeGreaterThan(0)
      }
    })
  })

  describe('FEATURE_DESCRIPTIONS', () => {
    it('should have descriptions for all features', () => {
      const features: FeatureFlag[] = [
        'team_workspaces',
        'private_skills',
        'usage_analytics',
        'priority_support',
        'sso_saml',
        'rbac',
        'audit_logging',
        'siem_export',
        'compliance_reports',
        'private_registry',
      ]

      for (const feature of features) {
        expect(FEATURE_DESCRIPTIONS[feature]).toBeDefined()
        expect(typeof FEATURE_DESCRIPTIONS[feature]).toBe('string')
        expect(FEATURE_DESCRIPTIONS[feature].length).toBeGreaterThan(10)
      }
    })
  })

  describe('TIER_DISPLAY_NAMES', () => {
    it('should have display names for all tiers', () => {
      expect(TIER_DISPLAY_NAMES.community).toBe('Community')
      expect(TIER_DISPLAY_NAMES.team).toBe('Team')
      expect(TIER_DISPLAY_NAMES.enterprise).toBe('Enterprise')
    })
  })
})

// ============================================================================
// URL Generation Tests
// ============================================================================

describe('URL Generation', () => {
  describe('getUpgradeUrl', () => {
    it('should generate basic upgrade URL for community tier', () => {
      const url = getUpgradeUrl('community')
      expect(url).toBe('https://skillsmith.app/upgrade')
    })

    it('should generate upgrade URL with tier parameter', () => {
      const url = getUpgradeUrl('team')
      expect(url).toBe('https://skillsmith.app/upgrade?tier=team')
    })

    it('should include feature parameter when provided', () => {
      const url = getUpgradeUrl('enterprise', { feature: 'sso_saml' })
      expect(url).toContain('tier=enterprise')
      expect(url).toContain('feature=sso_saml')
    })

    it('should include source parameter when provided', () => {
      const url = getUpgradeUrl('team', { source: 'cli' })
      expect(url).toContain('source=cli')
    })

    it('should handle all parameters together', () => {
      const url = getUpgradeUrl('enterprise', { feature: 'rbac', source: 'mcp' })
      expect(url).toContain('tier=enterprise')
      expect(url).toContain('feature=rbac')
      expect(url).toContain('source=mcp')
    })
  })

  describe('getPricingUrl', () => {
    it('should generate basic pricing URL', () => {
      const url = getPricingUrl()
      expect(url).toBe('https://skillsmith.app/pricing')
    })

    it('should include feature highlight when provided', () => {
      const url = getPricingUrl({ feature: 'audit_logging' })
      expect(url).toContain('highlight=audit_logging')
    })

    it('should include current tier when provided', () => {
      const url = getPricingUrl({ currentTier: 'team' })
      expect(url).toContain('current=team')
    })

    it('should handle both parameters', () => {
      const url = getPricingUrl({ feature: 'siem_export', currentTier: 'community' })
      expect(url).toContain('highlight=siem_export')
      expect(url).toContain('current=community')
    })
  })
})

// ============================================================================
// Upgrade Prompt Tests
// ============================================================================

describe('Upgrade Prompts', () => {
  describe('createUpgradePrompt', () => {
    it('should create prompt for team feature', () => {
      const prompt = createUpgradePrompt('team_workspaces')
      expect(prompt).toContain('Team Workspaces')
      expect(prompt).toContain('Team tier')
      expect(prompt).toContain('$25/user/month')
      expect(prompt).toContain('https://skillsmith.app/upgrade')
    })

    it('should create prompt for enterprise feature', () => {
      const prompt = createUpgradePrompt('sso_saml')
      expect(prompt).toContain('SSO/SAML Integration')
      expect(prompt).toContain('Enterprise tier')
      expect(prompt).toContain('$55/user/month')
    })

    it('should include description when requested', () => {
      const prompt = createUpgradePrompt('audit_logging', { includeDescription: true })
      expect(prompt).toContain('Comprehensive audit trail')
    })

    it('should exclude pricing when requested', () => {
      const prompt = createUpgradePrompt('rbac', { includePricing: false })
      expect(prompt).not.toContain('$55/user/month')
    })

    it('should include alternatives when requested', () => {
      const prompt = createUpgradePrompt('sso_saml', {
        includeAlternatives: true,
        currentTier: 'team',
      })
      expect(prompt).toContain('Features available in your current tier')
    })
  })

  describe('createDetailedUpgradePrompt', () => {
    it('should create detailed prompt with all information', () => {
      const prompt = createDetailedUpgradePrompt('audit_logging', 'team')

      expect(prompt).toContain('Feature Unavailable: Audit Logging')
      expect(prompt).toContain('Comprehensive audit trail')
      expect(prompt).toContain('Current tier: Team ($25/user/month)')
      expect(prompt).toContain('Required tier: Enterprise ($55/user/month)')
      expect(prompt).toContain('Upgrade to unlock')
      expect(prompt).toContain('Compare plans')
    })

    it('should work for community to team upgrade', () => {
      const prompt = createDetailedUpgradePrompt('team_workspaces', 'community')

      expect(prompt).toContain('Current tier: Community ($0/month)')
      expect(prompt).toContain('Required tier: Team ($25/user/month)')
    })
  })
})

// ============================================================================
// Tier Comparison Tests
// ============================================================================

describe('Tier Comparison', () => {
  describe('createTierComparisonMessage', () => {
    it('should create formatted tier comparison', () => {
      const message = createTierComparisonMessage()

      expect(message).toContain('Skillsmith Pricing Tiers')
      expect(message).toContain('Community ($0/month)')
      expect(message).toContain('Team ($25/user/month)')
      expect(message).toContain('Enterprise ($55/user/month)')
      expect(message).toContain('search, install, recommend, validate, compare')
      expect(message).toContain('https://skillsmith.app/pricing')
    })

    it('should include feature names for paid tiers', () => {
      const message = createTierComparisonMessage()

      expect(message).toContain('Team Workspaces')
      expect(message).toContain('Private Skills')
      expect(message).toContain('SSO/SAML Integration')
      expect(message).toContain('Role-Based Access Control')
    })
  })

  describe('getTierComparison', () => {
    it('should return array of tier entries', () => {
      const comparison = getTierComparison()

      expect(comparison).toHaveLength(3)
      expect(comparison[0]!.tier).toBe('community')
      expect(comparison[1]!.tier).toBe('team')
      expect(comparison[2]!.tier).toBe('enterprise')
    })

    it('should have correct pricing for each tier', () => {
      const comparison = getTierComparison()

      expect(comparison[0]!.pricing).toBe('$0/month')
      expect(comparison[1]!.pricing).toBe('$25/user/month')
      expect(comparison[2]!.pricing).toBe('$55/user/month')
    })

    it('should have no features for community tier', () => {
      const comparison = getTierComparison()
      const community = comparison[0]!

      expect(community.features).toHaveLength(0)
    })

    it('should have team features for team tier', () => {
      const comparison = getTierComparison()
      const team = comparison[1]!

      expect(team.features).toContain('team_workspaces')
      expect(team.features).toContain('private_skills')
      expect(team.features).not.toContain('sso_saml')
    })

    it('should have all features for enterprise tier', () => {
      const comparison = getTierComparison()
      const enterprise = comparison[2]!

      expect(enterprise.features).toContain('team_workspaces')
      expect(enterprise.features).toContain('sso_saml')
      expect(enterprise.features).toContain('audit_logging')
    })
  })
})

// ============================================================================
// Feature Denied Handler Tests
// ============================================================================

describe('handleFeatureDenied', () => {
  it('should return complete degradation result', () => {
    const result = handleFeatureDenied('sso_saml', 'team')

    expect(result.allowed).toBe(false)
    expect(result.feature).toBe('sso_saml')
    expect(result.requiredTier).toBe('enterprise')
    expect(result.currentTier).toBe('team')
    expect(result.message).toBeDefined()
    expect(result.detailedMessage).toBeDefined()
    expect(result.upgradeUrl).toBeDefined()
    expect(result.pricingUrl).toBeDefined()
    expect(result.availableAlternatives).toBeDefined()
  })

  it('should include team features as alternatives when on team tier', () => {
    const result = handleFeatureDenied('audit_logging', 'team')

    expect(result.availableAlternatives).toContain('team_workspaces')
    expect(result.availableAlternatives).toContain('private_skills')
  })

  it('should have no alternatives for community tier', () => {
    const result = handleFeatureDenied('team_workspaces', 'community')

    expect(result.availableAlternatives).toHaveLength(0)
  })

  it('should include source in upgrade URL', () => {
    const result = handleFeatureDenied('rbac', 'team')

    expect(result.upgradeUrl).toContain('source=feature-denied')
  })
})

// ============================================================================
// Graceful Feature Check Tests
// ============================================================================

describe('checkFeatureGracefully', () => {
  it('should return null when feature is available', () => {
    const result = checkFeatureGracefully('team_workspaces', 'team')
    expect(result).toBeNull()
  })

  it('should return null for enterprise features when on enterprise tier', () => {
    const result = checkFeatureGracefully('sso_saml', 'enterprise')
    expect(result).toBeNull()
  })

  it('should return degradation result when feature unavailable', () => {
    const result = checkFeatureGracefully('sso_saml', 'team')

    expect(result).not.toBeNull()
    expect(result?.allowed).toBe(false)
    expect(result?.feature).toBe('sso_saml')
    expect(result?.requiredTier).toBe('enterprise')
  })

  it('should return degradation for community tier on any paid feature', () => {
    const teamResult = checkFeatureGracefully('team_workspaces', 'community')
    const enterpriseResult = checkFeatureGracefully('audit_logging', 'community')

    expect(teamResult).not.toBeNull()
    expect(enterpriseResult).not.toBeNull()
  })

  it('should handle all enterprise features being available to enterprise tier', () => {
    const enterpriseFeatures: FeatureFlag[] = [
      'sso_saml',
      'rbac',
      'audit_logging',
      'siem_export',
      'compliance_reports',
      'private_registry',
    ]

    for (const feature of enterpriseFeatures) {
      const result = checkFeatureGracefully(feature, 'enterprise')
      expect(result).toBeNull()
    }
  })
})

// ============================================================================
// MCP Response Formatter Tests
// ============================================================================

describe('formatAsMcpResponse', () => {
  it('should create valid MCP response structure', () => {
    const degradationResult = handleFeatureDenied('audit_logging', 'team')
    const mcpResponse = formatAsMcpResponse(degradationResult)

    expect(mcpResponse.content).toHaveLength(1)
    expect(mcpResponse.content[0]!.type).toBe('text')
    expect(mcpResponse.isError).toBe(false)
    expect(mcpResponse._meta).toBeDefined()
  })

  it('should include upgrade information in metadata', () => {
    const degradationResult = handleFeatureDenied('sso_saml', 'community')
    const mcpResponse = formatAsMcpResponse(degradationResult)

    expect(mcpResponse._meta?.upgradeRequired).toBe(true)
    expect(mcpResponse._meta?.feature).toBe('sso_saml')
    expect(mcpResponse._meta?.requiredTier).toBe('enterprise')
    expect(mcpResponse._meta?.upgradeUrl).toBeDefined()
    expect(mcpResponse._meta?.pricingUrl).toBeDefined()
  })

  it('should have parseable JSON content', () => {
    const degradationResult = handleFeatureDenied('rbac', 'team')
    const mcpResponse = formatAsMcpResponse(degradationResult)

    const parsed = JSON.parse(mcpResponse.content[0]!.text)

    expect(parsed.status).toBe('upgrade_required')
    expect(parsed.feature).toBe('rbac')
    expect(parsed.requiredTier).toBe('enterprise')
    expect(parsed.currentTier).toBe('team')
    expect(parsed.upgradeUrl).toBeDefined()
    expect(parsed.pricingUrl).toBeDefined()
    expect(parsed.availableFeatures).toBeDefined()
  })
})

// ============================================================================
// Short Notice Tests
// ============================================================================

describe('createShortUpgradeNotice', () => {
  it('should create short notice for team feature', () => {
    const notice = createShortUpgradeNotice('team_workspaces')

    expect(notice).toContain('Team Workspaces')
    expect(notice).toContain('Team feature')
    expect(notice).toContain('https://skillsmith.app/pricing')
  })

  it('should create short notice for enterprise feature', () => {
    const notice = createShortUpgradeNotice('audit_logging')

    expect(notice).toContain('Audit Logging')
    expect(notice).toContain('Enterprise feature')
  })

  it('should be concise', () => {
    const notice = createShortUpgradeNotice('sso_saml')

    // Should be a single line
    expect(notice.split('\n').length).toBe(1)
    // Should be under 150 characters
    expect(notice.length).toBeLessThan(150)
  })
})

// ============================================================================
// Degradation Event Tests
// ============================================================================

describe('createDegradationEvent', () => {
  it('should create event with all required fields', () => {
    const event = createDegradationEvent('sso_saml', 'team', 'mcp-server')

    expect(event.timestamp).toBeDefined()
    expect(event.feature).toBe('sso_saml')
    expect(event.requiredTier).toBe('enterprise')
    expect(event.currentTier).toBe('team')
    expect(event.source).toBe('mcp-server')
  })

  it('should have valid ISO timestamp', () => {
    const event = createDegradationEvent('team_workspaces', 'community', 'cli')
    const timestamp = new Date(event.timestamp)

    expect(timestamp).toBeInstanceOf(Date)
    expect(timestamp.getTime()).not.toBeNaN()
  })

  it('should correctly identify required tier', () => {
    const teamEvent = createDegradationEvent('team_workspaces', 'community', 'test')
    const enterpriseEvent = createDegradationEvent('audit_logging', 'team', 'test')

    expect(teamEvent.requiredTier).toBe('team')
    expect(enterpriseEvent.requiredTier).toBe('enterprise')
  })
})

// ============================================================================
// Integration Tests
// ============================================================================

describe('Integration', () => {
  it('should provide complete upgrade flow for community user wanting team feature', () => {
    const feature: FeatureFlag = 'team_workspaces'
    const currentTier: LicenseTier = 'community'

    // Check the feature
    const checkResult = checkFeatureGracefully(feature, currentTier)
    expect(checkResult).not.toBeNull()

    // Get upgrade prompt
    const prompt = createUpgradePrompt(feature)
    expect(prompt).toContain('Team tier')
    expect(prompt).toContain('$25/user/month')

    // Get detailed message
    const detailed = createDetailedUpgradePrompt(feature, currentTier)
    expect(detailed).toContain('Current tier: Community')
    expect(detailed).toContain('Required tier: Team')

    // Get URLs
    const upgradeUrl = getUpgradeUrl('team', { feature })
    expect(upgradeUrl).toContain('tier=team')
    expect(upgradeUrl).toContain('feature=team_workspaces')
  })

  it('should provide complete upgrade flow for team user wanting enterprise feature', () => {
    const feature: FeatureFlag = 'sso_saml'
    const currentTier: LicenseTier = 'team'

    // Check the feature
    const checkResult = checkFeatureGracefully(feature, currentTier)
    expect(checkResult).not.toBeNull()

    // Should have team features as alternatives
    expect(checkResult?.availableAlternatives).toContain('team_workspaces')

    // Format as MCP response
    const mcpResponse = formatAsMcpResponse(checkResult!)
    expect(mcpResponse._meta?.requiredTier).toBe('enterprise')

    // Get comparison message
    const comparison = createTierComparisonMessage()
    expect(comparison).toContain('Enterprise')
    expect(comparison).toContain('SSO/SAML Integration')
  })

  it('should allow all features for enterprise tier', () => {
    const allFeatures: FeatureFlag[] = [
      'team_workspaces',
      'private_skills',
      'usage_analytics',
      'priority_support',
      'sso_saml',
      'rbac',
      'audit_logging',
      'siem_export',
      'compliance_reports',
      'private_registry',
    ]

    for (const feature of allFeatures) {
      const result = checkFeatureGracefully(feature, 'enterprise')
      expect(result).toBeNull()
    }
  })
})
