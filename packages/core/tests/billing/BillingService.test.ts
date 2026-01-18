/**
 * SMI-1063: Billing Service Tests
 *
 * Tests for BillingService database operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { BillingService } from '../../src/billing/BillingService.js'
import type { StripeClient } from '../../src/billing/StripeClient.js'
import type {
  StripeCustomerId,
  StripeSubscriptionId,
  StripeCheckoutSessionId,
  StripeEventId,
} from '../../src/billing/types.js'
import { initializeAnalyticsSchema } from '../../src/analytics/schema.js'

// Mock StripeClient
function createMockStripeClient(): StripeClient {
  return {
    createCheckoutSession: async () => ({
      sessionId: 'cs_test_123' as StripeCheckoutSessionId,
      url: 'https://checkout.stripe.com/test',
    }),
    createPortalSession: async () => ({
      url: 'https://billing.stripe.com/test',
    }),
    updateSubscription: async () => ({}) as unknown,
    cancelSubscription: async () => ({}) as unknown,
    getCustomer: async () => null,
  } as unknown as StripeClient
}

describe('BillingService', () => {
  let db: Database.Database
  let billingService: BillingService

  beforeEach(() => {
    // Create in-memory database
    db = new Database(':memory:')
    initializeAnalyticsSchema(db)

    billingService = new BillingService({
      stripeClient: createMockStripeClient(),
      db,
    })
  })

  afterEach(() => {
    db.close()
  })

  describe('Subscription Management', () => {
    const testSubscription = {
      customerId: 'test_customer_123',
      email: 'test@example.com',
      stripeCustomerId: 'cus_test123' as StripeCustomerId,
      stripeSubscriptionId: 'sub_test123' as StripeSubscriptionId,
      stripePriceId: 'price_test123',
      tier: 'team' as const,
      status: 'active' as const,
      seatCount: 5,
      currentPeriodStart: new Date('2026-01-01'),
      currentPeriodEnd: new Date('2026-02-01'),
    }

    it('should upsert a subscription', () => {
      const result = billingService.upsertSubscription(testSubscription)

      expect(result).toBeDefined()
      expect(result.customerId).toBe(testSubscription.customerId)
      expect(result.tier).toBe('team')
      expect(result.status).toBe('active')
      expect(result.seatCount).toBe(5)
    })

    it('should get subscription by customer ID', () => {
      billingService.upsertSubscription(testSubscription)

      const result = billingService.getSubscriptionByCustomerId(testSubscription.customerId)

      expect(result).toBeDefined()
      expect(result?.customerId).toBe(testSubscription.customerId)
    })

    it('should get subscription by Stripe subscription ID', () => {
      billingService.upsertSubscription(testSubscription)

      const result = billingService.getSubscriptionByStripeId(testSubscription.stripeSubscriptionId)

      expect(result).toBeDefined()
      expect(result?.stripeSubscriptionId).toBe(testSubscription.stripeSubscriptionId)
    })

    it('should return null for non-existent customer', () => {
      const result = billingService.getSubscriptionByCustomerId('non_existent')

      expect(result).toBeNull()
    })

    it('should update subscription on conflict', () => {
      // First insert
      billingService.upsertSubscription(testSubscription)

      // Update with same customer ID
      const updated = billingService.upsertSubscription({
        ...testSubscription,
        tier: 'enterprise',
        seatCount: 10,
      })

      expect(updated.tier).toBe('enterprise')
      expect(updated.seatCount).toBe(10)
    })

    it('should update subscription status', () => {
      billingService.upsertSubscription(testSubscription)

      billingService.updateSubscriptionStatus(
        testSubscription.stripeSubscriptionId,
        'past_due',
        null
      )

      const result = billingService.getSubscriptionByStripeId(testSubscription.stripeSubscriptionId)
      expect(result?.status).toBe('past_due')
    })
  })

  describe('Invoice Management', () => {
    it('should store an invoice', () => {
      const invoice = billingService.storeInvoice({
        customerId: 'cust_123',
        stripeInvoiceId: 'in_test123',
        amountCents: 2500,
        currency: 'usd',
        status: 'paid',
        pdfUrl: 'https://example.com/invoice.pdf',
        paidAt: new Date('2026-01-15'),
      })

      expect(invoice).toBeDefined()
      expect(invoice.amountCents).toBe(2500)
      expect(invoice.status).toBe('paid')
    })

    it('should get invoices for a customer', () => {
      // Store multiple invoices
      billingService.storeInvoice({
        customerId: 'cust_123',
        stripeInvoiceId: 'in_1',
        amountCents: 1000,
        currency: 'usd',
        status: 'paid',
      })
      billingService.storeInvoice({
        customerId: 'cust_123',
        stripeInvoiceId: 'in_2',
        amountCents: 2000,
        currency: 'usd',
        status: 'paid',
      })

      const invoices = billingService.getInvoices('cust_123')

      expect(invoices).toHaveLength(2)
    })

    it('should limit returned invoices', () => {
      // Store 5 invoices
      for (let i = 0; i < 5; i++) {
        billingService.storeInvoice({
          customerId: 'cust_123',
          stripeInvoiceId: `in_${i}`,
          amountCents: 1000,
          currency: 'usd',
          status: 'paid',
        })
      }

      const invoices = billingService.getInvoices('cust_123', 3)

      expect(invoices).toHaveLength(3)
    })
  })

  describe('Webhook Event Tracking', () => {
    it('should track if event is processed', () => {
      const eventId = 'evt_test123' as StripeEventId

      expect(billingService.isEventProcessed(eventId)).toBe(false)

      billingService.recordWebhookEvent({
        stripeEventId: eventId,
        eventType: 'customer.subscription.created',
        success: true,
      })

      expect(billingService.isEventProcessed(eventId)).toBe(true)
    })

    it('should record webhook event with error', () => {
      const event = billingService.recordWebhookEvent({
        stripeEventId: 'evt_failed' as StripeEventId,
        eventType: 'invoice.payment_failed',
        success: false,
        errorMessage: 'Payment method declined',
      })

      expect(event.success).toBe(false)
      expect(event.errorMessage).toBe('Payment method declined')
    })
  })
})
