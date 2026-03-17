/**
 * SMI-3415: Webhook Handler Functions Tests
 *
 * Tests for individual webhook event handler functions:
 * - handleSubscriptionCreated (with/without license key, email)
 * - handleSubscriptionUpdated (existing sub, tier change, new sub fallback)
 * - handleSubscriptionDeleted (with email, without existing sub)
 * - handleInvoicePaymentSucceeded (store invoice, missing customer)
 * - handleInvoicePaymentFailed (store + email, missing customer)
 * - handleCheckoutSessionCompleted (logging-only)
 * - storeLicenseKey / revokeLicenseKey (DB operations)
 * - extractTier / extractSeatCount / getCurrentPeriodEnd / getCurrentPeriodStart
 * - extractSubscriptionIdFromInvoice
 */

import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  handleCheckoutSessionCompleted,
  storeLicenseKey,
  revokeLicenseKey,
  extractTier,
  extractSeatCount,
  getCurrentPeriodEnd,
  getCurrentPeriodStart,
  extractSubscriptionIdFromInvoice,
  type WebhookHandlerContext,
} from '../../src/billing/webhook-handlers.js'
import type { Database } from '../../src/db/database-interface.js'
import type { StripeClient } from '../../src/billing/StripeClient.js'
import type { BillingService } from '../../src/billing/BillingService.js'

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockDb(): Database {
  const runFn = vi.fn()
  return {
    prepare: vi.fn().mockReturnValue({ run: runFn, get: vi.fn(), all: vi.fn() }),
    exec: vi.fn(),
    close: vi.fn(),
  } as unknown as Database
}

function createMockStripeClient(): StripeClient {
  return {
    getCustomer: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    mapSubscriptionStatus: vi.fn(),
  } as unknown as StripeClient
}

function createMockBillingService(): BillingService {
  return {
    upsertSubscription: vi.fn().mockReturnValue({ id: 'local_sub_1', tier: 'individual' }),
    getSubscriptionByStripeId: vi.fn().mockReturnValue(null),
    updateSubscriptionStatus: vi.fn(),
    storeInvoice: vi.fn(),
    isEventProcessed: vi.fn().mockReturnValue(false),
    recordWebhookEvent: vi.fn(),
  } as unknown as BillingService
}

function createContext(overrides: Partial<WebhookHandlerContext> = {}): WebhookHandlerContext {
  return {
    stripe: createMockStripeClient(),
    billing: createMockBillingService(),
    db: createMockDb(),
    ...overrides,
  }
}

function makeSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_test_1',
    customer: 'cus_test_1',
    status: 'active',
    metadata: { tier: 'team', seatCount: '5' },
    items: {
      data: [
        {
          id: 'si_1',
          price: { id: 'price_team_monthly' },
          quantity: 5,
          current_period_start: 1700000000,
          current_period_end: 1702592000,
        },
      ],
    },
    canceled_at: null,
    ...overrides,
  } as unknown as Stripe.Subscription
}

function makeInvoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: 'in_test_1',
    customer: 'cus_test_1',
    amount_paid: 2500,
    amount_due: 2500,
    currency: 'usd',
    number: 'INV-001',
    invoice_pdf: 'https://pdf.url',
    hosted_invoice_url: 'https://hosted.url',
    status_transitions: { paid_at: 1700000000 },
    period_start: 1700000000,
    period_end: 1702592000,
    parent: {
      subscription_details: {
        subscription: 'sub_test_1',
      },
    },
    ...overrides,
  } as unknown as Stripe.Invoice
}

// ============================================================================
// Pure Helper Functions
// ============================================================================

describe('extractTier', () => {
  it('should extract tier from metadata', () => {
    const sub = makeSubscription({ metadata: { tier: 'enterprise' } })
    expect(extractTier(sub)).toBe('enterprise')
  })

  it('should accept all valid tiers from metadata', () => {
    for (const tier of ['community', 'individual', 'team', 'enterprise']) {
      const sub = makeSubscription({ metadata: { tier } })
      expect(extractTier(sub)).toBe(tier)
    }
  })

  it('should default to individual for missing metadata', () => {
    const sub = makeSubscription({ metadata: {} })
    expect(extractTier(sub)).toBe('individual')
  })

  it('should default to individual for invalid tier in metadata', () => {
    const sub = makeSubscription({ metadata: { tier: 'platinum' } })
    expect(extractTier(sub)).toBe('individual')
  })
})

