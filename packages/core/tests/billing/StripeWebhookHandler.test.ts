/**
 * SMI-3415: StripeWebhookHandler Tests
 *
 * Tests for the webhook handler dispatch/routing layer:
 * - Signature verification (success + failure)
 * - Idempotent duplicate detection
 * - Event routing to correct handlers
 * - Success/failure recording
 * - Error handling and result shape
 *
 * Boundary: This tests StripeWebhookHandler (dispatch/routing).
 * BillingService.test.ts tests the service layer.
 * webhook-handlers.test.ts tests individual event handler logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'
import { StripeWebhookHandler } from '../../src/billing/StripeWebhookHandler.js'
import type { StripeClient } from '../../src/billing/StripeClient.js'
import type { BillingService } from '../../src/billing/BillingService.js'
import type { Database } from '../../src/db/database-interface.js'
import { BillingError } from '../../src/billing/types.js'

// ============================================================================
// Mock individual webhook handlers to isolate routing logic
// ============================================================================

vi.mock('../../src/billing/webhook-handlers.js', () => ({
  handleSubscriptionCreated: vi.fn().mockResolvedValue(undefined),
  handleSubscriptionUpdated: vi.fn().mockResolvedValue(undefined),
  handleSubscriptionDeleted: vi.fn().mockResolvedValue(undefined),
  handleInvoicePaymentSucceeded: vi.fn().mockResolvedValue(undefined),
  handleInvoicePaymentFailed: vi.fn().mockResolvedValue(undefined),
  handleCheckoutSessionCompleted: vi.fn(),
}))

import {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  handleCheckoutSessionCompleted,
} from '../../src/billing/webhook-handlers.js'

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockStripeClient(): StripeClient {
  return {
    verifyWebhookSignature: vi.fn(),
    getCustomer: vi.fn(),
  } as unknown as StripeClient
}

function createMockBillingService(): BillingService {
  return {
    isEventProcessed: vi.fn().mockReturnValue(false),
    recordWebhookEvent: vi.fn(),
    upsertSubscription: vi.fn(),
    getSubscriptionByStripeId: vi.fn(),
    updateSubscriptionStatus: vi.fn(),
    storeInvoice: vi.fn(),
  } as unknown as BillingService
}

function createMockDb(): Database {
  return {
    prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
  } as unknown as Database
}

function makeStripeEvent(type: string, data: Record<string, unknown> = {}): Stripe.Event {
  return {
    id: 'evt_test_123',
    type,
    data: { object: data },
  } as unknown as Stripe.Event
}

// ============================================================================
// Tests
// ============================================================================

describe('StripeWebhookHandler', () => {
  let handler: StripeWebhookHandler
  let mockStripe: ReturnType<typeof createMockStripeClient>
  let mockBilling: ReturnType<typeof createMockBillingService>
  let mockDb: ReturnType<typeof createMockDb>

  beforeEach(() => {
    vi.clearAllMocks()
    mockStripe = createMockStripeClient()
    mockBilling = createMockBillingService()
    mockDb = createMockDb()

    handler = new StripeWebhookHandler({
      stripeClient: mockStripe,
      billingService: mockBilling,
      db: mockDb,
    })
  })

  // --------------------------------------------------------------------------
  // Signature Verification
  // --------------------------------------------------------------------------

  describe('signature verification', () => {
    it('should return failure result when signature is invalid', async () => {
      vi.mocked(mockStripe.verifyWebhookSignature).mockImplementation(() => {
        throw new BillingError('Invalid webhook signature', 'WEBHOOK_SIGNATURE_INVALID')
      })

      const result = await handler.handleWebhook('payload', 'bad_sig')

      expect(result.success).toBe(false)
      expect(result.message).toBe('Signature verification failed')
      expect(result.processed).toBe(false)
      expect(result.eventId).toBe('')
    })

    it('should proceed when signature is valid', async () => {
      const event = makeStripeEvent('checkout.session.completed', { id: 'cs_1' })
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      const result = await handler.handleWebhook('payload', 'valid_sig')

      expect(result.success).toBe(true)
      expect(result.processed).toBe(true)
    })
  })

  // --------------------------------------------------------------------------
  // Idempotency / Duplicate Detection
  // --------------------------------------------------------------------------

  describe('idempotency', () => {
    it('should skip already-processed events', async () => {
      const event = makeStripeEvent('customer.subscription.created', { id: 'sub_1' })
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)
      vi.mocked(mockBilling.isEventProcessed).mockReturnValue(true)

      const result = await handler.handleWebhook('payload', 'sig')

      expect(result.success).toBe(true)
      expect(result.processed).toBe(false)
      expect(result.message).toBe('Event already processed')
      expect(handleSubscriptionCreated).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // Event Routing
  // --------------------------------------------------------------------------

  describe('event routing', () => {
    it('should route customer.subscription.created', async () => {
      const sub = { id: 'sub_1', customer: 'cus_1', status: 'active' }
      const event = makeStripeEvent('customer.subscription.created', sub)
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      const result = await handler.handleWebhook('payload', 'sig')

      expect(result.success).toBe(true)
      expect(result.processed).toBe(true)
      expect(handleSubscriptionCreated).toHaveBeenCalledWith(
        expect.objectContaining({ stripe: mockStripe, billing: mockBilling }),
        sub
      )
    })

    it('should route customer.subscription.updated', async () => {
      const sub = { id: 'sub_1', status: 'past_due' }
      const event = makeStripeEvent('customer.subscription.updated', sub)
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      await handler.handleWebhook('payload', 'sig')

      expect(handleSubscriptionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ stripe: mockStripe }),
        sub
      )
    })

    it('should route customer.subscription.deleted', async () => {
      const sub = { id: 'sub_1' }
      const event = makeStripeEvent('customer.subscription.deleted', sub)
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      await handler.handleWebhook('payload', 'sig')

      expect(handleSubscriptionDeleted).toHaveBeenCalledWith(
        expect.objectContaining({ stripe: mockStripe }),
        sub
      )
    })

    it('should route invoice.payment_succeeded', async () => {
      const invoice = { id: 'in_1', customer: 'cus_1', amount_paid: 999 }
      const event = makeStripeEvent('invoice.payment_succeeded', invoice)
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      await handler.handleWebhook('payload', 'sig')

      expect(handleInvoicePaymentSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ billing: mockBilling }),
        invoice
      )
    })

    it('should route invoice.payment_failed', async () => {
      const invoice = { id: 'in_2', customer: 'cus_1', amount_due: 999 }
      const event = makeStripeEvent('invoice.payment_failed', invoice)
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      await handler.handleWebhook('payload', 'sig')

      expect(handleInvoicePaymentFailed).toHaveBeenCalledWith(
        expect.objectContaining({ billing: mockBilling }),
        invoice
      )
    })

    it('should route checkout.session.completed', async () => {
      const session = { id: 'cs_1', customer: 'cus_1' }
      const event = makeStripeEvent('checkout.session.completed', session)
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      await handler.handleWebhook('payload', 'sig')

      expect(handleCheckoutSessionCompleted).toHaveBeenCalledWith(session)
    })

    it('should handle unrecognized event types gracefully', async () => {
      const event = makeStripeEvent('unknown.event.type', {})
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      const result = await handler.handleWebhook('payload', 'sig')

      expect(result.success).toBe(true)
      expect(result.processed).toBe(true)
      expect(result.message).toBe('Processed unknown.event.type')
    })
  })

  // --------------------------------------------------------------------------
  // Event Recording
  // --------------------------------------------------------------------------

  describe('event recording', () => {
    it('should record successful event processing', async () => {
      const event = makeStripeEvent('checkout.session.completed', { id: 'cs_1' })
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      await handler.handleWebhook('the_payload', 'sig')

      expect(mockBilling.recordWebhookEvent).toHaveBeenCalledWith({
        stripeEventId: 'evt_test_123',
        eventType: 'checkout.session.completed',
        payload: 'the_payload',
        success: true,
      })
    })

    it('should record failed event processing', async () => {
      const event = makeStripeEvent('customer.subscription.created', { id: 'sub_1' })
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)
      vi.mocked(handleSubscriptionCreated).mockRejectedValueOnce(new Error('Handler boom'))

      const result = await handler.handleWebhook('the_payload', 'sig')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Handler boom')
      expect(mockBilling.recordWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeEventId: 'evt_test_123',
          success: false,
          errorMessage: 'Handler boom',
        })
      )
    })
  })

  // --------------------------------------------------------------------------
  // Result Shape
  // --------------------------------------------------------------------------

  describe('result shape', () => {
    it('should include eventId in success result', async () => {
      const event = makeStripeEvent('checkout.session.completed', {})
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      const result = await handler.handleWebhook('payload', 'sig')

      expect(result.eventId).toBe('evt_test_123')
      expect(result.success).toBe(true)
      expect(result.processed).toBe(true)
    })
  })

  // --------------------------------------------------------------------------
  // Callbacks
  // --------------------------------------------------------------------------

  describe('callbacks', () => {
    it('should pass onLicenseKeyNeeded to handler context', async () => {
      const onLicense = vi.fn()
      const onEmail = vi.fn()

      const handlerWithCallbacks = new StripeWebhookHandler({
        stripeClient: mockStripe,
        billingService: mockBilling,
        db: mockDb,
        onLicenseKeyNeeded: onLicense,
        onEmailNeeded: onEmail,
      })

      const event = makeStripeEvent('customer.subscription.created', { id: 'sub_1' })
      vi.mocked(mockStripe.verifyWebhookSignature).mockReturnValue(event)

      await handlerWithCallbacks.handleWebhook('payload', 'sig')

      expect(handleSubscriptionCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          onLicenseKeyNeeded: onLicense,
          onEmailNeeded: onEmail,
        }),
        expect.anything()
      )
    })
  })
})
