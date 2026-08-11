/**
 * Static tool/feature/tier mapping data tests.
 *
 * Split from license.test.ts (500-line standard) — these tests exercise
 * static data structures (TOOL_FEATURES, FEATURE_DISPLAY_NAMES, FEATURE_TIERS)
 * and the pure getExpirationWarning() function, independent of any
 * LicenseMiddleware instance.
 *
 * @see SMI-1055: Add license middleware to MCP server
 * @see SMI-1091: Unified tier feature definitions across packages
 */

import { describe, it, expect, vi } from 'vitest'
import {
  getExpirationWarning,
  TOOL_FEATURES,
  FEATURE_DISPLAY_NAMES,
  FEATURE_TIERS,
  type FeatureFlag,
} from '../../middleware/license.js'

// Time constants for readability
const MS_PER_DAY = 24 * 60 * 60 * 1000

describe('TOOL_FEATURES mapping', () => {
  it('should have null for all community tools', () => {
    const communityTools = ['search', 'get_skill', 'install_skill', 'uninstall_skill']
    for (const tool of communityTools) {
      expect(TOOL_FEATURES[tool]).toBeNull()
    }
  })

  it('should have valid feature flags for licensed tools', () => {
    const licensedTools = Object.entries(TOOL_FEATURES).filter(([, v]) => v !== null)
    expect(licensedTools.length).toBeGreaterThan(0)

    for (const [_tool, feature] of licensedTools) {
      expect(FEATURE_DISPLAY_NAMES[feature as FeatureFlag]).toBeDefined()
      expect(FEATURE_TIERS[feature as FeatureFlag]).toBeDefined()
    }
  })
})

describe('registry_approval flag (SMI-5949 D-11)', () => {
  it('keeps private_registry_publish and private_registry_manage mapped to private_registry, not registry_approval', () => {
    // D-11: the approval gate is a separately-priced FeatureFlag, but wiring
    // it into TOOL_FEATURES would be actively harmful — TOOL_FEATURES is
    // tool-granular (one flag per tool), private_registry_manage also serves
    // list/get/deprecate/undeprecate/namespace/install, and a live
    // checkFeature('registry_approval') has no tier-default fallback so it
    // would deny every already-issued Enterprise license until reissued.
    expect(TOOL_FEATURES['private_registry_publish']).toBe('private_registry')
    expect(TOOL_FEATURES['private_registry_manage']).toBe('private_registry')
  })

  it('never maps any TOOL_FEATURES row to registry_approval', () => {
    // Enforced, not implicit (D-11): a future "helpful" one-line wiring of
    // registry_approval into TOOL_FEATURES would deny every already-issued
    // Enterprise license, because those licenses' features array is frozen
    // at generation time and checkFeature() has no tier-default fallback.
    // Re-issuing every Enterprise license is the prerequisite named in D-11's
    // wiring point before this assertion may ever be relaxed.
    const registryApprovalRows = Object.entries(TOOL_FEATURES).filter(
      ([, feature]) => feature === 'registry_approval'
    )
    expect(registryApprovalRows).toEqual([])
  })

  it('still defines registry_approval in the catalog (display name + tier), just not in TOOL_FEATURES', () => {
    expect(FEATURE_DISPLAY_NAMES['registry_approval']).toBeDefined()
    expect(FEATURE_TIERS['registry_approval']).toBe('enterprise')
  })
})

describe('FEATURE_DISPLAY_NAMES', () => {
  it('should have display names for all features', () => {
    const features: FeatureFlag[] = [
      'private_skills',
      'team_workspaces',
      'sso_saml',
      'audit_logging',
      'rbac',
      'priority_support',
      'custom_integrations',
      'advanced_analytics',
    ]

    for (const feature of features) {
      expect(FEATURE_DISPLAY_NAMES[feature]).toBeDefined()
      expect(typeof FEATURE_DISPLAY_NAMES[feature]).toBe('string')
    }
  })
})