describe('extractSeatCount', () => {
  it('should extract seat count from metadata', () => {
    const sub = makeSubscription({ metadata: { seatCount: '10' } })
    expect(extractSeatCount(sub)).toBe(10)
  })

  it('should fall back to item quantity when metadata missing', () => {
    const sub = makeSubscription({ metadata: {} })
    expect(extractSeatCount(sub)).toBe(5) // from fixture item quantity
  })

  it('should fall back to item quantity for non-numeric metadata', () => {
    const sub = makeSubscription({ metadata: { seatCount: 'abc' } })
    expect(extractSeatCount(sub)).toBe(5)
  })

  it('should fall back to item quantity for zero seat count', () => {
    const sub = makeSubscription({ metadata: { seatCount: '0' } })
    expect(extractSeatCount(sub)).toBe(5)
  })

  it('should fall back to item quantity for negative seat count', () => {
    const sub = makeSubscription({ metadata: { seatCount: '-1' } })
    expect(extractSeatCount(sub)).toBe(5)
  })

  it('should return 1 when no items and no metadata', () => {
    const sub = makeSubscription({
      metadata: {},
      items: { data: [{ quantity: undefined, current_period_end: 1702592000 }] },
    })
    expect(extractSeatCount(sub)).toBe(1)
  })
})

describe('getCurrentPeriodEnd', () => {
  it('should return period end from first item', () => {
    const sub = makeSubscription()
    expect(getCurrentPeriodEnd(sub)).toBe(1702592000)
  })

  it('should return current timestamp when no items', () => {
    const sub = makeSubscription({ items: { data: [] } })
    const now = Math.floor(Date.now() / 1000)
    const result = getCurrentPeriodEnd(sub)
    // Should be within 2 seconds of now
    expect(Math.abs(result - now)).toBeLessThan(2)
  })
})

describe('getCurrentPeriodStart', () => {
  it('should return period start from first item', () => {
    const sub = makeSubscription()
    expect(getCurrentPeriodStart(sub)).toBe(1700000000)
  })

  it('should return current timestamp when no items', () => {
    const sub = makeSubscription({ items: { data: [] } })
    const now = Math.floor(Date.now() / 1000)
    const result = getCurrentPeriodStart(sub)
    expect(Math.abs(result - now)).toBeLessThan(2)
  })
})

describe('extractSubscriptionIdFromInvoice', () => {
  it('should extract string subscription ID', () => {
    const invoice = makeInvoice()
    expect(extractSubscriptionIdFromInvoice(invoice)).toBe('sub_test_1')
  })

  it('should extract ID from subscription object', () => {
    const invoice = makeInvoice({
      parent: {
        subscription_details: {
          subscription: { id: 'sub_obj_1' },
        },
      },
    })
    expect(extractSubscriptionIdFromInvoice(invoice)).toBe('sub_obj_1')
  })

  it('should return undefined when no parent', () => {
    const invoice = makeInvoice({ parent: undefined })
    expect(extractSubscriptionIdFromInvoice(invoice)).toBeUndefined()
  })

  it('should return undefined when no subscription_details', () => {
    const invoice = makeInvoice({ parent: {} })
    expect(extractSubscriptionIdFromInvoice(invoice)).toBeUndefined()
  })

  it('should return undefined when subscription is null', () => {
    const invoice = makeInvoice({
      parent: { subscription_details: { subscription: null } },
    })
    expect(extractSubscriptionIdFromInvoice(invoice)).toBeUndefined()
  })
})

// ============================================================================
// License Key DB Operations
// ============================================================================

describe('storeLicenseKey', () => {
  it('should insert a license key record', () => {
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    storeLicenseKey(db, {
      subscriptionId: 'sub_1',
      organizationId: 'org_1',
      keyJwt: 'jwt_token_value',
      keyExpiry: new Date('2026-12-31'),
    })

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO license_keys'))
    expect(runFn).toHaveBeenCalledWith(
      expect.any(String), // UUID
      'sub_1',
      'org_1',
      'jwt_token_value',
      expect.any(String), // SHA-256 hash
      '2026-12-31T00:00:00.000Z',
      expect.any(String) // generated_at ISO
    )
  })
})

describe('revokeLicenseKey', () => {
  it('should update license key to inactive', () => {
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    revokeLicenseKey(db, 'sub_1', 'tier_change')

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE license_keys'))
    expect(runFn).toHaveBeenCalledWith(expect.any(String), 'tier_change', 'sub_1')
  })
})

// ============================================================================
// handleSubscriptionCreated
// ============================================================================

