/**
 * SMI-5119: Stripe webhook contract (canonical, enterprise-owned).
 *
 * `@smith-horn/enterprise` owns the runtime `StripeWebhookHandler` class, so it
 * also owns the structural contract that class satisfies. The contract is kept
 * in its own module (rather than imported from a separate package) so the
 * canonical class can `implements` it without a cross-package edge, and so the
 * emitted `.d.ts` is self-contained when enterprise is published to GitHub
 * Packages.
 *
 * History: SMI-5044 briefly extracted this into `@skillsmith/billing-types`;
 * that package could not be published (OIDC trusted-publishing requires a
 * pre-existing npm package) and was consumed only via `import type`, so it was
 * removed. The consuming webhook endpoint in `@skillsmith/mcp-server` carries a
 * structurally-identical inline copy. Proper cross-package contract sharing is
 * tracked as a follow-up (invert the `enterprise → @skillsmith/mcp-server/audit`
 * dynamic-import edge).
 */

/**
 * Result of processing a single Stripe webhook event.
 *
 * Uses `eventId: string` rather than the branded `StripeEventId` from
 * `./types.js`. A branded string is still structurally a string, so the
 * canonical handler's `Promise<WebhookProcessResult>` remains assignable to
 * `Promise<StripeWebhookResult>`.
 */
export interface StripeWebhookResult {
  success: boolean
  message: string
  eventId: string
  processed: boolean
  error?: string
}

/**
 * Structural contract for a Stripe webhook handler.
 *
 * Consumers (e.g. the standalone webhook HTTP endpoint in mcp-server) only need
 * to invoke `handleWebhook(payload, signature)`. The canonical implementation
 * does signature verification, idempotency, routing, and license-key callbacks;
 * none of that machinery is part of this contract.
 */
export interface StripeWebhookHandlerContract {
  handleWebhook(payload: string, signature: string): Promise<StripeWebhookResult>
}
