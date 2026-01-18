/**
 * SMI-1069: Stripe Reconciliation Job Tests
 *
 * Tests for data reconciliation between local database and Stripe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type Stripe from 'stripe'
import { StripeReconciliationJob } from '../../src/billing/StripeReconciliationJob.js'
import type { StripeClient } from '../../src/billing/StripeClient.js'
import { initializeAnalyticsSchema } from '../../src/analytics/schema.js'
import { randomUUID } from 'crypto'

// Mock StripeClient
function createMockStripeClient(): StripeClient {
  return {
    getSubscription: vi.fn().mockResolvedValue({
      id: 'sub_test123',
      status: 'active',
      metadata: { tier: 'team' },
      items: {
        data: [{ quantity: 5 }],
      },
      current_period_start: 1704067200,
      current_period_end: 1706745600,
    }),
    getInvoice: vi.fn().mockResolvedValue({
      id: 'in_test123',
      status: 'paid',
      amount_paid: 2500,
      amount_due: 2500,
    }),
    getStripeInstance: vi.fn(),
  } as unknown as StripeClient
}

describe('StripeReconciliationJob', () => {
  let db: Database.Database
  let mockStripeClient: StripeClient

  beforeEach(() => {
    // Create in-memory database
    db = new Database(':memory:')
    initializeAnalyticsSchema(db)
    mockStripeClient = createMockStripeClient()
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  // Helper to create test subscription
  function createTestSubscription(
    customerId: string,
    options: Partial<{
      stripeSubscriptionId: string
      status: string
      tier: string
      seatCount: number
    }> = {}
  ) {
    const id = randomUUID()
    const now = new Date().toISOString()

    db.prepare(
      `INSERT INTO user_subscriptions (
        id, customer_id, email, stripe_customer_id, stripe_subscription_id,
        stripe_price_id, tier, status, seat_count,
        current_period_start, current_period_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      customerId,
      'test@example.com',
      `cus_${customerId}`,
      options.stripeSubscriptionId ?? `sub_${customerId}`,
      'price_test',
      options.tier ?? 'team',
      options.status ?? 'active',
      options.seatCount ?? 5,
      now,
      now,
      now,
      now
    )

    return id
  }

  // Helper to create test invoice
  function createTestInvoice(
    customerId: string,
    options: Partial<{
      stripeInvoiceId: string
      status: string
      amountCents: number
    }> = {}
  ) {
    const id = randomUUID()
    const now = new Date().toISOString()

    db.prepare(
      `INSERT INTO invoices (
        id, customer_id, stripe_invoice_id, amount_cents, currency, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      customerId,
      options.stripeInvoiceId ?? `in_${customerId}`,
      options.amountCents ?? 2500,
      'usd',
      options.status ?? 'paid',
      now
    )

    return id
  }

  describe('Basic Operation', () => {
    it('should run reconciliation job successfully', async () => {
      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      expect(result.success).toBe(true)
      expect(result.startedAt).toBeDefined()
      expect(result.completedAt).toBeDefined()
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should report subscription counts', async () => {
      createTestSubscription('customer1')
      createTestSubscription('customer2')

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      expect(result.stats.subscriptionsChecked).toBe(2)
    })

    it('should report invoice counts', async () => {
      createTestInvoice('customer1')
      createTestInvoice('customer2')
      createTestInvoice('customer3')

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      expect(result.stats.invoicesChecked).toBe(3)
    })
  })

  describe('Subscription Discrepancy Detection', () => {
    it('should detect status mismatch', async () => {
      createTestSubscription('customer1', { status: 'past_due' })

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      expect(result.discrepancies).toHaveLength(1)
      expect(result.discrepancies[0].type).toBe('status_mismatch')
      expect(result.discrepancies[0].localValue).toBe('past_due')
      expect(result.discrepancies[0].stripeValue).toBe('active')
    })

    it('should detect tier mismatch', async () => {
      createTestSubscription('customer1', { tier: 'individual' })

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      const tierMismatch = result.discrepancies.find((d) => d.type === 'tier_mismatch')
      expect(tierMismatch).toBeDefined()
      expect(tierMismatch?.localValue).toBe('individual')
      expect(tierMismatch?.stripeValue).toBe('team')
    })

    it('should detect seat count mismatch', async () => {
      createTestSubscription('customer1', { seatCount: 10 })

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      const seatMismatch = result.discrepancies.find((d) => d.type === 'seat_count_mismatch')
      expect(seatMismatch).toBeDefined()
      expect(seatMismatch?.localValue).toBe(10)
      expect(seatMismatch?.stripeValue).toBe(5)
    })

    it('should detect missing Stripe subscription', async () => {
      createTestSubscription('customer1')

      // Mock Stripe returning null (subscription not found)
      vi.mocked(mockStripeClient.getSubscription).mockResolvedValue(null)

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      expect(result.discrepancies).toHaveLength(1)
      expect(result.discrepancies[0].type).toBe('missing_stripe')
    })
  })

  describe('Invoice Discrepancy Detection', () => {
    it('should detect invoice status mismatch', async () => {
      createTestInvoice('customer1', { status: 'open' })

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      const statusMismatch = result.discrepancies.find((d) => d.type === 'invoice_status_mismatch')
      expect(statusMismatch).toBeDefined()
      expect(statusMismatch?.localValue).toBe('open')
      expect(statusMismatch?.stripeValue).toBe('paid')
    })

    it('should detect invoice amount mismatch', async () => {
      createTestInvoice('customer1', { amountCents: 5000 })

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      const amountMismatch = result.discrepancies.find((d) => d.type === 'invoice_amount_mismatch')
      expect(amountMismatch).toBeDefined()
      expect(amountMismatch?.localValue).toBe(5000)
      expect(amountMismatch?.stripeValue).toBe(2500)
    })
  })

  describe('Auto-Fix', () => {
    it('should fix status mismatch when autoFix is enabled', async () => {
      const subscriptionId = createTestSubscription('customer1', { status: 'past_due' })

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
        autoFix: true,
      })

      const result = await job.run()

      expect(result.stats.discrepanciesFixed).toBe(1)
      expect(result.discrepancies[0].fixed).toBe(true)

      // Verify the fix was applied
      const updated = db
        .prepare(`SELECT status FROM user_subscriptions WHERE id = ?`)
        .get(subscriptionId) as { status: string }
      expect(updated.status).toBe('active')
    })

    it('should not fix discrepancies when autoFix is disabled', async () => {
      createTestSubscription('customer1', { status: 'past_due' })

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
        autoFix: false,
      })

      const result = await job.run()

      expect(result.stats.discrepanciesFixed).toBe(0)
      expect(result.discrepancies[0].fixed).toBe(false)
    })

    it('should fix invoice status mismatch', async () => {
      const invoiceId = createTestInvoice('customer1', { status: 'open' })

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
        autoFix: true,
      })

      await job.run()

      // Verify the fix was applied
      const updated = db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(invoiceId) as {
        status: string
      }
      expect(updated.status).toBe('paid')
    })
  })

  describe('Error Handling', () => {
    it('should handle Stripe API errors gracefully', async () => {
      createTestSubscription('customer1')

      vi.mocked(mockStripeClient.getSubscription).mockRejectedValue(new Error('Stripe API error'))

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('Stripe API error')
    })

    it('should continue processing after individual errors', async () => {
      createTestSubscription('customer1')
      createTestSubscription('customer2')

      // First call fails, second succeeds
      vi.mocked(mockStripeClient.getSubscription)
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce({
          id: 'sub_test123',
          status: 'active',
          metadata: { tier: 'team' },
          items: { data: [{ quantity: 5 }] },
        } as unknown as Stripe.Subscription)

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
      })

      const result = await job.run()

      expect(result.stats.subscriptionsChecked).toBe(2)
      expect(result.errors).toHaveLength(1)
    })
  })

  describe('Batch Size', () => {
    it('should respect batch size limit', async () => {
      // Create more subscriptions than batch size
      for (let i = 0; i < 10; i++) {
        createTestSubscription(`customer${i}`)
      }

      const job = new StripeReconciliationJob({
        stripeClient: mockStripeClient,
        db,
        batchSize: 3,
      })

      const result = await job.run()

      expect(result.stats.subscriptionsChecked).toBe(3)
    })
  })
})
