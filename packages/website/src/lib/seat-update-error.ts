/**
 * SMI-5153: parse helpers for the update-seat-count edge function error body.
 *
 * The edge function returns `{ error, details?: { code? } }` (see
 * `_shared/cors.ts` errorResponse — the structured field lands under `details`,
 * not at the top level). Pure + DOM-free so it's unit-testable without a deploy.
 */

export interface SeatUpdateErrorBody {
  error?: string
  details?: { code?: string } | null
}

/**
 * True when the error is the complimentary/admin-granted-plan case (a
 * subscription exists but has no Stripe subscription, so Stripe seat proration
 * can't run). Reads `body.details.code`, NOT `body.code`.
 */
export function isNoStripeSubscription(body: unknown): boolean {
  return (body as SeatUpdateErrorBody | null)?.details?.code === 'no_stripe_subscription'
}

/** The user-facing message from the error body, with a safe fallback. */
export function seatErrorMessage(body: unknown, fallback = 'Failed to update seats'): string {
  const message = (body as SeatUpdateErrorBody | null)?.error
  return typeof message === 'string' && message.length > 0 ? message : fallback
}
