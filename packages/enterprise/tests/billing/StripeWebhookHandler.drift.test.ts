/**
 * SMI-5125: Stripe webhook contract drift guard.
 *
 * The Stripe webhook contract is duplicated across the package boundary:
 *
 *   - Canonical (enterprise-owned):
 *     `packages/enterprise/src/billing/webhook-contract.ts`
 *     → `StripeWebhookHandlerContract` + `StripeWebhookResult`
 *   - Inline structural copy (consumed by the standalone HTTP endpoint):
 *     `packages/mcp-server/src/webhooks/stripe-webhook-endpoint.ts`
 *     → `StripeWebhookHandler` + `StripeWebhookResult`
 *
 * These can silently drift apart (a field added to one, a signature changed on
 * the other). This file fails if they diverge.
 *
 * WHERE THE TEETH ARE — TYPECHECK, NOT RUNTIME. vitest transpiles via esbuild,
 * which strips types WITHOUT checking them, so the `Exact<...>` assertions below
 * are erased and never evaluated by `vitest run`. The real enforcement is
 * `npm run typecheck` (tsc), which evaluates the bidirectional type-equality
 * assertions and errors if either interface gains/loses/changes a field. The
 * `it(...)` block exists only so vitest reports a real passing test.
 */

import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import type {
  StripeWebhookHandler as McpHandler,
  StripeWebhookResult as McpResult,
} from '@skillsmith/mcp-server'
import type {
  StripeWebhookHandlerContract,
  StripeWebhookResult as EntResult,
} from '../../src/billing/webhook-contract.js'
import { StripeWebhookHandler } from '../../src/billing/StripeWebhookHandler.js'
import type { StripeClient } from '../../src/billing/StripeClient.js'
import type { BillingService } from '../../src/billing/BillingService.js'
import type { Database } from '@skillsmith/core'

/**
 * Strict type equality. Resolves to `true` only when `A` and `B` are exactly the
 * same type, else `false`.
 *
 * NOTE: a naive mutual-assignability check
 * (`[A] extends [B] ? [B] extends [A] ? true : false : false`) is too weak — it
 * resolves `true` when one side gains an *optional* field, because an extra
 * optional property is assignable in both directions. Proven empirically in
 * SMI-5125 step 4: adding `extra?: string` to the mcp-server copy did NOT trip
 * the mutual-assignability form. The identity-function form below distinguishes
 * `{ x?: T }` from `{ x: T }` and from `{}` (the conditional inside the generic
 * function is deferred, so optionality is preserved in the comparison), so an
 * added optional field DOES break it.
 */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// COMPILE-TIME drift guard (evaluated by tsc, erased by esbuild). If the
// mcp-server inline copy and the enterprise canonical contract diverge, the
// `Exact<...>` resolves to `false` and `: true` assignment fails `npm run
// typecheck`. Proven to bite in SMI-5125 step 4 (temporary field → tsc error).
const _handlerMatches: Exact<McpHandler, StripeWebhookHandlerContract> = true
const _resultMatches: Exact<McpResult, EntResult> = true
// Reference both bindings so no-unused-vars stays quiet (the `: true`
// annotations are what carry the assertion, not the runtime value).
void _handlerMatches
void _resultMatches

describe('Stripe webhook contract drift guard (mcp-server ↔ enterprise)', () => {
  it('invokes the canonical handler through the mcp-server contract type', async () => {
    const mockStripe = {
      verifyWebhookSignature: vi.fn(
        () => ({ id: 'evt_drift', type: 'unknown.event' }) as unknown as Stripe.Event
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

    // Bind the concrete enterprise class to the mcp-server consumer's contract
    // type. If the structural copy drifts from the runtime class this binding
    // fails to compile; at runtime it proves `handleWebhook` is callable through
    // the consumer's view of the contract.
    const asMcpHandler: McpHandler = real
    expect(typeof asMcpHandler.handleWebhook).toBe('function')

    const result: McpResult = await asMcpHandler.handleWebhook('payload', 'sig')
    expect(result).toMatchObject({
      success: expect.any(Boolean),
      message: expect.any(String),
      eventId: expect.any(String),
      processed: expect.any(Boolean),
    })
  })
})
