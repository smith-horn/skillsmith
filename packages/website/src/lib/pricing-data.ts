/**
 * Pricing tier data and utilities
 *
 * @module lib/pricing-data
 *
 * SMI-2081: Extracted from pricing.astro to comply with 500-line limit
 * Source of truth for pricing tiers from ADR-013 (Open Core Licensing)
 * and ADR-017 (Quota Enforcement).
 */

/**
 * Pricing tier structure
 */
export interface PricingTier {
  name: string
  monthlyPrice: number // Price in dollars (0 for free)
  period?: string
  description: string
  apiCalls: string
  features: string[]
  cta: string
  ctaHref: string
  highlighted?: boolean
}

/**
 * FAQ item structure
 */
export interface PricingFaq {
  question: string
  answer: string
}

/**
 * Annual pricing discount: Pay for 10 months, get 12 (17% savings)
 */
export const ANNUAL_DISCOUNT_MONTHS = 10

/**
 * Format price for display
 *
 * @param price - Price in dollars
 * @returns Formatted price string (e.g., "Free" or "$9.99")
 */
export function formatPrice(price: number): string {
  if (price === 0) return 'Free'
  return `$${price}`
}

/**
 * Calculate annual price from monthly price
 *
 * @param monthlyPrice - Monthly price in dollars
 * @returns Annual price (10 months for 12 months of service)
 */
export function getAnnualPrice(monthlyPrice: number): number {
  return monthlyPrice * ANNUAL_DISCOUNT_MONTHS
}

/**
 * Pricing tiers as defined in ADR-013 and ADR-017
 */
export const pricingTiers: PricingTier[] = [
  {
    name: 'Community',
    monthlyPrice: 0,
    description: 'Perfect for exploring Skillsmith and personal projects.',
    apiCalls: '1,000 API calls/month',
    features: [
      'Skill search and discovery',
      'Skill installation',
      'Basic recommendations',
      'Community support',
      'Public skill access',
    ],
    cta: 'Get Started',
    ctaHref: '/signup?tier=community',
  },
  {
    name: 'Individual',
    monthlyPrice: 9.99,
    period: '/month',
    description: 'For developers who want deeper insights into their skill usage.',
    apiCalls: '10,000 API calls/month',
    features: [
      'Everything in Community',
      'Basic analytics dashboard',
      'Usage statistics',
      'Email support',
      'Priority skill indexing',
    ],
    cta: 'Start Trial',
    ctaHref: '/signup?tier=individual',
  },
  {
    name: 'Team',
    monthlyPrice: 25,
    period: '/user/month',
    description: 'Collaborate on skills with your entire team.',
    apiCalls: '100,000 API calls/month',
    features: [
      'Everything in Individual',
      'Team workspaces',
      'Private skills',
      'Team dashboard',
      'Skill sharing controls',
      'Priority support',
    ],
    cta: 'Start Trial',
    ctaHref: '/signup?tier=team',
    highlighted: true,
  },
  {
    name: 'Enterprise',
    monthlyPrice: 55,
    period: '/user/month',
    description: 'Advanced security, compliance, and dedicated support for organizations.',
    apiCalls: 'Unlimited API calls',
    features: [
      'Everything in Team',
      'SSO / SAML integration',
      'Role-based access control',
      'Audit logging',
      '99.9% SLA guarantee',
      'Dedicated support',
      'Custom integrations',
    ],
    cta: 'Contact Sales',
    ctaHref: '/contact?tier=enterprise',
  },
]

/**
 * FAQ entries for pricing page
 */
export const pricingFaqs: PricingFaq[] = [
  {
    question: 'What counts as an API call?',
    answer:
      'Each skill search, recommendation request, or skill installation counts as one API call. Viewing cached results does not count against your quota.',
  },
  {
    question: 'Can I change plans at any time?',
    answer:
      'Yes, you can upgrade or downgrade your plan at any time. Changes take effect at the start of your next billing cycle.',
  },
  {
    question: 'What happens if I exceed my API limit?',
    answer:
      "You'll receive a notification when approaching your limit. Once exceeded, API calls will be rate-limited until the next billing cycle or until you upgrade.",
  },
  {
    question: 'Is there a free trial for paid plans?',
    answer:
      'Yes, Individual and Team plans include a 14-day free trial. Enterprise trials are available upon request.',
  },
  {
    question: "What's included in the SLA?",
    answer:
      'Enterprise customers receive a 99.9% uptime guarantee with service credits if we fail to meet this commitment.',
  },
]
