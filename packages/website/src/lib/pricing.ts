/**
 * Pricing tier configuration
 *
 * Based on ADR-013 (Open Core Licensing) and ADR-017 (Quota Enforcement)
 * Four-tier pricing model with usage quotas
 */

import type { PricingTier } from '../types/index'

/**
 * Complete pricing tier definitions
 */
export const PRICING_TIERS: PricingTier[] = [
  {
    id: 'community',
    name: 'Community',
    price: 0,
    priceUnit: 'month',
    apiCalls: 1000,
    features: [
      'Core skill discovery',
      'Public skill search',
      'Basic skill installation',
      '1,000 API calls/month',
      'Community support',
    ],
    ctaText: 'Get Started Free',
    ctaLink: '/signup?tier=community',
  },
  {
    id: 'individual',
    name: 'Individual',
    price: 9.99,
    priceUnit: 'month',
    apiCalls: 10000,
    features: [
      'Everything in Community',
      '10,000 API calls/month',
      'Basic analytics dashboard',
      'Skill recommendations',
      'Priority search results',
      'Email support',
    ],
    ctaText: 'Start Trial',
    ctaLink: '/signup?tier=individual',
  },
  {
    id: 'team',
    name: 'Team',
    price: 25,
    priceUnit: 'user/month',
    apiCalls: 100000,
    highlighted: true,
    features: [
      'Everything in Individual',
      '100,000 API calls/month',
      'Team workspaces',
      'Private skill sharing',
      'Advanced analytics',
      'Skill version management',
      'Priority support',
    ],
    ctaText: 'Start Trial',
    ctaLink: '/signup?tier=team',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 55,
    priceUnit: 'user/month',
    apiCalls: 'unlimited',
    features: [
      'Everything in Team',
      'Unlimited API calls',
      'SSO/SAML integration',
      'Role-based access control',
      'Audit logging',
      'Custom skill hosting',
      'SLA guarantees',
      'Dedicated support',
      'On-premise deployment option',
    ],
    ctaText: 'Contact Sales',
    ctaLink: '/contact?tier=enterprise',
  },
]

/**
 * Format price for display
 */
export function formatPrice(tier: PricingTier): string {
  if (tier.price === null) return 'Custom'
  if (tier.price === 0) return 'Free'
  return `$${tier.price}`
}

/**
 * Format API call limit for display
 */
export function formatApiCalls(calls: number | 'unlimited'): string {
  if (calls === 'unlimited') return 'Unlimited'
  return calls.toLocaleString()
}

/**
 * Get tier by ID
 */
export function getTierById(id: PricingTier['id']): PricingTier | undefined {
  return PRICING_TIERS.find((tier) => tier.id === id)
}
