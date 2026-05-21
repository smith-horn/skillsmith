/**
 * SMI-3415 / SMI-5036: StripeClient — portal, invoices, webhook sig, misc
 *
 * createPortalSession / list+get+upcoming Invoice / verifyWebhookSignature /
 * getPriceId / static mapSubscriptionStatus / getStripeInstance.
 *
 * All Stripe SDK calls are mocked — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StripePriceId } from '../../src/billing/types.js'
import type { TierPriceConfigs } from '../../src/billing/stripe-client-types.js'

// ============================================================================
// Mock Stripe SDK before importing StripeClient
// ============================================================================

const mockConstructEvent = vi.fn()
const mockPortalCreate = vi.fn()
const mockInvoiceList = vi.fn()
const mockInvoiceRetrieve = vi.fn()
const mockInvoiceCreatePreview = vi.fn()

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
      retrieve: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      cancel: vi.fn(),
    }
    billingPortal = {
      sessions: {
        create: mockPortalCreate,
      },
    }
    invoices = {
      list: mockInvoiceList,
      retrieve: mockInvoiceRetrieve,
      createPreview: mockInvoiceCreatePreview,
    }
    webhooks = {
      constructEvent: mockConstructEvent,
    }
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

describe('StripeClient — portal / invoices / misc', () => {
  let client: StripeClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = createClient()
  })

  describe('createPortalSession', () => {
    it('should create a portal session', async () => {
      mockPortalCreate.mockResolvedValueOnce({ url: 'https://billing.stripe.com/portal' })

      const result = await client.createPortalSession({
        customerId: 'cus_test',
        returnUrl: 'https://test.com/account',
      })

      expect(result.url).toBe('https://billing.stripe.com/portal')
    })

    it('should throw BillingError on failure', async () => {
      mockPortalCreate.mockRejectedValueOnce(new Error('API error'))

      await expect(
        client.createPortalSession({
          customerId: 'cus_test',
          returnUrl: 'https://test.com/account',
        })
      ).rejects.toThrow('Failed to create portal session')
    })
  })

  describe('listInvoices', () => {
    it('should list invoices with defaults', async () => {
      mockInvoiceList.mockResolvedValueOnce({
        data: [{ id: 'in_1' }],
        has_more: false,
      })

      const result = await client.listInvoices('cus_test' as never)
      expect(result.invoices).toHaveLength(1)
      expect(result.hasMore).toBe(false)
      expect(mockInvoiceList).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_test', limit: 10 })
      )
    })

    it('should pass custom limit and startingAfter', async () => {
      mockInvoiceList.mockResolvedValueOnce({
        data: [],
        has_more: false,
      })

      await client.listInvoices('cus_test' as never, {
        limit: 5,
        startingAfter: 'in_prev',
      })

      expect(mockInvoiceList).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5, starting_after: 'in_prev' })
      )
    })
  })

  describe('getInvoice', () => {
    it('should return invoice when found', async () => {
      const invoice = { id: 'in_test', amount_paid: 999 }
      mockInvoiceRetrieve.mockResolvedValueOnce(invoice)

      const result = await client.getInvoice('in_test')
      expect(result).toEqual(invoice)
    })

    it('should return null for resource_missing', async () => {
      const Stripe = (await import('stripe')).default
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = new (Stripe.errors.StripeError as any)('Not found', 'resource_missing')
      mockInvoiceRetrieve.mockRejectedValueOnce(err)

      const result = await client.getInvoice('in_missing')
      expect(result).toBeNull()
    })
  })

  describe('getUpcomingInvoice', () => {
    it('should return upcoming invoice preview', async () => {
      const preview = { id: 'in_upcoming', amount_due: 2500 }
      mockInvoiceCreatePreview.mockResolvedValueOnce(preview)

      const result = await client.getUpcomingInvoice('cus_test' as never)
      expect(result).toEqual(preview)
    })

    it('should return null when no upcoming invoice', async () => {
      const Stripe = (await import('stripe')).default
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = new (Stripe.errors.StripeError as any)('No upcoming', 'invoice_upcoming_none')
      mockInvoiceCreatePreview.mockRejectedValueOnce(err)

      const result = await client.getUpcomingInvoice('cus_test' as never)
      expect(result).toBeNull()
    })
  })

  describe('verifyWebhookSignature', () => {
    it('should return event on valid signature', () => {
      const fakeEvent = { id: 'evt_test', type: 'customer.subscription.created' }
      mockConstructEvent.mockReturnValueOnce(fakeEvent)

      const result = client.verifyWebhookSignature('payload', 'sig_header')
      expect(result).toEqual(fakeEvent)
    })

    it('should throw BillingError on invalid signature', () => {
      mockConstructEvent.mockImplementationOnce(() => {
        throw new Error('Signature mismatch')
      })

      expect(() => client.verifyWebhookSignature('bad', 'bad_sig')).toThrow(
        'Invalid webhook signature'
      )
    })
  })

  describe('getPriceId', () => {
    it('should return null for community tier', () => {
      expect(client.getPriceId('community', 'monthly')).toBeNull()
    })

    it('should return correct price for individual monthly', () => {
      expect(client.getPriceId('individual', 'monthly')).toBe('price_ind_monthly')
    })

    it('should return correct price for team annual', () => {
      expect(client.getPriceId('team', 'annual')).toBe('price_team_annual')
    })

    it('should return null for unknown tier', () => {
      expect(client.getPriceId('unknown' as never, 'monthly')).toBeNull()
    })
  })

  describe('mapSubscriptionStatus (static)', () => {
    it('should delegate to stripe-helpers', () => {
      expect(StripeClient.mapSubscriptionStatus('active')).toBe('active')
      expect(StripeClient.mapSubscriptionStatus('canceled')).toBe('canceled')
      expect(StripeClient.mapSubscriptionStatus('past_due')).toBe('past_due')
    })
  })

  describe('getStripeInstance', () => {
    it('should return the underlying Stripe instance', () => {
      const instance = client.getStripeInstance()
      expect(instance).toBeDefined()
      expect(instance.customers).toBeDefined()
    })
  })
})
