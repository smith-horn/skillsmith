/**
 * SMI-1062: Stripe Client Types
 *
 * Configuration and type definitions for the Stripe client wrapper.
 */

import type { StripePriceId } from './types.js'

// ============================================================================
// Configuration
// ============================================================================

/**
 * Stripe client configuration
 */
export interface StripeClientConfig {
  /**
   * Stripe secret key (sk_test_xxx or sk_live_xxx)
   */
  secretKey: string

  /**
   * Stripe webhook signing secret (whsec_xxx)
   */
  webhookSecret: string

  /**
   * Price ID mappings for each tier
   */
  prices: TierPriceConfigs

  /**
   * Base URL for success/cancel redirects
   */
  appUrl?: string
}

/**
 * Price configurations for all tiers
 */
export interface TierPriceConfigs {
  individual: {
    monthly: StripePriceId
    annual: StripePriceId
  }
  team: {
    monthly: StripePriceId
    annual: StripePriceId
  }
  enterprise: {
    monthly: StripePriceId
    annual: StripePriceId
  }
}