describe('handleSubscriptionCreated', () => {
  it('should create subscription record when customer found', async () => {
    const ctx = createContext()
    const sub = makeSubscription()
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionCreated(ctx, sub)

    expect(ctx.billing.upsertSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_test_1',
        email: 'user@example.com',
        stripeSubscriptionId: 'sub_test_1',
        tier: 'team',
        seatCount: 5,
      })
    )
  })

  it('should throw when customer not found', async () => {
    const ctx = createContext()
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue(null)

    await expect(handleSubscriptionCreated(ctx, makeSubscription())).rejects.toThrow(
      'Customer not found'
    )
  })

  it('should generate and store license key for active subscription', async () => {
    const onLicenseKeyNeeded = vi.fn().mockResolvedValue('jwt_license_123')
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    const ctx = createContext({ onLicenseKeyNeeded, db })
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionCreated(ctx, makeSubscription({ status: 'active' }))

    expect(onLicenseKeyNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_test_1',
        tier: 'team',
      })
    )
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO license_keys'))
  })

  it('should send license key email when onEmailNeeded provided', async () => {
    const onLicenseKeyNeeded = vi.fn().mockResolvedValue('jwt_license_456')
    const onEmailNeeded = vi.fn().mockResolvedValue(undefined)
    const db = createMockDb()
    vi.mocked(db.prepare).mockReturnValue({ run: vi.fn() } as never)

    const ctx = createContext({ onLicenseKeyNeeded, onEmailNeeded, db })
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionCreated(ctx, makeSubscription({ status: 'active' }))

    expect(onEmailNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'license_key',
        email: 'user@example.com',
        data: expect.objectContaining({ licenseKey: 'jwt_license_456', tier: 'team' }),
      })
    )
  })

  it('should skip license key for non-active subscription', async () => {
    const onLicenseKeyNeeded = vi.fn()
    const ctx = createContext({ onLicenseKeyNeeded })
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionCreated(ctx, makeSubscription({ status: 'trialing' }))

    expect(onLicenseKeyNeeded).not.toHaveBeenCalled()
  })
})

// ============================================================================
// handleSubscriptionUpdated
// ============================================================================

describe('handleSubscriptionUpdated', () => {
  it('should create subscription if not found locally', async () => {
    const ctx = createContext()
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue(null)
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionUpdated(ctx, makeSubscription())

    expect(ctx.billing.upsertSubscription).toHaveBeenCalled()
  })

  it('should update status for existing subscription', async () => {
    const ctx = createContext()
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team',
    } as never)

    const sub = makeSubscription({ status: 'past_due', canceled_at: null })
    await handleSubscriptionUpdated(ctx, sub)

    expect(ctx.billing.updateSubscriptionStatus).toHaveBeenCalledWith(
      'sub_test_1',
      'past_due',
      null
    )
  })

  it('should pass canceled_at date when present', async () => {
    const ctx = createContext()
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team',
    } as never)

    const sub = makeSubscription({ status: 'canceled', canceled_at: 1700000000 })
    await handleSubscriptionUpdated(ctx, sub)

    expect(ctx.billing.updateSubscriptionStatus).toHaveBeenCalledWith(
      'sub_test_1',
      'canceled',
      new Date(1700000000 * 1000)
    )
  })

  it('should regenerate license key on tier change', async () => {
    const onLicenseKeyNeeded = vi.fn().mockResolvedValue('new_jwt')
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    const ctx = createContext({ onLicenseKeyNeeded, db })
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'individual', // old tier
    } as never)
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
    } as never)

    // New tier is 'team' from metadata
    await handleSubscriptionUpdated(ctx, makeSubscription({ metadata: { tier: 'team' } }))

    // Should revoke old key
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE license_keys'))
    // Should generate new key
    expect(onLicenseKeyNeeded).toHaveBeenCalledWith(expect.objectContaining({ tier: 'team' }))
    // Should store new key
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO license_keys'))
  })

  it('should not regenerate license key when tier unchanged', async () => {
    const onLicenseKeyNeeded = vi.fn()
    const ctx = createContext({ onLicenseKeyNeeded })
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team', // same as metadata
    } as never)

    await handleSubscriptionUpdated(ctx, makeSubscription({ metadata: { tier: 'team' } }))

    expect(onLicenseKeyNeeded).not.toHaveBeenCalled()
  })
})

// ============================================================================
// handleSubscriptionDeleted
// ============================================================================

describe('handleSubscriptionDeleted', () => {
  it('should cancel subscription and revoke license key', async () => {
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    const ctx = createContext({ db })
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team',
    } as never)

    await handleSubscriptionDeleted(ctx, makeSubscription())

    expect(ctx.billing.updateSubscriptionStatus).toHaveBeenCalledWith(
      'sub_test_1',
      'canceled',
      expect.any(Date)
    )
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE license_keys'))
  })

  it('should send cancellation email', async () => {
    const onEmailNeeded = vi.fn().mockResolvedValue(undefined)
    const db = createMockDb()
    vi.mocked(db.prepare).mockReturnValue({ run: vi.fn() } as never)

    const ctx = createContext({ onEmailNeeded, db })
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team',
    } as never)
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
    } as never)

    await handleSubscriptionDeleted(ctx, makeSubscription())

    expect(onEmailNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subscription_canceled',
        email: 'user@example.com',
      })
    )
  })

  it('should do nothing when subscription not found locally', async () => {
    const ctx = createContext()
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue(null)

    await handleSubscriptionDeleted(ctx, makeSubscription())

    expect(ctx.billing.updateSubscriptionStatus).not.toHaveBeenCalled()
  })
})

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
