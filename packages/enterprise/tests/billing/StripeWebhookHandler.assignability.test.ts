/**
 * SMI-5119: StripeWebhookHandler assignability test
 *
 * Belt-and-suspenders alongside the `implements StripeWebhookHandlerContract`
 * declaration on the canonical class. If the contract in
 * `./webhook-contract.ts` drifts from the runtime class — for example, if
 * someone adds a new method to the contract or changes the `handleWebhook`
 * signature — both this test and the source-level `implements` clause will fail.
 *
 * Tests the REAL wire, not a mock: constructs a real `StripeWebhookHandler`
 * with shaped-but-mock collaborators, then asserts (via a `satisfies`-style
 * runtime cast plus an actual invocation) that the instance is structurally
 * assignable to the public contract.
 */

import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import type {
  StripeWebhookHandlerContract,
  StripeWebhookResult,
} from '../../src/billing/webhook-contract.js'
import { StripeWebhookHandler } from '../../src/billing/StripeWebhookHandler.js'
import type { StripeClient } from '../../src/billing/StripeClient.js'
import type { BillingService } from '../../src/billing/BillingService.js'
import type { Database } from '@skillsmith/core'

describe('StripeWebhookHandler ↔ StripeWebhookHandlerContract', () => {
  it('is structurally assignable to StripeWebhookHandlerContract', async () => {
    const mockStripe = {
      verifyWebhookSignature: vi.fn(
        () => ({ id: 'evt_assignability', type: 'unknown.event' }) as unknown as Stripe.Event
      ),
    } as unknown as StripeClient
    const mockBilling = {
      isEventProcessed: vi.fn().mockReturnValue(false),
      recordWebhookEvent: vi.fn(),
    } as unknown as BillingService
    const mockDb = {} as Database

    const real = new StripeWebhookHandler({
      stripeClient: mockStripe,
      billingService: mockBilling,
      db: mockDb,
    })

    // Compile-time assignability: assigning to a typed binding without `as`
    // would reject any structural drift.
    const contract: StripeWebhookHandlerContract = real
    expect(typeof contract.handleWebhook).toBe('function')

    // Runtime assignability: invoke through the contract type and verify the
    // shape of the result against StripeWebhookResult.
    const result: StripeWebhookResult = await contract.handleWebhook('payload', 'sig')
    expect(result).toMatchObject({
      success: expect.any(Boolean),
      message: expect.any(String),
      eventId: expect.any(String),
      processed: expect.any(Boolean),
    })
  })
})
