/**
 * SMI-3415 / SMI-5036: StripeClient — customer management
 *
 * Constructor + createCustomer / getCustomer / updateCustomer.
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
    checkout = { sessions: { create: vi.fn(), retrieve: vi.fn() } }
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

describe('StripeClient — customers', () => {
  let client: StripeClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = createClient()
  })

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
})
