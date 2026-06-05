/**
 * SMI-1069: Stripe Reconciliation Helpers
 *
 * Helper functions for mapping Stripe statuses to local statuses.
 */

import type Stripe from 'stripe'
import type { SubscriptionStatus } from './types.js'

// ============================================================================
// Status Mapping Functions
// ============================================================================

/**
 * Map Stripe subscription status to local subscription status
 */
export function mapStripeStatus(stripeStatus: Stripe.Subscription.Status): SubscriptionStatus {
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

/**
 * Map Stripe invoice status to local invoice status
 */
export function mapInvoiceStatus(stripeStatus: Stripe.Invoice.Status | null): string {
  switch (stripeStatus) {
    case 'paid':
      return 'paid'
    case 'open':
      return 'open'
    case 'draft':
      return 'draft'
    case 'void':
      return 'void'
    case 'uncollectible':
      return 'uncollectible'
    default:
      return 'open'
  }
}
