/**
 * SMI-1062: Stripe Helper Functions
 *
 * Utility functions for Stripe operations.
 */

import type Stripe from 'stripe'
import type { SubscriptionStatus, LicenseTier, BillingPeriod, StripePriceId } from './types.js'
import type { TierPriceConfigs } from './stripe-client-types.js'

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Map Stripe subscription status to our internal status
 */
export function mapSubscriptionStatus(
  stripeStatus: Stripe.Subscription.Status
): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
      return 'active'
    case 'past_due':
      return 'past_due'
    case 'canceled':
      return 'canceled'
    case 'trialing':
      return 'trialing'
    case 'paused':
      return 'paused'
    case 'incomplete':
      return 'incomplete'
    case 'incomplete_expired':
      return 'incomplete_expired'
    case 'unpaid':
      return 'unpaid'
    default:
      return 'active'
  }
}

// ============================================================================
// Price Helpers
// ============================================================================

/**
 * Get the price ID for a tier and billing period
 */
export function getPriceIdForTier(
  prices: TierPriceConfigs,
  tier: LicenseTier,
  billingPeriod: BillingPeriod
): StripePriceId | null {
  if (tier === 'community') {
    return null // Community tier is free, no Stripe price
  }

  const tierPrices = prices[tier as keyof TierPriceConfigs]
  if (!tierPrices) {
    return null
  }

  return tierPrices[billingPeriod]
}
