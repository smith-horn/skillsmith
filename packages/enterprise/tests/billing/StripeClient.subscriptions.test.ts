/**
 * SMI-3415 / SMI-5036: StripeClient — subscription management
 *
 * get/list/update/cancel/reactivate subscription paths.
 *
 * All Stripe SDK calls are mocked — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StripePriceId } from '../../src/billing/types.js'
import type { TierPriceConfigs } from '../../src/billing/stripe-client-types.js'

// ============================================================================
// Mock Stripe SDK before importing StripeClient
// ============================================================================

const mockSubRetrieve = vi.fn()
const mockSubList = vi.fn()
const mockSubUpdate = vi.fn()
const mockSubCancel = vi.fn()

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
    checkout = { sessions: { create: vi.fn(), retrieve: vi.fn() } }
    subscriptions = {
      retrieve: mockSubRetrieve,
      list: mockSubList,
      update: mockSubUpdate,
      cancel: mockSubCancel,
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

describe('StripeClient — subscriptions', () => {
  let client: StripeClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = createClient()
  })

  describe('getSubscription', () => {
    it('should return subscription when found', async () => {
      const sub = { id: 'sub_test', status: 'active' }
      mockSubRetrieve.mockResolvedValueOnce(sub)

      const result = await client.getSubscription('sub_test' as never)
      expect(result).toEqual(sub)
    })

    it('should return null for resource_missing', async () => {
      const Stripe = (await import('stripe')).default
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = new (Stripe.errors.StripeError as any)('Not found', 'resource_missing')
      mockSubRetrieve.mockRejectedValueOnce(err)

      const result = await client.getSubscription('sub_missing' as never)
      expect(result).toBeNull()
    })
  })

  describe('listSubscriptions', () => {
    it('should list subscriptions for a customer', async () => {
      const subs = { data: [{ id: 'sub_1' }, { id: 'sub_2' }] }
      mockSubList.mockResolvedValueOnce(subs)

      const result = await client.listSubscriptions('cus_test' as never)
      expect(result).toHaveLength(2)
      expect(mockSubList).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_test',
          status: 'all',
        })
      )
    })
  })

  describe('updateSubscription', () => {
    it('should update tier and billing period', async () => {
      const existingSub = {
        id: 'sub_test',
        items: { data: [{ id: 'si_1', quantity: 1 }] },
        metadata: {},
      }
      mockSubRetrieve.mockResolvedValueOnce(existingSub)
      mockSubUpdate.mockResolvedValueOnce({ ...existingSub, status: 'active' })

      const result = await client.updateSubscription('sub_test' as never, {
        tier: 'team',
        billingPeriod: 'annual',
        seatCount: 10,
      })

      expect(result).toBeDefined()
      expect(mockSubUpdate).toHaveBeenCalled()
    })

    it('should update seat count only', async () => {
      const existingSub = {
        id: 'sub_test',
        items: { data: [{ id: 'si_1', quantity: 5 }] },
        metadata: {},
      }
      mockSubRetrieve.mockResolvedValueOnce(existingSub)
      mockSubUpdate.mockResolvedValueOnce({ ...existingSub })

      await client.updateSubscription('sub_test' as never, {
        seatCount: 10,
      })

      expect(mockSubUpdate).toHaveBeenCalledWith(
        'sub_test',
        expect.objectContaining({
          items: [{ id: 'si_1', quantity: 10 }],
        })
      )
    })

    it('should throw when subscription not found', async () => {
      const Stripe = (await import('stripe')).default
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = new (Stripe.errors.StripeError as any)('Not found', 'resource_missing')
      mockSubRetrieve.mockRejectedValueOnce(err)

      await expect(
        client.updateSubscription('sub_missing' as never, { seatCount: 5 })
      ).rejects.toThrow('Subscription not found')
    })

    it('should throw BillingError on update API failure', async () => {
      const existingSub = {
        id: 'sub_test',
        items: { data: [{ id: 'si_1', quantity: 1 }] },
        metadata: {},
      }
      mockSubRetrieve.mockResolvedValueOnce(existingSub)
      mockSubUpdate.mockRejectedValueOnce(new Error('API error'))

      await expect(
        client.updateSubscription('sub_test' as never, { seatCount: 5 })
      ).rejects.toThrow('Failed to update subscription')
    })

    it('should disable proration when prorate=false', async () => {
      const existingSub = {
        id: 'sub_test',
        items: { data: [{ id: 'si_1', quantity: 1 }] },
        metadata: {},
      }
      mockSubRetrieve.mockResolvedValueOnce(existingSub)
      mockSubUpdate.mockResolvedValueOnce({ ...existingSub })

      await client.updateSubscription('sub_test' as never, {
        seatCount: 3,
        prorate: false,
      })

      expect(mockSubUpdate).toHaveBeenCalledWith(
        'sub_test',
        expect.objectContaining({ proration_behavior: 'none' })
      )
    })
  })

  describe('cancelSubscription', () => {
    it('should cancel immediately when option set', async () => {
      mockSubCancel.mockResolvedValueOnce({ id: 'sub_test', status: 'canceled' })

      await client.cancelSubscription('sub_test' as never, {
        immediately: true,
        feedback: 'Too expensive',
      })

      expect(mockSubCancel).toHaveBeenCalledWith('sub_test', {
        cancellation_details: { comment: 'Too expensive' },
      })
    })

    it('should cancel at period end by default', async () => {
      mockSubUpdate.mockResolvedValueOnce({ id: 'sub_test', cancel_at_period_end: true })

      await client.cancelSubscription('sub_test' as never, {
        feedback: 'Switching providers',
      })

      expect(mockSubUpdate).toHaveBeenCalledWith('sub_test', {
        cancel_at_period_end: true,
        cancellation_details: { comment: 'Switching providers' },
      })
    })

    it('should cancel at period end with no options', async () => {
      mockSubUpdate.mockResolvedValueOnce({ id: 'sub_test', cancel_at_period_end: true })

      await client.cancelSubscription('sub_test' as never)

      // SMI-5035: under exactOptionalPropertyTypes, the cancel call now omits
      // `cancellation_details` entirely when no feedback was supplied — rather
      // than passing `{ comment: undefined }`.
      expect(mockSubUpdate).toHaveBeenCalledWith('sub_test', {
        cancel_at_period_end: true,
      })
    })

    it('should throw BillingError on cancellation failure', async () => {
      mockSubUpdate.mockRejectedValueOnce(new Error('API error'))

      await expect(client.cancelSubscription('sub_test' as never)).rejects.toThrow(
        'Failed to cancel subscription'
      )
    })
  })

  describe('reactivateSubscription', () => {
    it('should set cancel_at_period_end to false', async () => {
      mockSubUpdate.mockResolvedValueOnce({ id: 'sub_test', cancel_at_period_end: false })

      await client.reactivateSubscription('sub_test' as never)

      expect(mockSubUpdate).toHaveBeenCalledWith('sub_test', {
        cancel_at_period_end: false,
      })
    })
  })
})
