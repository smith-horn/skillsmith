/**
 * Pricing tier data and utilities
 *
 * @module lib/pricing-data
 *
 * SMI-2081: Extracted from pricing.astro to comply with 500-line limit
 * SMI-3909: Consolidated as single canonical source for all pricing data
 * Source of truth for pricing tiers from ADR-013 (Open Core Licensing)
 * and ADR-017 (Quota Enforcement).
 */

import type { PricingTier, PricingFeature } from '../types/index.js'
export type { PricingTier, PricingFeature }

/**
 * FAQ item structure
 *
 * Represents a single FAQ entry on the pricing page.
 */
export interface PricingFaq {
  /** The FAQ question */
  question: string
  /** The FAQ answer */
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
 * Format API call limit for display
 *
 * @param calls - Numeric API call limit or 'unlimited'
 * @returns Formatted string (e.g., "1,000 API calls/month" or "Unlimited API calls")
 */
export function formatApiCalls(calls: number | 'unlimited'): string {
  if (calls === 'unlimited') return 'Unlimited API calls'
  return `${calls.toLocaleString()} API calls/month`
}

/**
 * Get a pricing tier by its ID
 *
 * @param id - Tier identifier
 * @returns The matching tier, or undefined
 */
export function getTierById(id: PricingTier['id']): PricingTier | undefined {
  return pricingTiers.find((tier) => tier.id === id)
}

/**
 * Pricing tiers as defined in ADR-013 and ADR-017
 */
export const pricingTiers: PricingTier[] = [
  {
    id: 'community',
    name: 'Community',
    monthlyPrice: 0,
    description: 'Perfect for exploring Skillsmith and personal projects.',
    apiCalls: 1000,
    apiCallsFormatted: '1,000 API calls/month',
    features: [
      { name: 'Skill search and discovery' },
      { name: 'Skill installation' },
      { name: 'Basic recommendations' },
      { name: 'Community support' },
      { name: 'Public skill access' },
    ],
    cta: 'Get Started',
    ctaHref: '/signup?tier=community',
  },
  {
    id: 'individual',
    name: 'Individual',
    monthlyPrice: 9.99,
    period: '/month',
    description: 'For developers who want deeper insights into their skill usage.',
    apiCalls: 10000,
    apiCallsFormatted: '10,000 API calls/month',
    features: [
      { name: 'Everything in Community' },
      { name: 'Basic analytics dashboard' },
      { name: 'Usage statistics' },
      { name: 'Email support' },
      { name: 'Priority skill indexing' },
    ],
    cta: 'Start Trial',
    ctaHref: '/signup?tier=individual',
  },
  {
    id: 'team',
    name: 'Team',
    monthlyPrice: 25,
    period: '/user/month',
    description: 'Collaborate on skills with your entire team.',
    apiCalls: 100000,
    apiCallsFormatted: '100,000 API calls/month',
    features: [
      { name: 'Everything in Individual' },
      { name: '100,000 API calls/month' },
      { name: 'Priority support' },
    ],
    cta: 'Start Trial',
    ctaHref: '/signup?tier=team',
    highlighted: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyPrice: 55,
    period: '/user/month',
    description: 'Advanced security, compliance, and dedicated support for organizations.',
    apiCalls: 'unlimited',
    apiCallsFormatted: 'Unlimited API calls',
    features: [
      { name: 'Everything in Team' },
      { name: 'Unlimited API calls' },
      { name: '99.9% SLA guarantee' },
      { name: 'Dedicated support' },
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
