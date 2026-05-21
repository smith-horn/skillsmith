/**
 * SMI-3415 / SMI-5036: Webhook handlers — invoice + checkout-session events
 *
 * handleInvoicePaymentSucceeded / handleInvoicePaymentFailed /
 * handleCheckoutSessionCompleted.
 */

import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import {
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  handleCheckoutSessionCompleted,
} from '../../src/billing/webhook-handlers.js'
import { createContext, makeInvoice } from './_helpers.js'

// ============================================================================
// handleInvoicePaymentSucceeded
// ============================================================================

describe('handleInvoicePaymentSucceeded', () => {
  it('should store paid invoice', async () => {
    const ctx = createContext()
    const invoice = makeInvoice()

    await handleInvoicePaymentSucceeded(ctx, invoice)

    expect(ctx.billing.storeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_test_1',
        stripeInvoiceId: 'in_test_1',
        status: 'paid',
        amountCents: 2500,
        currency: 'usd',
        subscriptionId: 'sub_test_1',
      })
    )
  })

  it('should handle customer as object', async () => {
    const ctx = createContext()
    const invoice = makeInvoice({ customer: { id: 'cus_obj_1' } })

    await handleInvoicePaymentSucceeded(ctx, invoice)

    expect(ctx.billing.storeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_obj_1' })
    )
  })

  it('should skip when no customer ID', async () => {
    const ctx = createContext()
    const invoice = makeInvoice({ customer: null })

    await handleInvoicePaymentSucceeded(ctx, invoice)

    expect(ctx.billing.storeInvoice).not.toHaveBeenCalled()
  })

  it('should handle missing status_transitions.paid_at', async () => {
    const ctx = createContext()
    const invoice = makeInvoice({ status_transitions: {} })

    await handleInvoicePaymentSucceeded(ctx, invoice)

    expect(ctx.billing.storeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        paidAt: expect.any(Date),
      })
    )
  })
})

// ============================================================================
// handleInvoicePaymentFailed
// ============================================================================

describe('handleInvoicePaymentFailed', () => {
  it('should store open invoice', async () => {
    const ctx = createContext()
    const invoice = makeInvoice()

    await handleInvoicePaymentFailed(ctx, invoice)

    expect(ctx.billing.storeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_test_1',
        stripeInvoiceId: 'in_test_1',
        status: 'open',
        amountCents: 2500,
      })
    )
  })

  it('should send payment failed email', async () => {
    const onEmailNeeded = vi.fn().mockResolvedValue(undefined)
    const ctx = createContext({ onEmailNeeded })
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
    } as never)

    await handleInvoicePaymentFailed(ctx, makeInvoice())

    expect(onEmailNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'payment_failed',
        email: 'user@example.com',
        data: expect.objectContaining({
          invoiceId: 'in_test_1',
          amount: 2500,
        }),
      })
    )
  })

  it('should skip when no customer ID', async () => {
    const ctx = createContext()
    const invoice = makeInvoice({ customer: null })

    await handleInvoicePaymentFailed(ctx, invoice)

    expect(ctx.billing.storeInvoice).not.toHaveBeenCalled()
  })

  it('should skip email when customer has no email', async () => {
    const onEmailNeeded = vi.fn()
    const ctx = createContext({ onEmailNeeded })
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: null,
    } as never)

    await handleInvoicePaymentFailed(ctx, makeInvoice())

    expect(onEmailNeeded).not.toHaveBeenCalled()
  })
})

// ============================================================================
// handleCheckoutSessionCompleted
// ============================================================================

describe('handleCheckoutSessionCompleted', () => {
  it('should not throw (logging-only handler)', () => {
    const session = {
      id: 'cs_test_1',
      customer: 'cus_test_1',
      subscription: 'sub_test_1',
    } as unknown as Stripe.Checkout.Session

    expect(() => handleCheckoutSessionCompleted(session)).not.toThrow()
  })
})