describe('FEATURE_TIERS', () => {
  it('should categorize features into team or enterprise', () => {
    const teamFeatures: FeatureFlag[] = ['private_skills', 'team_workspaces', 'priority_support']
    const enterpriseFeatures: FeatureFlag[] = [
      'sso_saml',
      'audit_logging',
      'rbac',
      'custom_integrations',
      'advanced_analytics',
    ]

    for (const feature of teamFeatures) {
      expect(FEATURE_TIERS[feature]).toBe('team')
    }

    for (const feature of enterpriseFeatures) {
      expect(FEATURE_TIERS[feature]).toBe('enterprise')
    }
  })
})

describe('getExpirationWarning', () => {
  it('should return warning when license expires within 30 days', () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-01-15T12:00:00Z')
      vi.setSystemTime(now)

      const expiresIn15Days = new Date(now.getTime() + 15 * MS_PER_DAY)
      const warning = getExpirationWarning(expiresIn15Days)

      expect(warning).toBe(
        'Your license expires in 15 days. Please renew to avoid service interruption.'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('should use singular day when 1 day remaining', () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-01-15T12:00:00Z')
      vi.setSystemTime(now)

      const expiresIn1Day = new Date(now.getTime() + 1 * MS_PER_DAY)
      const warning = getExpirationWarning(expiresIn1Day)

      expect(warning).toBe(
        'Your license expires in 1 day. Please renew to avoid service interruption.'
      )
      expect(warning).not.toContain('1 days')
    } finally {
      vi.useRealTimers()
    }
  })

  it('should not return warning when license expires in more than 30 days', () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-01-15T12:00:00Z')
      vi.setSystemTime(now)

      const expiresIn31Days = new Date(now.getTime() + 31 * MS_PER_DAY)
      const warning = getExpirationWarning(expiresIn31Days)

      expect(warning).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('should not return warning when expiresAt is undefined', () => {
    const warning = getExpirationWarning(undefined)
    expect(warning).toBeUndefined()
  })

  it('should not return warning when license is already expired (daysUntilExpiry <= 0)', () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-01-15T12:00:00Z')
      vi.setSystemTime(now)

      const expiredYesterday = new Date(now.getTime() - 1 * MS_PER_DAY)
      const warning = getExpirationWarning(expiredYesterday)

      // When license has already expired, no "expiring soon" warning is shown
      expect(warning).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('should return warning at exactly 30 days', () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-01-15T12:00:00Z')
      vi.setSystemTime(now)

      const expiresIn30Days = new Date(now.getTime() + 30 * MS_PER_DAY)
      const warning = getExpirationWarning(expiresIn30Days)

      expect(warning).toBe(
        'Your license expires in 30 days. Please renew to avoid service interruption.'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('should not return warning when license expires today (0 days)', () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-01-15T12:00:00Z')
      vi.setSystemTime(now)

      // Expires today - 0 days remaining (edge case: daysUntilExpiry > 0 check)
      const expiresToday = new Date(now.getTime() + 1) // Just 1ms in the future
      const warning = getExpirationWarning(expiresToday)

      expect(warning).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Tool Feature Mapping Integration', () => {
  it('should cover all documented tool names', () => {
    // These are the core tools from the MCP server
    const coreTools = [
      'search',
      'get_skill',
      'install_skill',
      'uninstall_skill',
      'skill_recommend',
      'skill_validate',
      'skill_compare',
      'skill_suggest',
    ]

    for (const tool of coreTools) {
      expect(tool in TOOL_FEATURES).toBe(true)
      expect(TOOL_FEATURES[tool]).toBeNull() // All core tools should be community
    }
  })

  it('should have consistent tier assignments', () => {
    // Verify that enterprise features are truly enterprise-level
    const enterpriseFeatures = Object.entries(FEATURE_TIERS)
      .filter(([, tier]) => tier === 'enterprise')
      .map(([feature]) => feature)

    // SSO, audit, and RBAC should all be enterprise
    expect(enterpriseFeatures).toContain('sso_saml')
    expect(enterpriseFeatures).toContain('audit_logging')
    expect(enterpriseFeatures).toContain('rbac')
  })
})
