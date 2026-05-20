/**
 * @skillsmith/billing-types
 *
 * Types-only contract shared between `@skillsmith/mcp-server` (public, on
 * npmjs.com) and `@smith-horn/enterprise` (restricted, on npm.pkg.github.com).
 *
 * SMI-5044: introduced to break the previous workspace cycle.
 *
 * - The canonical runtime class lives at `@smith-horn/enterprise/billing`
 *   (`StripeWebhookHandler`). It `implements` the interface below so that
 *   assignability is enforced at the source-of-truth.
 * - The webhook HTTP endpoint at
 *   `@skillsmith/mcp-server/webhooks/stripe-webhook-endpoint` consumes only
 *   this interface — no runtime import of enterprise.
 *
 * No runtime code lives here. Adding runtime code to this package would
 * defeat the cycle-resolution purpose (the public mcp-server pulls this in;
 * it must remain Elastic-2.0 types-only).
 */

/**
 * Result of processing a single Stripe webhook event.
 *
 * Kept as a structural type using `eventId: string` rather than the branded
 * `StripeEventId` from `@smith-horn/enterprise/billing`. A branded string is
 * still structurally a string, so the canonical handler's
 * `Promise<WebhookProcessResult>` remains assignable to
 * `Promise<StripeWebhookResult>` from this package.
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
 * Consumers (e.g. the standalone webhook HTTP endpoint in mcp-server) only
 * need to invoke `handleWebhook(payload, signature)`. The canonical
 * implementation in `@smith-horn/enterprise/billing` does signature
 * verification, idempotency, routing, and license-key callbacks; none of
 * that machinery is exposed here.
 */
export interface StripeWebhookHandler {
  handleWebhook(payload: string, signature: string): Promise<StripeWebhookResult>
}
