/**
 * SMI-3415: Stripe Helper Functions Tests
 *
 * Tests for mapSubscriptionStatus and getPriceIdForTier utilities.
 */

import { describe, it, expect } from 'vitest'
import { mapSubscriptionStatus, getPriceIdForTier } from '../../src/billing/stripe-helpers.js'
import type { StripePriceId } from '../../src/billing/types.js'
import type { TierPriceConfigs } from '../../src/billing/stripe-client-types.js'

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestPrices(): TierPriceConfigs {
  return {
    individual: {
      monthly: 'price_ind_monthly' as StripePriceId,
      annual: 'price_ind_annual' as StripePriceId,
    },
    team: {
      monthly: 'price_team_monthly' as StripePriceId,
      annual: 'price_team_annual' as StripePriceId,
    },
    enterprise: {
      monthly: 'price_ent_monthly' as StripePriceId,
      annual: 'price_ent_annual' as StripePriceId,
    },
  }
}

// ============================================================================
// mapSubscriptionStatus Tests
// ============================================================================

describe('mapSubscriptionStatus', () => {
  it('should map active status', () => {
    expect(mapSubscriptionStatus('active')).toBe('active')
  })

  it('should map past_due status', () => {
    expect(mapSubscriptionStatus('past_due')).toBe('past_due')
  })

  it('should map canceled status', () => {
    expect(mapSubscriptionStatus('canceled')).toBe('canceled')
  })

  it('should map trialing status', () => {
    expect(mapSubscriptionStatus('trialing')).toBe('trialing')
  })

  it('should map paused status', () => {
    expect(mapSubscriptionStatus('paused')).toBe('paused')
  })

  it('should map incomplete status', () => {
    expect(mapSubscriptionStatus('incomplete')).toBe('incomplete')
  })

  it('should map incomplete_expired status', () => {
    expect(mapSubscriptionStatus('incomplete_expired')).toBe('incomplete_expired')
  })

  it('should map unpaid status', () => {
    expect(mapSubscriptionStatus('unpaid')).toBe('unpaid')
  })

  it('should default to active for unknown status', () => {
    // Cast to bypass type safety for edge case testing
    expect(mapSubscriptionStatus('unknown_status' as never)).toBe('active')
  })
})

// ============================================================================
// getPriceIdForTier Tests
// ============================================================================

describe('getPriceIdForTier', () => {
  const prices = createTestPrices()

  it('should return null for community tier', () => {
    expect(getPriceIdForTier(prices, 'community', 'monthly')).toBeNull()
    expect(getPriceIdForTier(prices, 'community', 'annual')).toBeNull()
  })

  it('should return monthly price for individual tier', () => {
    expect(getPriceIdForTier(prices, 'individual', 'monthly')).toBe('price_ind_monthly')
  })

  it('should return annual price for individual tier', () => {
    expect(getPriceIdForTier(prices, 'individual', 'annual')).toBe('price_ind_annual')
  })

  it('should return monthly price for team tier', () => {
    expect(getPriceIdForTier(prices, 'team', 'monthly')).toBe('price_team_monthly')
  })

  it('should return annual price for team tier', () => {
    expect(getPriceIdForTier(prices, 'team', 'annual')).toBe('price_team_annual')
  })

  it('should return monthly price for enterprise tier', () => {
    expect(getPriceIdForTier(prices, 'enterprise', 'monthly')).toBe('price_ent_monthly')
  })

  it('should return annual price for enterprise tier', () => {
    expect(getPriceIdForTier(prices, 'enterprise', 'annual')).toBe('price_ent_annual')
  })

  it('should return null for unknown tier', () => {
    expect(getPriceIdForTier(prices, 'unknown' as never, 'monthly')).toBeNull()
  })
})
