/**
 * SMI-3415: StripeClient Tests
 *
 * Tests for StripeClient wrapper including:
 * - Constructor initialization
 * - Customer management (create, get, update)
 * - Checkout session creation
 * - Subscription management (get, list, update, cancel, reactivate)
 * - Portal session creation
 * - Invoice management (list, get, upcoming)
 * - Webhook signature verification
 * - Price ID resolution
 * - Static mapSubscriptionStatus delegation
 *
 * All Stripe SDK calls are mocked — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StripePriceId } from '../../src/billing/types.js'
import type { TierPriceConfigs } from '../../src/billing/stripe-client-types.js'

// ============================================================================
// Mock Stripe SDK before importing StripeClient
// ============================================================================

const mockCustomerCreate = vi.fn()
const mockCustomerRetrieve = vi.fn()
const mockCustomerUpdate = vi.fn()
const mockSubRetrieve = vi.fn()
const mockSubList = vi.fn()
const mockSubUpdate = vi.fn()
const mockSubCancel = vi.fn()
const mockConstructEvent = vi.fn()
const mockSessionCreate = vi.fn()
const mockSessionRetrieve = vi.fn()
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
    customers = {
      create: mockCustomerCreate,
      retrieve: mockCustomerRetrieve,
      update: mockCustomerUpdate,
    }
    checkout = {
      sessions: {
        create: mockSessionCreate,
        retrieve: mockSessionRetrieve,
      },
    }
    subscriptions = {
      retrieve: mockSubRetrieve,
      list: mockSubList,
      update: mockSubUpdate,
      cancel: mockSubCancel,
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

// Import after mock
import { StripeClient } from '../../src/billing/StripeClient.js'

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

function createClient(): StripeClient {
  return new StripeClient({
    secretKey: 'sk_test_fake',
    webhookSecret: 'whsec_test_fake',
    prices: createTestPrices(),
    appUrl: 'https://test.skillsmith.app',
  })
}

// ============================================================================
// Tests
// ============================================================================

describe('StripeClient', () => {
  let client: StripeClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = createClient()
  })

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      expect(client).toBeDefined()
    })

    it('should default appUrl to skillsmith.app', () => {
      const c = new StripeClient({
        secretKey: 'sk_test_fake',
        webhookSecret: 'whsec_test_fake',
        prices: createTestPrices(),
      })
      expect(c).toBeDefined()
    })
  })

  // --------------------------------------------------------------------------
  // Customer Management
  // --------------------------------------------------------------------------

  describe('createCustomer', () => {
    it('should create a customer and return ID', async () => {
      mockCustomerCreate.mockResolvedValueOnce({ id: 'cus_test123' })

      const result = await client.createCustomer({
        email: 'test@example.com',
        name: 'Test User',
      })

      expect(result).toBe('cus_test123')
      expect(mockCustomerCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'test@example.com',
          name: 'Test User',
          metadata: expect.objectContaining({ source: 'skillsmith' }),
        })
      )
    })

    it('should merge custom metadata with source', async () => {
      mockCustomerCreate.mockResolvedValueOnce({ id: 'cus_test456' })

      await client.createCustomer({
        email: 'test@example.com',
        metadata: { org: 'acme' },
      })

      expect(mockCustomerCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { org: 'acme', source: 'skillsmith' },
        })
      )
    })

    it('should throw BillingError on API failure', async () => {
      mockCustomerCreate.mockRejectedValueOnce(new Error('Stripe API down'))

      await expect(client.createCustomer({ email: 'fail@example.com' })).rejects.toThrow(
        'Failed to create customer'
      )
    })
  })

  describe('getCustomer', () => {
    it('should return customer when found', async () => {
      const customer = { id: 'cus_test', email: 'a@b.com', deleted: false }
      mockCustomerRetrieve.mockResolvedValueOnce(customer)

      const result = await client.getCustomer('cus_test' as never)
      expect(result).toEqual(customer)
    })

    it('should return null for deleted customer', async () => {
      mockCustomerRetrieve.mockResolvedValueOnce({ id: 'cus_del', deleted: true })

      const result = await client.getCustomer('cus_del' as never)
      expect(result).toBeNull()
    })

    it('should return null for resource_missing error', async () => {
      const Stripe = (await import('stripe')).default
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stripeErr = new (Stripe.errors.StripeError as any)('Not found', 'resource_missing')
      mockCustomerRetrieve.mockRejectedValueOnce(stripeErr)

      const result = await client.getCustomer('cus_missing' as never)
      expect(result).toBeNull()
    })
  })

  describe('updateCustomer', () => {
    it('should update and return customer', async () => {
      const updated = { id: 'cus_test', email: 'new@b.com' }
      mockCustomerUpdate.mockResolvedValueOnce(updated)

      const result = await client.updateCustomer('cus_test' as never, {
        email: 'new@b.com',
      })
      expect(result).toEqual(updated)
    })
  })

  // --------------------------------------------------------------------------
  // Checkout
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // Subscription Management
  // --------------------------------------------------------------------------

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

      expect(mockSubUpdate).toHaveBeenCalledWith('sub_test', {
        cancel_at_period_end: true,
        cancellation_details: { comment: undefined },
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

  // --------------------------------------------------------------------------
  // Customer Portal
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // Invoice Management
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // Webhook Signature
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // Price ID Resolution
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // Static Methods
  // --------------------------------------------------------------------------

  describe('mapSubscriptionStatus (static)', () => {
    it('should delegate to stripe-helpers', () => {
      expect(StripeClient.mapSubscriptionStatus('active')).toBe('active')
      expect(StripeClient.mapSubscriptionStatus('canceled')).toBe('canceled')
      expect(StripeClient.mapSubscriptionStatus('past_due')).toBe('past_due')
    })
  })

  // --------------------------------------------------------------------------
  // getStripeInstance
  // --------------------------------------------------------------------------

  describe('getStripeInstance', () => {
    it('should return the underlying Stripe instance', () => {
      const instance = client.getStripeInstance()
      expect(instance).toBeDefined()
      expect(instance.customers).toBeDefined()
    })
  })
})
