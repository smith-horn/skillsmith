/**
 * Terminology Constants
 *
 * Single source of truth for terminology used across documentation.
 * Import these constants instead of hardcoding strings to ensure consistency.
 *
 * @see SMI-1704 - Created after terminology drift was discovered in docs
 * @see docs/retros/2025-01-22-docs-404-recovery.md
 */

/**
 * Trust Tiers - Four-tier system for evaluating skill safety
 */
export const TRUST_TIERS = {
  OFFICIAL: {
    id: 'official',
    label: 'Official',
    description: 'Anthropic or partner skills with full security review',
    color: 'green',
    autoInstall: true,
    reviewRequired: false,
  },
  VERIFIED: {
    id: 'verified',
    label: 'Verified',
    description: 'Publisher verified, quality checked',
    color: 'blue',
    autoInstall: true,
    reviewRequired: false,
  },
  COMMUNITY: {
    id: 'community',
    label: 'Community',
    description: 'Basic scan passed, metadata present',
    color: 'yellow',
    autoInstall: false,
    reviewRequired: true,
  },
  UNVERIFIED: {
    id: 'unverified',
    label: 'Unverified',
    description: 'No verification performed, review before installing',
    color: 'red',
    autoInstall: false,
    reviewRequired: true,
  },
} as const

/**
 * Trust tier type for TypeScript
 */
export type TrustTierId = (typeof TRUST_TIERS)[keyof typeof TRUST_TIERS]['id']

/**
 * Ordered list of trust tiers (highest to lowest trust)
 */
export const TRUST_TIER_ORDER = [
  TRUST_TIERS.OFFICIAL,
  TRUST_TIERS.VERIFIED,
  TRUST_TIERS.COMMUNITY,
  TRUST_TIERS.UNVERIFIED,
] as const

/**
 * Quarantine Severity Levels
 */
export const QUARANTINE_SEVERITY = {
  MALICIOUS: {
    id: 'malicious',
    label: 'MALICIOUS',
    level: 4,
    description: 'Permanent quarantine — security threat detected',
    canInstall: false,
    color: 'red',
  },
  SUSPICIOUS: {
    id: 'suspicious',
    label: 'SUSPICIOUS',
    level: 3,
    description: 'Manual review required before import allowed',
    canInstall: false,
    color: 'orange',
  },
  RISKY: {
    id: 'risky',
    label: 'RISKY',
    level: 2,
    description: 'Can import with warnings displayed',
    canInstall: true,
    color: 'yellow',
  },
  LOW_QUALITY: {
    id: 'low_quality',
    label: 'LOW_QUALITY',
    level: 1,
    description: 'Can import with reduced quality score',
    canInstall: true,
    color: 'gray',
  },
} as const

/**
 * Quarantine severity type
 */
export type QuarantineSeverityId =
  (typeof QUARANTINE_SEVERITY)[keyof typeof QUARANTINE_SEVERITY]['id']

/**
 * Skill Categories
 */
export const SKILL_CATEGORIES = {
  DEVELOPMENT: { id: 'development', label: 'Development' },
  TESTING: { id: 'testing', label: 'Testing' },
  DEVOPS: { id: 'devops', label: 'DevOps' },
  DOCUMENTATION: { id: 'documentation', label: 'Documentation' },
  SECURITY: { id: 'security', label: 'Security' },
  PRODUCTIVITY: { id: 'productivity', label: 'Productivity' },
  DATA: { id: 'data', label: 'Data' },
  AI: { id: 'ai', label: 'AI' },
  OTHER: { id: 'other', label: 'Other' },
} as const

/**
 * Category type
 */
export type CategoryId = (typeof SKILL_CATEGORIES)[keyof typeof SKILL_CATEGORIES]['id']

/**
 * Pricing Tiers
 */
export const PRICING_TIERS = {
  COMMUNITY: {
    id: 'community',
    label: 'Community',
    price: 0,
    priceLabel: 'Free',
    apiCalls: 1000,
    apiCallsLabel: '1,000',
  },
  INDIVIDUAL: {
    id: 'individual',
    label: 'Individual',
    price: 9.99,
    priceLabel: '$9.99/mo',
    apiCalls: 10000,
    apiCallsLabel: '10,000',
  },
  TEAM: {
    id: 'team',
    label: 'Team',
    price: 25,
    priceLabel: '$25/user/mo',
    apiCalls: 100000,
    apiCallsLabel: '100,000',
  },
  ENTERPRISE: {
    id: 'enterprise',
    label: 'Enterprise',
    price: 55,
    priceLabel: '$55/user/mo',
    apiCalls: Infinity,
    apiCallsLabel: 'Unlimited',
  },
} as const

/**
 * Pricing tier type
 */
export type PricingTierId = (typeof PRICING_TIERS)[keyof typeof PRICING_TIERS]['id']

/**
 * Contact Topics (for /contact form)
 */
export const CONTACT_TOPICS = {
  SECURITY: { id: 'security', label: 'Security Issue', path: '/contact?topic=security' },
  VERIFICATION: {
    id: 'verification',
    label: 'Skill Verification',
    path: '/contact?topic=verification',
  },
  SUPPORT: { id: 'support', label: 'Support', path: '/contact?topic=support' },
  ENTERPRISE: { id: 'enterprise', label: 'Enterprise', path: '/contact?topic=enterprise' },
  GENERAL: { id: 'general', label: 'General', path: '/contact?topic=general' },
} as const

/**
 * Helper to get trust tier by ID
 */
export function getTrustTierById(id: string) {
  return Object.values(TRUST_TIERS).find((tier) => tier.id === id)
}

/**
 * Helper to get quarantine severity by ID
 */
export function getQuarantineSeverityById(id: string) {
  return Object.values(QUARANTINE_SEVERITY).find((severity) => severity.id === id)
}
