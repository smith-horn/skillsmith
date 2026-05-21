/**
 * SMI-5036: Shared test helpers for billing test splits.
 *
 * This file is intentionally NOT named `*.test.ts` so Vitest does not pick it
 * up as a test file (per CLAUDE.md § Test File Locations / SMI-1780). It is
 * imported by the webhook-handlers.* split files to keep mock factories DRY
 * and avoid mock-shape drift across them.
 */

import { vi } from 'vitest'
import type Stripe from 'stripe'
import type { Database } from '@skillsmith/core'
import type { StripeClient } from '../../src/billing/StripeClient.js'
import type { BillingService } from '../../src/billing/BillingService.js'
import type { WebhookHandlerContext } from '../../src/billing/webhook-handlers.js'

/**
 * Mock `Database` with chainable prepare/run/get/all stubs.
 */
export function createMockDb(): Database {
  const runFn = vi.fn()
  return {
    prepare: vi.fn().mockReturnValue({ run: runFn, get: vi.fn(), all: vi.fn() }),
    exec: vi.fn(),
    close: vi.fn(),
  } as unknown as Database
}

/**
 * Mock `StripeClient` exposing only the methods exercised by webhook handlers.
 */
export function createMockStripeClient(): StripeClient {
  return {
    getCustomer: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    mapSubscriptionStatus: vi.fn(),
  } as unknown as StripeClient
}

/**
 * Mock `BillingService` with default return values for happy-path tests.
 */
export function createMockBillingService(): BillingService {
  return {
    upsertSubscription: vi.fn().mockReturnValue({ id: 'local_sub_1', tier: 'individual' }),
    getSubscriptionByStripeId: vi.fn().mockReturnValue(null),
    updateSubscriptionStatus: vi.fn(),
    storeInvoice: vi.fn(),
    isEventProcessed: vi.fn().mockReturnValue(false),
    recordWebhookEvent: vi.fn(),
  } as unknown as BillingService
}

/**
 * Build a `WebhookHandlerContext` with overridable mocked dependencies.
 */
export function createContext(
  overrides: Partial<WebhookHandlerContext> = {}
): WebhookHandlerContext {
  return {
    stripe: createMockStripeClient(),
    billing: createMockBillingService(),
    db: createMockDb(),
    ...overrides,
  }
}

/**
 * Build a `Stripe.Subscription` fixture (team tier, 5 seats, active).
 */
export function makeSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
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

/**
 * Build a `Stripe.Invoice` fixture (paid, $25.00 USD).
 */
export function makeInvoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
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
