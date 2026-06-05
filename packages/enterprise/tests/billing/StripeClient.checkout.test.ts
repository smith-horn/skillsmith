/**
 * SMI-3415 / SMI-5036: StripeClient — checkout sessions
 *
 * createCheckoutSession (per-tier behaviour + error paths) + getCheckoutSession.
 *
 * All Stripe SDK calls are mocked — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StripePriceId } from '../../src/billing/types.js'
import type { TierPriceConfigs } from '../../src/billing/stripe-client-types.js'

// ============================================================================
// Mock Stripe SDK before importing StripeClient
// ============================================================================

const mockSessionCreate = vi.fn()
const mockSessionRetrieve = vi.fn()

vi.mock('stripe', () => {
  class MockStripeError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.code = code
    }
  }

  class MockStripe {
    customers = { create: vi.fn(), retrieve: vi.fn(), update: vi.fn() }
    checkout = {
      sessions: {
        create: mockSessionCreate,
        retrieve: mockSessionRetrieve,
      },
    }
    subscriptions = {
      retrieve: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      cancel: vi.fn(),
    }
    billingPortal = { sessions: { create: vi.fn() } }
    invoices = { list: vi.fn(), retrieve: vi.fn(), createPreview: vi.fn() }
    webhooks = { constructEvent: vi.fn() }
    static errors = {
      StripeError: MockStripeError,
    }
  }

  return { default: MockStripe }
})

import { StripeClient } from '../../src/billing/StripeClient.js'

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

function createClient(): StripeClient {
  return new StripeClient({
    secretKey: 'sk_test_fake',
    webhookSecret: 'whsec_test_fake',
    prices: createTestPrices(),
    appUrl: 'https://test.skillsmith.app',
  })
}

describe('StripeClient — checkout', () => {
  let client: StripeClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = createClient()
  })

  describe('createCheckoutSession', () => {
    it('should create a checkout session for individual tier', async () => {
      mockSessionCreate.mockResolvedValueOnce({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/session',
      })

      const result = await client.createCheckoutSession({
        tier: 'individual',
        billingPeriod: 'monthly',
        successUrl: 'https://test.com/success',
        cancelUrl: 'https://test.com/cancel',
        email: 'user@example.com',
      })

      expect(result.sessionId).toBe('cs_test_123')
      expect(result.url).toBe('https://checkout.stripe.com/session')
    })

    it('should enable adjustable quantity for team tier', async () => {
      mockSessionCreate.mockResolvedValueOnce({
        id: 'cs_team',
        url: 'https://checkout.stripe.com/team',
      })

      await client.createCheckoutSession({
        tier: 'team',
        billingPeriod: 'monthly',
        seatCount: 5,
        successUrl: 'https://test.com/success',
        cancelUrl: 'https://test.com/cancel',
      })

      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: expect.arrayContaining([
            expect.objectContaining({
              adjustable_quantity: { enabled: true, minimum: 1, maximum: 1000 },
            }),
          ]),
        })
      )
    })

    it('should enable adjustable quantity for enterprise tier', async () => {
      mockSessionCreate.mockResolvedValueOnce({
        id: 'cs_ent',
        url: 'https://checkout.stripe.com/ent',
      })

      await client.createCheckoutSession({
        tier: 'enterprise',
        billingPeriod: 'annual',
        successUrl: 'https://test.com/success',
        cancelUrl: 'https://test.com/cancel',
      })

      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: expect.arrayContaining([
            expect.objectContaining({
              adjustable_quantity: expect.objectContaining({ enabled: true }),
            }),
          ]),
        })
      )
    })

    it('should attach customerId when provided', async () => {
      mockSessionCreate.mockResolvedValueOnce({ id: 'cs_cust', url: 'url' })

      await client.createCheckoutSession({
        tier: 'individual',
        billingPeriod: 'monthly',
        customerId: 'cus_existing',
        successUrl: 'https://test.com/success',
        cancelUrl: 'https://test.com/cancel',
      })

      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_existing' })
      )
    })

    it('should throw BillingError for community tier (no price)', async () => {
      await expect(
        client.createCheckoutSession({
          tier: 'community',
          billingPeriod: 'monthly',
          successUrl: 'https://test.com/success',
          cancelUrl: 'https://test.com/cancel',
        })
      ).rejects.toThrow('No price configured for tier: community')
    })

    it('should throw BillingError on Stripe API failure', async () => {
      mockSessionCreate.mockRejectedValueOnce(new Error('API error'))

      await expect(
        client.createCheckoutSession({
          tier: 'individual',
          billingPeriod: 'monthly',
          successUrl: 'https://test.com/success',
          cancelUrl: 'https://test.com/cancel',
        })
      ).rejects.toThrow('Failed to create checkout session')
    })
  })

  describe('getCheckoutSession', () => {
    it('should retrieve session with expanded fields', async () => {
      const session = { id: 'cs_test', customer: 'cus_1', subscription: 'sub_1' }
      mockSessionRetrieve.mockResolvedValueOnce(session)

      const result = await client.getCheckoutSession('cs_test' as never)
      expect(result).toEqual(session)
      expect(mockSessionRetrieve).toHaveBeenCalledWith('cs_test', {
        expand: ['subscription', 'customer'],
      })
    })
  })
})
